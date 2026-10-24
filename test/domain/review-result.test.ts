import { describe, expect, it } from 'vitest';
import { hasFeishuThreshold, parseReviewResult } from '../../src/domain/review-result.js';

const finding = (severity: string, file = 'src/a.ts') => ({
  severity,
  title: `${severity} issue`,
  description: '说明',
  file,
  line_start: 2,
  line_end: 3,
  code: 'const value = input;',
  recommendation: '增加校验',
});

describe('review result', () => {
  it('parses valid JSON, validates changed files, and sorts high before medium and low', () => {
    const result = parseReviewResult(JSON.stringify({
      summary: '发现问题',
      findings: [finding('low'), finding('high'), finding('medium')],
    }), new Set(['src/a.ts']));

    expect(result.findings.map((item) => item.severity)).toEqual(['high', 'medium', 'low']);
  });

  it('rejects findings outside the changed file set', () => {
    expect(() => parseReviewResult(JSON.stringify({ summary: '', findings: [finding('high', 'src/b.ts')] }), new Set(['src/a.ts'])))
      .toThrow(/changed files/);
  });

  it('notifies Feishu for medium-or-higher findings only', () => {
    const low = parseReviewResult(JSON.stringify({ summary: '', findings: [finding('low')] }), new Set(['src/a.ts']));
    const medium = parseReviewResult(JSON.stringify({ summary: '', findings: [finding('medium')] }), new Set(['src/a.ts']));
    expect(hasFeishuThreshold(low, 'medium')).toBe(false);
    expect(hasFeishuThreshold(medium, 'medium')).toBe(true);
  });
});
