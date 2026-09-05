import type { Severity } from './config.js';
import { renderGitLabNote } from './comment-renderer.js';
import { hasFeishuThreshold, parseReviewResult, type ReviewResult } from './review-result.js';
import type { ReviewJob, ReviewQueue } from './queue.js';
import type { GitLabMergeRequest, GitLabProject } from './gitlab-client.js';
import type { PreparedWorkspace, WorkspaceRequest } from './workspace.js';

export interface ChangeSet { files: Set<string>; diff: string }
export interface GitLabPort {
  getChanges?(projectId: string, mrIid: number): Promise<ChangeSet>;
  getMergeRequest?(projectId: string, mrIid: number): Promise<GitLabMergeRequest>;
  getProject?(projectId: string): Promise<GitLabProject>;
  hasRunNote(projectId: string, mrIid: number, sourceSha: string): Promise<boolean>;
  createNote(projectId: string, mrIid: number, body: string): Promise<{ id: string }>;
}
export interface CodexPort { run(diff: string, cwd?: string): Promise<string> }
export interface WorkspacePort { prepare(request: WorkspaceRequest): Promise<PreparedWorkspace> }
export interface FeishuPort {
  enabled?: boolean;
  sendSummary(summary: { repository: string; mrUrl: string; author: string; high: number; medium: number; low: number }): Promise<void>;
}

export class ReviewOrchestrator {
  constructor(
    private readonly queue: Pick<ReviewQueue, 'markCommenting' | 'markSucceeded' | 'markFailed' | 'markCommentFailed' | 'setFeishuStatus'>,
    private readonly gitlab: GitLabPort,
    private readonly codex: CodexPort,
    private readonly feishu: FeishuPort,
    private readonly feishuMinimum: Severity = 'medium',
    private readonly workspace?: WorkspacePort,
  ) {}

  async execute(job: ReviewJob): Promise<void> {
    let commenting = false;
    try {
      const existingNote = await this.gitlab.hasRunNote(job.projectId, job.mrIid, job.sourceSha);
      if (existingNote && job.feishuStatus !== 'failed') {
        this.queue.markSucceeded(job.id, 'existing');
        this.queue.setFeishuStatus(job.id, 'skipped');
        return;
      }
      let files: Set<string>;
      let reviewInput: string;
      let cwd: string | undefined;
      let mrTitle = `!${job.mrIid}`;
      if (this.workspace) {
        if (!this.gitlab.getMergeRequest || !this.gitlab.getProject) throw new Error('GitLab clone metadata methods are required');
        const mr = await this.gitlab.getMergeRequest(job.projectId, job.mrIid);
        const sourceProject = await this.gitlab.getProject(mr.sourceProjectId);
        const targetProject = mr.targetProjectId === mr.sourceProjectId ? sourceProject : await this.gitlab.getProject(mr.targetProjectId);
        const prepared = await this.workspace.prepare({
          repositoryKey: mr.sourceProjectId,
          cloneUrl: sourceProject.httpUrlToRepo,
          baseCloneUrl: targetProject.httpUrlToRepo,
          headSha: mr.headSha,
          baseSha: mr.baseSha,
        });
        files = prepared.files;
        reviewInput = prepared.reviewInput;
        cwd = prepared.rootPath;
        mrTitle = mr.title;
      } else {
        if (!this.gitlab.getChanges) throw new Error('GitLab changes method is required');
        const changes = await this.gitlab.getChanges(job.projectId, job.mrIid);
        files = changes.files;
        reviewInput = changes.diff;
      }
      const raw = await this.codex.run(reviewInput, cwd);
      const result = parseReviewResult(raw, files);
      if (!existingNote) {
        this.queue.markCommenting(job.id);
        commenting = true;
        const body = renderGitLabNote(result, {
          repository: job.repository,
          mrTitle,
          sourceSha: job.sourceSha,
          mrUrl: job.mrUrl,
        });
        const note = await this.gitlab.createNote(job.projectId, job.mrIid, body);
        this.queue.markSucceeded(job.id, note.id);
        commenting = false;
      } else {
        this.queue.markSucceeded(job.id, job.commentId ?? 'existing');
      }
      await this.notifyFeishu(job, result);
    } catch (error) {
      if (commenting) this.queue.markCommentFailed(job.id, error instanceof Error ? error.message : String(error));
      else this.queue.markFailed(job.id, 'review_failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async notifyFeishu(job: ReviewJob, result: ReviewResult): Promise<void> {
    if (this.feishu.enabled === false || !hasFeishuThreshold(result, this.feishuMinimum)) {
      this.queue.setFeishuStatus(job.id, 'skipped');
      return;
    }
    const counts = {
      high: result.findings.filter((finding) => finding.severity === 'high').length,
      medium: result.findings.filter((finding) => finding.severity === 'medium').length,
      low: result.findings.filter((finding) => finding.severity === 'low').length,
    };
    this.queue.setFeishuStatus(job.id, 'sending');
    try {
      await this.feishu.sendSummary({ repository: job.repository, mrUrl: job.mrUrl, author: job.author, ...counts });
      this.queue.setFeishuStatus(job.id, 'succeeded');
    } catch (error) {
      this.queue.setFeishuStatus(job.id, 'failed', error instanceof Error ? error.message : String(error));
    }
  }
}
