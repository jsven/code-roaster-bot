import type { ReviewJob, ReviewJobInput, ReviewJobPage, ReviewListOptions, WebhookEventInput } from '../domain/review-job.js';

export interface GitLabChanges {
  files: Set<string>;
  diff: string;
}

export interface GitLabMergeRequest {
  title: string;
  webUrl: string;
  headSha: string;
  baseSha: string;
  sourceProjectId: string;
  targetProjectId: string;
  author?: string;
}

export interface GitLabProject {
  id: string;
  pathWithNamespace: string;
  httpUrlToRepo: string;
}

export interface WorkspaceRequest {
  repositoryKey: string;
  cloneUrl: string;
  headSha: string;
  baseSha: string;
  baseCloneUrl?: string;
}

export interface PreparedWorkspace {
  rootPath: string;
  files: Set<string>;
  diff: string;
  reviewInput: string;
  headSha: string;
  baseSha: string;
}

export interface FeishuSummary {
  repository: string;
  mrUrl: string;
  author: string;
  high: number;
  medium: number;
  low: number;
}

export interface GitLabPort {
  getChanges?(projectId: string, mrIid: number): Promise<GitLabChanges>;
  getMergeRequest?(projectId: string, mrIid: number): Promise<GitLabMergeRequest>;
  getProject?(projectId: string): Promise<GitLabProject>;
  hasRunNote(projectId: string, mrIid: number, sourceSha: string): Promise<boolean>;
  createNote(projectId: string, mrIid: number, body: string): Promise<{ id: string }>;
}

export interface CodexPort {
  run(diff: string, cwd?: string): Promise<string>;
}

export interface WorkspacePort {
  prepare(request: WorkspaceRequest): Promise<PreparedWorkspace>;
}

export interface FeishuPort {
  enabled?: boolean;
  sendSummary(summary: FeishuSummary): Promise<void>;
}

export interface ReviewQueuePort {
  enqueue(input: ReviewJobInput): ReviewJob;
  recordWebhook(input: WebhookEventInput): void;
  claimNext(): ReviewJob | undefined;
  get(id: number): ReviewJob | undefined;
  listPage(options?: ReviewListOptions): ReviewJobPage;
  listRepositories(): string[];
  markCommenting(id: number): void;
  markSucceeded(id: number, commentId: string): void;
  markFailed(id: number, errorCode: string, errorMessage?: string): void;
  markCommentFailed(id: number, errorMessage: string): void;
  setFeishuStatus(id: number, status: string, error?: string): void;
  requeue(id: number): void;
  requeueStale(maxAgeMs: number): number;
}
