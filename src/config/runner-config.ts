import path from 'node:path';
import { loadReviewRuntimeConfig, type ReviewRuntimeConfig } from './config.js';
import { projectPath } from './paths.js';

export interface RunnerConfig extends ReviewRuntimeConfig {
  context: {
    projectId: string;
    mrIid: number;
    repository: string;
    projectDirectory: string;
    sourceSha: string;
    baseSha: string;
  };
  retryNotification: boolean;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required in Runner mode`);
  return value;
};

const id = (value: string, name: string): string => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive integer`);
  return value;
};

const sha = (value: string, name: string): string => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) || /^0+$/.test(value)) throw new Error(`${name} must be a full commit SHA`);
  return value;
};

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  if (env.CI_PIPELINE_SOURCE !== 'merge_request_event') throw new Error('Runner mode requires a merge request pipeline');
  const projectId = id(required(env, 'CI_MERGE_REQUEST_PROJECT_ID'), 'CI_MERGE_REQUEST_PROJECT_ID');
  const sourceProjectId = id(required(env, 'CI_MERGE_REQUEST_SOURCE_PROJECT_ID'), 'CI_MERGE_REQUEST_SOURCE_PROJECT_ID');
  if (sourceProjectId !== projectId) throw new Error('Fork MR pipelines are not enabled in Runner mode');
  const eventType = env.CI_MERGE_REQUEST_EVENT_TYPE || 'detached';
  if (!['detached', 'merged_result', 'merge_train'].includes(eventType)) throw new Error('Unsupported MR pipeline event type');
  const sourceVariable = eventType === 'detached' ? 'CI_COMMIT_SHA' : 'CI_MERGE_REQUEST_SOURCE_BRANCH_SHA';
  const runtime = loadReviewRuntimeConfig({
    ...env,
    GITLAB_BASE_URL: env.GITLAB_BASE_URL || env.CI_SERVER_URL,
    CODEX_PROMPT_FILE: env.CODEX_PROMPT_FILE || projectPath('prompts', 'code-review.md'),
  });
  if (!runtime.codex.apiKey) throw new Error('OPENAI_API_KEY is required in Runner mode');
  if (!runtime.codex.model) throw new Error('CODEX_MODEL is required in Runner mode');
  return {
    ...runtime,
    context: {
      projectId,
      mrIid: Number(id(required(env, 'CI_MERGE_REQUEST_IID'), 'CI_MERGE_REQUEST_IID')),
      repository: env.CI_MERGE_REQUEST_PROJECT_PATH?.trim() || required(env, 'CI_PROJECT_PATH'),
      projectDirectory: path.resolve(required(env, 'CI_PROJECT_DIR')),
      sourceSha: sha(required(env, sourceVariable), sourceVariable),
      baseSha: sha(required(env, 'CI_MERGE_REQUEST_DIFF_BASE_SHA'), 'CI_MERGE_REQUEST_DIFF_BASE_SHA'),
    },
    retryNotification: env.REVIEW_RETRY_NOTIFICATION === 'true',
  };
}
