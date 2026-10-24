import type { ReviewJob } from '../../domain/review-job.js';
import { escape, layout } from './layout.js';

export function renderReviewDetail(job: ReviewJob): string {
  const error = job.errorMessage || job.feishuError;
  return layout(`审核任务 #${job.id}`, `<p><a href="/reviews">← 返回任务列表</a></p><h1>审核任务 #${job.id}</h1><dl>
<dt>仓库</dt><dd>${escape(job.repository)}</dd><dt>MR</dt><dd><a href="${escape(job.mrUrl)}" target="_blank" rel="noreferrer">${escape(job.mrUrl)}</a></dd>
<dt>发起人</dt><dd>${escape(job.author)}</dd><dt>Source SHA</dt><dd>${escape(job.sourceSha)}</dd><dt>Target SHA</dt><dd>${escape(job.targetSha)}</dd>
<dt>审核状态</dt><dd class="status">${escape(job.status)}</dd><dt>GitLab 评论</dt><dd>${escape(job.commentStatus)}</dd><dt>飞书通知</dt><dd>${escape(job.feishuStatus)}</dd>
<dt>错误</dt><dd class="error">${escape(error || '无')}</dd><dt>创建时间</dt><dd>${escape(job.createdAt)}</dd></dl>
<form method="post" action="/api/reviews/${job.id}/retry"><button type="submit">重新审核</button></form>
<form method="post" action="/api/reviews/${job.id}/retry-feishu" class="retry-feishu"><button type="submit">重试飞书通知（将重新审核）</button></form>`);
}
