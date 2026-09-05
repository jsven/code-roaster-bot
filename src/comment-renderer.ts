import type { ReviewResult, Finding } from './review-result.js';

export interface ReviewContext {
  repository: string;
  mrTitle: string;
  sourceSha: string;
  mrUrl: string;
}

const labels = { high: '高风险', medium: '中风险', low: '低风险' } as const;

const codeFence = (code: string): string => code.replaceAll('```', '`​``');

const renderFinding = (finding: Finding): string => [
  `#### ${finding.title}`,
  '',
  `**问题说明**：${finding.description}`,
  '',
  `**代码位置**：\`${finding.file}:${finding.lineStart}-${finding.lineEnd}\``,
  '',
  '**代码片段**',
  '',
  '```',
  codeFence(finding.code),
  '```',
  '',
  `**建议整改**：${finding.recommendation}`,
].join('\n');

export function renderGitLabNote(result: ReviewResult, context: ReviewContext): string {
  const counts = {
    high: result.findings.filter((finding) => finding.severity === 'high').length,
    medium: result.findings.filter((finding) => finding.severity === 'medium').length,
    low: result.findings.filter((finding) => finding.severity === 'low').length,
  };
  const sections = (['high', 'medium', 'low'] as const)
    .map((severity) => {
      const findings = result.findings.filter((finding) => finding.severity === severity);
      return findings.length ? [`### ${labels[severity]}（${findings.length}）`, '', ...findings.map(renderFinding)].join('\n') : '';
    })
    .filter(Boolean)
    .join('\n\n');

  return [
    '> 【赛博老王 · 状态声明】这是 AI 娱乐化评审，可能存在误判；我们尊重历史代码中的现实妥协。以下内容只讨论代码，不针对开发者本人，请保持平和心态。',
    '',
    `<!-- codereview:run:${context.sourceSha} -->`,
    '## 自动代码审核结果',
    '',
    `仓库：\`${context.repository}\``,
    `MR：**${context.mrTitle}**`,
    `提交：\`${context.sourceSha}\``,
    `风险统计：高 ${counts.high} · 中 ${counts.medium} · 低 ${counts.low}`,
    `详情：${context.mrUrl}`,
    '',
    result.summary ? `> ${result.summary}` : '',
    '',
    sections || '未发现需要反馈的问题。',
  ].filter((line) => line !== '').join('\n');
}
