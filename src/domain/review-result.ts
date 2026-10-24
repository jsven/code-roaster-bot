export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  severity: Severity;
  title: string;
  description: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  code: string;
  recommendation: string;
  category: string;
  confidence: number;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
};

const line = (value: unknown, field: string): number => {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
};

export function parseReviewResult(raw: string, changedFiles: Set<string>): ReviewResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Codex output is not valid JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('Codex output must be an object');
  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === 'string' ? record.summary : '';
  if (!Array.isArray(record.findings)) throw new Error('Codex output findings must be an array');

  const findings = record.findings.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`finding ${index} must be an object`);
    const finding = item as Record<string, unknown>;
    const severity = finding.severity;
    if (severity !== 'high' && severity !== 'medium' && severity !== 'low') {
      throw new Error(`finding ${index} severity must be high, medium, or low`);
    }
    const file = text(finding.file, `finding ${index} file`);
    if (!changedFiles.has(file)) throw new Error(`finding ${index} file is not in changed files`);
    const lineStart = line(finding.line_start, `finding ${index} line_start`);
    const lineEnd = line(finding.line_end, `finding ${index} line_end`);
    if (lineEnd < lineStart) throw new Error(`finding ${index} line_end must be >= line_start`);
    const confidence = finding.confidence === undefined ? 0.5 : Number(finding.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`finding ${index} confidence must be between 0 and 1`);
    return {
      severity,
      title: text(finding.title, `finding ${index} title`),
      description: text(finding.description, `finding ${index} description`),
      file,
      lineStart,
      lineEnd,
      code: text(finding.code, `finding ${index} code`),
      recommendation: text(finding.recommendation, `finding ${index} recommendation`),
      category: typeof finding.category === 'string' && finding.category.trim() ? finding.category.trim() : 'other',
      confidence,
    } satisfies Finding;
  }).sort((left, right) => order[left.severity] - order[right.severity] || left.file.localeCompare(right.file) || left.lineStart - right.lineStart);

  return { summary, findings };
}

export function hasFeishuThreshold(result: ReviewResult, minimum: Severity): boolean {
  return result.findings.some((finding) => order[finding.severity] <= order[minimum]);
}
