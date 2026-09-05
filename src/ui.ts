import type { ReviewJob } from './queue.js';

const escape = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const layout = (title: string, body: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:2rem;max-width:1100px;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.55rem;text-align:left}a{color:#0969da}.status{font-weight:600}.error{color:#b42318}button{padding:.35rem .7rem}</style></head><body>${body}</body></html>`;

export function renderReviewsPage(jobs: ReviewJob[]): string {
  const rows = jobs.map((job) => `<tr><td><a href="/reviews/${job.id}">#${job.id}</a></td><td>${escape(job.repository)}</td><td><a href="${escape(job.mrUrl)}" target="_blank" rel="noreferrer">MR !${job.mrIid}</a></td><td>${escape(job.author)}</td><td class="status">${escape(job.status)}</td><td>${escape(job.commentStatus)}</td><td>${escape(job.feishuStatus)}</td><td>${escape(job.createdAt)}</td></tr>`).join('');
  return layout('代码审核任务', `<h1>代码审核任务</h1><table><thead><tr><th>ID</th><th>仓库</th><th>MR</th><th>发起人</th><th>审核状态</th><th>GitLab 评论</th><th>飞书通知</th><th>创建时间</th></tr></thead><tbody>${rows || '<tr><td colspan="8">暂无任务</td></tr>'}</tbody></table>`);
}

export function renderReviewDetail(job: ReviewJob): string {
  const error = job.errorMessage || job.feishuError;
  return layout(`审核任务 #${job.id}`, `<p><a href="/reviews">← 返回任务列表</a></p><h1>审核任务 #${job.id}</h1><dl>
<dt>仓库</dt><dd>${escape(job.repository)}</dd><dt>MR</dt><dd><a href="${escape(job.mrUrl)}" target="_blank" rel="noreferrer">${escape(job.mrUrl)}</a></dd>
<dt>发起人</dt><dd>${escape(job.author)}</dd><dt>Source SHA</dt><dd>${escape(job.sourceSha)}</dd><dt>Target SHA</dt><dd>${escape(job.targetSha)}</dd>
<dt>审核状态</dt><dd class="status">${escape(job.status)}</dd><dt>GitLab 评论</dt><dd>${escape(job.commentStatus)}</dd><dt>飞书通知</dt><dd>${escape(job.feishuStatus)}</dd>
<dt>错误</dt><dd class="error">${escape(error || '无')}</dd><dt>创建时间</dt><dd>${escape(job.createdAt)}</dd></dl>
<form method="post" action="/api/reviews/${job.id}/retry"><button type="submit">重新审核</button></form>
<form method="post" action="/api/reviews/${job.id}/retry-feishu" style="margin-top:.5rem"><button type="submit">重试飞书通知（将重新审核）</button></form>`);
}
