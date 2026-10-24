import { describe, expect, it } from 'vitest';
import { parseReviewResult } from '../../src/domain/review-result.js';
import { renderGitLabNote } from '../../src/application/review-note.js';

describe('renderGitLabNote', () => {
  it('renders one note with high, medium, low sections and required details', () => {
    const result = parseReviewResult(JSON.stringify({
      summary: '需要处理',
      findings: [
        {
          severity: 'low', title: '低问题', description: '低说明', file: 'a.ts', line_start: 1, line_end: 1,
          code: 'const a = 1;', recommendation: '修改低问题',
        },
        {
          severity: 'high', title: '高问题', description: '高说明', file: 'b.ts', line_start: 2, line_end: 4,
          code: 'run(input);', recommendation: '修复高问题',
        },
      ],
    }), new Set(['a.ts', 'b.ts']));

    const note = renderGitLabNote(result, { repository: 'group/demo', mrTitle: '新增功能', sourceSha: 'abc123', mrUrl: 'https://gitlab/mr/1' });
    expect(note.indexOf('赛博老王 · 状态声明')).toBeLessThan(note.indexOf('自动代码审核结果'));
    expect(note).toContain('AI 娱乐化评审');
    expect(note.indexOf('高风险')).toBeLessThan(note.indexOf('低风险'));
    expect(note).toContain('高说明');
    expect(note).toContain('```');
    expect(note).toContain('<!-- codereview:run:abc123 -->');
  });
});
