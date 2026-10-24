import type { ReviewJob } from '../domain/review-job.js';
import type { GitLabPort } from './ports.js';

export async function notifyReviewReceived(gitlab: Pick<GitLabPort, 'createNote'>, job: ReviewJob): Promise<void> {
  await gitlab.createNote(job.projectId, job.mrIid, '🤖⏳ 赛博老王 正在细品你的优雅代码');
}
