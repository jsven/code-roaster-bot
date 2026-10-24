export type ReviewJobStatus = 'queued' | 'running' | 'commenting' | 'succeeded' | 'failed' | 'cancelled';

export interface ReviewJobInput {
  repository: string;
  projectId: string;
  mrIid: number;
  mrUrl: string;
  author: string;
  sourceSha: string;
  targetSha: string;
}

export interface ReviewJob extends ReviewJobInput {
  id: number;
  status: ReviewJobStatus;
  attempt: number;
  errorCode?: string;
  errorMessage?: string;
  commentStatus: string;
  commentId?: string;
  feishuStatus: string;
  feishuError?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface ReviewListOptions {
  page?: number;
  pageSize?: number;
  repository?: string;
  createdFrom?: string;
  createdBefore?: string;
}

export interface ReviewJobPage {
  items: ReviewJob[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface WebhookEventInput {
  provider: string;
  eventId?: string;
  eventType: string;
  projectId: string;
  mrIid: number;
  payloadHash: string;
}

