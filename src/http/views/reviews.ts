import type { ReviewJobPage } from '../../domain/review-job.js';
import type { ReviewListQuery } from '../schemas/review-list.js';
import { escape, layout } from './layout.js';

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function renderReviewsPage(result: ReviewJobPage, repositories: string[], filters: ReviewListQuery): string {
  const { items, total, page, pageSize, totalPages } = result;
  const rows = items.map((job) => `<tr><td><a href="/reviews/${job.id}">#${job.id}</a></td><td>${escape(job.repository)}</td><td><a href="${escape(job.mrUrl)}" target="_blank" rel="noreferrer">MR !${job.mrIid}</a></td><td>${escape(job.author)}</td><td class="status">${escape(job.status)}</td><td>${escape(job.commentStatus)}</td><td>${escape(job.feishuStatus)}</td><td><time datetime="${escape(job.createdAt)}">${escape(dateTime.format(new Date(job.createdAt)))}</time></td></tr>`).join('');
  const choices = [...repositories];
  if (filters.repository && !choices.includes(filters.repository)) choices.push(filters.repository);
  const repositoryOptions = choices.map((repository) => `<option value="${escape(repository)}"${repository === filters.repository ? ' selected' : ''}>${escape(repository)}</option>`).join('');
  const sizes = [...new Set([20, 50, 100, pageSize])].sort((a, b) => a - b);
  const sizeOptions = sizes.map((size) => `<option value="${size}"${size === pageSize ? ' selected' : ''}>${size} 条</option>`).join('');
  const pageUrl = (number: number): string => {
    const query = new URLSearchParams({ page: String(number), pageSize: String(pageSize) });
    if (filters.repository) query.set('repository', filters.repository);
    if (filters.startDate) query.set('startDate', filters.startDate);
    if (filters.endDate) query.set('endDate', filters.endDate);
    return escape(`/reviews?${query}`);
  };
  const pageNumbers = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, totalPages])]
    .filter((number) => number >= 1 && number <= totalPages).sort((a, b) => a - b);
  const pageLinks = pageNumbers.map((number, index) => {
    const gap = index > 0 && number - pageNumbers[index - 1]! > 1 ? '<span aria-hidden="true">…</span>' : '';
    return gap + (number === page
      ? `<span aria-current="page" aria-label="第 ${number} 页">${number}</span>`
      : `<a href="${pageUrl(number)}" aria-label="第 ${number} 页">${number}</a>`);
  }).join('');
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return layout('代码审核任务', `<h1>代码审核任务</h1>
<form class="filters" method="get" action="/reviews">
<label class="repository-filter">仓库<select name="repository"><option value="">全部仓库</option>${repositoryOptions}</select></label>
<label>创建日期 · 从<input type="date" name="startDate" value="${escape(filters.startDate)}"></label>
<label>至（含当天）<input type="date" name="endDate" value="${escape(filters.endDate)}"></label>
<label>每页显示<select name="pageSize">${sizeOptions}</select></label>
<div class="filter-actions"><button type="submit">筛选</button><a href="/reviews">重置</a></div>
</form>
<p class="summary">共 ${total} 条，显示第 ${first}–${last} 条 · 创建时间及日期筛选均使用北京时间（UTC+8）</p>
<div class="table-scroll"><table><thead><tr><th>ID</th><th>仓库</th><th>MR</th><th>发起人</th><th>审核状态</th><th>GitLab 评论</th><th>飞书通知</th><th>创建时间</th></tr></thead><tbody>${rows || '<tr><td class="empty" colspan="8">暂无符合条件的任务</td></tr>'}</tbody></table></div>
<nav class="pagination" aria-label="分页">${page > 1 ? `<a href="${pageUrl(page - 1)}" rel="prev">上一页</a>` : '<span class="disabled" aria-disabled="true">上一页</span>'}${pageLinks}${page < totalPages ? `<a href="${pageUrl(page + 1)}" rel="next">下一页</a>` : '<span class="disabled" aria-disabled="true">下一页</span>'}<span class="page-info">第 ${page} / ${totalPages} 页</span></nav>`);
}
