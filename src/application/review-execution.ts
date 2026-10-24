import type { ReviewJobInput } from '../domain/review-job.js';
import { hasFeishuThreshold, parseReviewResult, type Severity } from '../domain/review-result.js';
import type { CodexPort, FeishuPort, GitLabPort } from './ports.js';
import { renderGitLabNote } from './review-note.js';

export interface ReviewSource {
  title: string;
  files: Set<string>;
  reviewInput: string;
  cwd?: string;
}

export interface ReviewExecutionOptions {
  retryNotification?: boolean;
  existingCommentId?: string;
  onCommenting?: () => void;
  onCommented?: (commentId: string) => void;
  onNotification?: (status: 'skipped' | 'sending' | 'succeeded' | 'failed', error?: string) => void;
}

export interface ReviewExecutionResult {
  status: 'succeeded' | 'skipped';
  commentId: string;
  notificationStatus: 'skipped' | 'succeeded' | 'failed';
  notificationError?: string;
}

// Shared, stateless workflow. Persistence and scheduling belong to the caller.
export class ReviewExecution {
  constructor(
    private readonly gitlab: GitLabPort,
    private readonly codex: CodexPort,
    private readonly feishu: FeishuPort,
    private readonly minimum: Severity = 'medium',
  ) {}

  async execute(
    job: ReviewJobInput,
    prepare: () => Promise<ReviewSource>,
    options: ReviewExecutionOptions = {},
  ): Promise<ReviewExecutionResult> {
    const existingNote = await this.gitlab.hasRunNote(job.projectId, job.mrIid, job.sourceSha);
    if (existingNote && !options.retryNotification) {
      options.onCommented?.('existing');
      options.onNotification?.('skipped');
      return { status: 'skipped', commentId: 'existing', notificationStatus: 'skipped' };
    }

    const source = await prepare();
    const result = parseReviewResult(await this.codex.run(source.reviewInput, source.cwd), source.files);
    let commentId = options.existingCommentId ?? 'existing';
    if (!existingNote) {
      options.onCommenting?.();
      const body = renderGitLabNote(result, {
        repository: job.repository, mrTitle: source.title, sourceSha: job.sourceSha, mrUrl: job.mrUrl,
      });
      commentId = (await this.gitlab.createNote(job.projectId, job.mrIid, body)).id;
    }
    options.onCommented?.(commentId);

    if (this.feishu.enabled === false || !hasFeishuThreshold(result, this.minimum)) {
      options.onNotification?.('skipped');
      return { status: 'succeeded', commentId, notificationStatus: 'skipped' };
    }
    options.onNotification?.('sending');
    try {
      await this.feishu.sendSummary({
        repository: job.repository, mrUrl: job.mrUrl, author: job.author,
        high: result.findings.filter((finding) => finding.severity === 'high').length,
        medium: result.findings.filter((finding) => finding.severity === 'medium').length,
        low: result.findings.filter((finding) => finding.severity === 'low').length,
      });
      options.onNotification?.('succeeded');
      return { status: 'succeeded', commentId, notificationStatus: 'succeeded' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onNotification?.('failed', message);
      return { status: 'succeeded', commentId, notificationStatus: 'failed', notificationError: message };
    }
  }
}
