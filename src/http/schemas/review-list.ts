import type { ReviewListOptions } from '../../domain/review-job.js';

export interface ReviewListQuery {
  page?: number;
  pageSize?: number;
  repository?: string;
  startDate?: string;
  endDate?: string;
}

export const reviewListQuerySchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    pageSize: { type: 'integer', minimum: 1, maximum: 100 },
    repository: { type: 'string' },
    startDate: { type: 'string' },
    endDate: { type: 'string' },
  },
} as const;

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};

const dayStart = (value: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    return invalid('日期格式必须为 YYYY-MM-DD');
  }
  const utc = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== value) {
    return invalid('日期无效');
  }
  // Date filters use calendar days in Asia/Shanghai (UTC+08:00).
  return utc.getTime() - 8 * 60 * 60 * 1000;
};

export function reviewListOptions(query: ReviewListQuery): ReviewListOptions {
  const from = query.startDate ? dayStart(query.startDate) : undefined;
  const end = query.endDate ? dayStart(query.endDate) : undefined;
  if (from !== undefined && end !== undefined && from > end) {
    return invalid('开始日期不能晚于结束日期');
  }
  return {
    page: query.page,
    pageSize: query.pageSize,
    repository: query.repository,
    createdFrom: from === undefined ? undefined : new Date(from).toISOString(),
    createdBefore: end === undefined ? undefined : new Date(end + 24 * 60 * 60 * 1000).toISOString(),
  };
}
