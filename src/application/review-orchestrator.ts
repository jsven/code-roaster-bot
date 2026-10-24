import type { Severity } from '../domain/review-result.js';
import type { ReviewJob } from '../domain/review-job.js';
import type { CodexPort, FeishuPort, GitLabPort, ReviewQueuePort, WorkspacePort } from './ports.js';
import { ReviewExecution } from './review-execution.js';

export class ReviewOrchestrator {
  constructor(
    private readonly queue: Pick<ReviewQueuePort, 'markCommenting' | 'markSucceeded' | 'markFailed' | 'markCommentFailed' | 'setFeishuStatus'>,
    private readonly gitlab: GitLabPort,
    private readonly codex: CodexPort,
    private readonly feishu: FeishuPort,
    private readonly feishuMinimum: Severity = 'medium',
    private readonly workspace?: WorkspacePort,
  ) {}

  async execute(job: ReviewJob): Promise<void> {
    let commenting = false;
    const execution = new ReviewExecution(this.gitlab, this.codex, this.feishu, this.feishuMinimum);
    try {
      await execution.execute(job, async () => {
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
        return { title: mrTitle, files, reviewInput, cwd };
      }, {
        retryNotification: job.feishuStatus === 'failed',
        existingCommentId: job.commentId,
        onCommenting: () => {
          this.queue.markCommenting(job.id);
          commenting = true;
        },
        onCommented: (commentId) => {
          this.queue.markSucceeded(job.id, commentId);
          commenting = false;
        },
        onNotification: (status, error) => this.queue.setFeishuStatus(job.id, status, error),
      });
    } catch (error) {
      if (commenting) this.queue.markCommentFailed(job.id, error instanceof Error ? error.message : String(error));
      else this.queue.markFailed(job.id, 'review_failed', error instanceof Error ? error.message : String(error));
    }
  }
}
