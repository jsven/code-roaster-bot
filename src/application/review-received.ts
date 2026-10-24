import type { ReviewJobInput } from '../domain/review-job.js';
import type { GitLabPort } from './ports.js';

export async function notifyReviewReceived(gitlab: Pick<GitLabPort, 'createNote'>, job: Pick<ReviewJobInput, 'projectId' | 'mrIid'>): Promise<void> {
  await gitlab.createNote(job.projectId, job.mrIid, '🤖⏳ 赛博老王 正在细品你的优雅代码');
}
