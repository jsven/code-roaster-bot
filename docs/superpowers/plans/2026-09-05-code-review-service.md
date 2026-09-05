# GitLab Code Review Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a simple Node.js service that receives GitLab Merge Request creation webhooks, queues durable review jobs in SQLite, runs local `codex-cli`, posts one high/medium/low ordered summary note to GitLab, optionally notifies a Feishu group for medium-or-higher findings, and exposes a status UI.

**Architecture:** One Fastify process serves the webhook/API/UI and polls a SQLite-backed queue with one worker. Provider clients isolate GitLab and Feishu HTTP calls; the orchestrator owns the review state machine and never stores finding content in SQLite.

**Tech Stack:** Node.js 20+, TypeScript, Fastify, `better-sqlite3`, Vitest, native `fetch`, child-process `spawn`, EJS-free server-rendered HTML.

**Spec:** `docs/code-review-service-design.md`

## Global Constraints

- Accept only GitLab `merge_request` events with `object_attributes.action=open`.
- Store repository, MR URL, author, SHAs, status, errors, comment status, and Feishu status; never store finding body, code snippet, recommendation, raw Codex output, or raw webhook payload.
- Use an internal SQLite queue; no Redis or RabbitMQ.
- Review and comment only; never approve, block, or decide whether the MR may merge.
- Post one GitLab MR Note ordered high, medium, low.
- Notify Feishu only when at least one high or medium finding exists; low-only and empty results do not notify.
- Keep the prompt at `prompts/code-review.md` and make its path configurable.

---

### Task 1: Project bootstrap and configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `src/config.ts`
- Create: `test/config.test.ts`
- Create: `prompts/code-review.md`

**Interfaces:**
- `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
- `AppConfig` exposes server, GitLab, Codex, Feishu, database, and workspace settings.

- [ ] **Step 1: Write the failing configuration tests**

```ts
it('loads GitLab and Feishu settings and defaults the Feishu threshold to medium', () => {
  const config = loadConfig({
    GITLAB_TOKEN: 'token',
    GITLAB_WEBHOOK_SECRET: 'secret',
    FEISHU_ENABLED: 'true',
    FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/hook',
  });
  expect(config.gitlab.token).toBe('token');
  expect(config.feishu.enabled).toBe(true);
  expect(config.feishu.minSeverity).toBe('medium');
});
```

- [ ] **Step 2: Run `npm test -- test/config.test.ts` and verify it fails because the project files do not exist.**
- [ ] **Step 3: Add the package scripts and minimal configuration loader.**
- [ ] **Step 4: Run the focused test and `npm run typecheck`; verify both pass.**

### Task 2: SQLite schema and durable internal queue

**Files:**
- Create: `src/db.ts`
- Create: `src/queue.ts`
- Create: `test/queue.test.ts`

**Interfaces:**
- `Database` initializes tables and exposes `close()`.
- `ReviewQueue.enqueue(input): ReviewJob`
- `ReviewQueue.claimNext(): ReviewJob | undefined`
- `ReviewQueue.markRunning/markCommenting/markSucceeded/markFailed/requeueStale`
- `ReviewQueue.list()` and `ReviewQueue.get(id)` return metadata only.

- [ ] **Step 1: Write tests for enqueue/claim, duplicate idempotency, retry, stale recovery, and metadata-only persistence.**
- [ ] **Step 2: Run `npm test -- test/queue.test.ts`; confirm the tests fail for missing queue behavior.**
- [ ] **Step 3: Implement SQLite tables `webhook_events`, `review_jobs`, and `review_comments` with `better-sqlite3`; do not add a findings content table.**
- [ ] **Step 4: Implement atomic single-worker claiming with a transaction and a unique `(project_id, mr_iid, source_sha)` key.**
- [ ] **Step 5: Run the focused tests and typecheck; verify they pass.**

### Task 3: Review result parsing and GitLab comment rendering

**Files:**
- Create: `src/review-result.ts`
- Create: `src/comment-renderer.ts`
- Create: `test/review-result.test.ts`
- Create: `test/comment-renderer.test.ts`

**Interfaces:**
- `parseReviewResult(raw: string, changedFiles: Set<string>): ReviewResult`
- `renderGitLabNote(result: ReviewResult, context: ReviewContext): string`
- `hasFeishuThreshold(result, minSeverity): boolean`

- [ ] **Step 1: Write failing tests for strict JSON parsing, required fields, changed-file validation, high/medium/low ordering, and threshold behavior.**
- [ ] **Step 2: Run the focused tests and confirm expected failures.**
- [ ] **Step 3: Implement schema validation and normalization without persisting the result.**
- [ ] **Step 4: Implement one Markdown Note with the `<!-- codereview:run:<source_sha> -->` marker and full finding details.**
- [ ] **Step 5: Run focused tests and typecheck.**

### Task 4: GitLab, Codex, and Feishu adapters

**Files:**
- Create: `src/gitlab-client.ts`
- Create: `src/codex-runner.ts`
- Create: `src/feishu-client.ts`
- Create: `test/gitlab-client.test.ts`
- Create: `test/feishu-client.test.ts`
- Create: `test/codex-runner.test.ts`

**Interfaces:**
- `GitLabClient.getMergeRequest(projectId, mrIid)`
- `GitLabClient.createNote(projectId, mrIid, body)`
- `GitLabClient.hasRunNote(projectId, mrIid, sourceSha)`
- `CodexRunner.run(input): Promise<string>`
- `FeishuClient.sendSummary(summary): Promise<void>`

- [ ] **Step 1: Write failing adapter tests for GitLab URL encoding, token headers, Note payload, Feishu low-only suppression, Feishu signature mode, and Codex timeout/non-zero exit.**
- [ ] **Step 2: Run focused adapter tests and verify they fail.**
- [ ] **Step 3: Implement native `fetch` GitLab calls against `/api/v4/projects/:id/merge_requests/:iid/notes`.**
- [ ] **Step 4: Implement `spawn`-based Codex invocation with prompt file, diff input, timeout, and bounded output.**
- [ ] **Step 5: Implement Feishu custom-bot webhook POST with optional signing secret and summary-only payload.**
- [ ] **Step 6: Run focused adapter tests and typecheck.**

### Task 5: Review orchestrator and worker

**Files:**
- Create: `src/orchestrator.ts`
- Create: `src/worker.ts`
- Create: `test/orchestrator.test.ts`

**Interfaces:**
- `ReviewOrchestrator.execute(job): Promise<void>`
- `ReviewWorker.start()` and `ReviewWorker.stop()`

- [ ] **Step 1: Write failing orchestration tests for GitLab Note success, GitLab failure, Feishu non-blocking failure, and no notification for low-only results.**
- [ ] **Step 2: Run the focused tests and verify they fail.**
- [ ] **Step 3: Implement the state transitions `queued -> running -> commenting -> succeeded/failed`; keep Feishu status independent.**
- [ ] **Step 4: Implement temporary workspace cleanup and `requeueStale()` on worker startup.**
- [ ] **Step 5: Run focused orchestration tests and typecheck.**

### Task 6: Fastify webhook, status API, and UI

**Files:**
- Create: `src/app.ts`
- Create: `src/server.ts`
- Create: `src/ui.ts`
- Create: `test/app.test.ts`

**Interfaces:**
- `buildApp(deps): FastifyInstance`
- `POST /webhooks/gitlab`
- `GET /api/reviews`, `GET /api/reviews/:id`, `POST /api/reviews/:id/retry`, `POST /api/reviews/:id/retry-feishu`
- `GET /reviews`, `GET /reviews/:id`, `GET /health`, `GET /ready`

- [ ] **Step 1: Write failing Fastify injection tests for secret validation, `open` event acceptance, non-open event ignore, idempotency, and retry endpoints.**
- [ ] **Step 2: Run the focused tests and confirm failures.**
- [ ] **Step 3: Implement webhook parsing without storing raw payload and return `202` after queue insertion.**
- [ ] **Step 4: Implement metadata-only JSON endpoints and server-rendered HTML list/detail pages.**
- [ ] **Step 5: Run focused app tests and typecheck.**

### Task 7: Integration verification and operational docs

**Files:**
- Create: `README.md`
- Create: `Dockerfile`
- Create: `.gitignore`
- Create: `test/integration.test.ts`

- [ ] **Step 1: Write an integration test using fake GitLab, Codex, and Feishu adapters to prove the full queue-to-comment flow and metadata-only SQLite state.**
- [ ] **Step 2: Run the integration test and confirm it fails before wiring is complete.**
- [ ] **Step 3: Wire `src/server.ts`, environment loading, prompt path, data/workspace directories, and graceful shutdown.**
- [ ] **Step 4: Add README instructions for GitLab webhook setup, Feishu custom bot setup, `codex-cli` availability, and local startup.**
- [ ] **Step 5: Run `npm test`, `npm run typecheck`, and `npm run build`; inspect the generated files and confirm no secrets are tracked.**

## Verification Checklist

- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] Webhook accepts only MR `open` events and is idempotent.
- [ ] SQLite stores no finding body, code snippet, recommendation, raw Codex output, or raw webhook payload.
- [ ] GitLab receives one ordered summary Note.
- [ ] Feishu notification happens only for high/medium findings and does not change GitLab review success.
- [ ] UI exposes metadata and retry actions.
