import path from 'node:path';
import type { Severity } from '../domain/review-result.js';

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ReviewRuntimeConfig {
  gitlab: { baseUrl: string; token: string };
  codex: {
    command: string;
    args: string[];
    model?: string;
    apiKey?: string;
    apiBaseUrl?: string;
    reasoningEffort: CodexReasoningEffort;
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    profile?: string;
    ephemeral: boolean;
    outputSchema?: string;
    promptFile: string;
    timeoutMs: number;
    maxOutputBytes: number;
  };
  feishu: {
    enabled: boolean;
    webhookUrl?: string;
    secret?: string;
    minSeverity: Severity;
    timeoutMs: number;
  };
}

export interface AppConfig extends ReviewRuntimeConfig {
  server: { host: string; port: number };
  databasePath: string;
  workspaceRoot: string;
  gitlab: ReviewRuntimeConfig['gitlab'] & { webhookSecret: string };
}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const integer = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
};

const bool = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const severity = (value: string | undefined): Severity => {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  if (value === undefined || value === '') return 'medium';
  throw new Error('FEISHU_MIN_SEVERITY must be high, medium, or low');
};

const sandbox = (value: string | undefined): CodexSandbox => {
  if (value === undefined || value === '') return 'read-only';
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
  throw new Error('CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access');
};

const approvalPolicy = (value: string | undefined): CodexApprovalPolicy => {
  if (value === undefined || value === '') return 'never';
  if (value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never') return value;
  throw new Error('CODEX_APPROVAL_POLICY must be untrusted, on-failure, on-request, or never');
};

const reasoningEffort = (value: string | undefined): CodexReasoningEffort => {
  const aliases: Record<string, CodexReasoningEffort> = {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
    '低': 'low', '中': 'medium', '高': 'high', '极高': 'xhigh',
  };
  if (value === undefined || value === '') return 'medium';
  const result = aliases[value.toLowerCase()] ?? aliases[value];
  if (result) return result;
  throw new Error('CODEX_REASONING_EFFORT must be low, medium, high, or xhigh');
};

export function loadReviewRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ReviewRuntimeConfig {
  const feishuEnabled = bool(env.FEISHU_ENABLED);
  const args = (env.CODEX_ARGS ?? 'exec').split(/\s+/).filter(Boolean);
  const feishuUrl = env.FEISHU_WEBHOOK_URL?.trim() || undefined;
  if (feishuEnabled && !feishuUrl) throw new Error('FEISHU_WEBHOOK_URL is required when FEISHU_ENABLED=true');
  const apiKey = env.OPENAI_API_KEY?.trim() || undefined;
  const apiBaseUrl = env.OPENAI_BASE_URL?.trim().replace(/\/+$/, '') || undefined;
  if (apiBaseUrl && !apiKey) throw new Error('OPENAI_API_KEY is required when OPENAI_BASE_URL is set');
  if (apiBaseUrl) {
    let url: URL;
    try { url = new URL(apiBaseUrl); } catch { throw new Error('OPENAI_BASE_URL must be an HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('OPENAI_BASE_URL must be an HTTP(S) base URL without credentials, query, or fragment');
    }
  }

  return {
    gitlab: {
      baseUrl: (env.GITLAB_BASE_URL?.trim() || 'https://gitlab.com').replace(/\/$/, ''),
      token: required(env, 'GITLAB_TOKEN'),
    },
    codex: {
      command: env.CODEX_COMMAND?.trim() || 'codex',
      args,
      model: env.CODEX_MODEL?.trim() || undefined,
      apiKey,
      apiBaseUrl,
      reasoningEffort: reasoningEffort(env.CODEX_REASONING_EFFORT?.trim()),
      sandbox: sandbox(env.CODEX_SANDBOX),
      approvalPolicy: approvalPolicy(env.CODEX_APPROVAL_POLICY),
      profile: env.CODEX_PROFILE?.trim() || undefined,
      ephemeral: bool(env.CODEX_EPHEMERAL, true),
      outputSchema: env.CODEX_OUTPUT_SCHEMA?.trim() ? path.resolve(env.CODEX_OUTPUT_SCHEMA.trim()) : undefined,
      promptFile: path.resolve(env.CODEX_PROMPT_FILE?.trim() || './prompts/code-review.md'),
      timeoutMs: integer(env, 'CODEX_TIMEOUT_MS', 900_000),
      maxOutputBytes: integer(env, 'CODEX_MAX_OUTPUT_BYTES', 2_000_000),
    },
    feishu: {
      enabled: feishuEnabled,
      webhookUrl: feishuUrl,
      secret: env.FEISHU_SECRET?.trim() || undefined,
      minSeverity: severity(env.FEISHU_MIN_SEVERITY),
      timeoutMs: integer(env, 'FEISHU_TIMEOUT_MS', 10_000),
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const runtime = loadReviewRuntimeConfig(env);
  return {
    ...runtime,
    server: {
      host: env.HOST?.trim() || '0.0.0.0',
      port: integer(env, 'PORT', 3000),
    },
    databasePath: path.resolve(env.DATABASE_PATH?.trim() || './data/reviews.db'),
    workspaceRoot: path.resolve(env.WORKSPACE_ROOT?.trim() || './data/workspaces'),
    gitlab: { ...runtime.gitlab, webhookSecret: required(env, 'GITLAB_WEBHOOK_SECRET') },
  };
}
