import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Offline end-to-end smoke test of the same module layout shipped in the runner image.
// The packaged CLI must work with no node_modules, SQL scripts, HTTP server, or queue.
const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-image-smoke-'));
const image = path.join(temporary, 'image');
const checkout = path.join(temporary, 'checkout');
const notes = [];
let notifications = 0;
let malformedOutput = false;
let failNotification = false;
const git = async (...args) => (await exec('git', args, { cwd: checkout })).stdout.trim();
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET' && request.url === '/api/v4/projects/42/merge_requests/7') {
    response.end(JSON.stringify({
      title: 'Feature', web_url: 'https://gitlab.example.com/group/repo/-/merge_requests/7',
      author: { username: 'original-author' }, source_project_id: 42, target_project_id: 42,
      diff_refs: { head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) },
    }));
  } else if (request.method === 'GET' && request.url?.startsWith('/api/v4/projects/42/merge_requests/7/notes')) {
    response.end('[]');
  } else if (request.method === 'POST' && request.url === '/api/v4/projects/42/merge_requests/7/notes') {
    assert.equal(request.headers['private-token'], 'smoke-gitlab-secret');
    notes.push(JSON.parse(body).body);
    response.statusCode = 201;
    response.end(JSON.stringify({ id: notes.length }));
  } else if (request.url === '/feishu') {
    notifications++;
    const payload = JSON.parse(body);
    assert.match(payload.content.text, /original-author/);
    response.end(failNotification ? '{"code":1,"msg":"fixture notification failure"}' : '{"code":0}');
  } else {
    response.statusCode = 404;
    response.end('{}');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  await fs.mkdir(image, { recursive: true });
  await fs.mkdir(checkout);
  // Keep this list in step with the runner target COPY directives in Dockerfile.
  const paths = [
    'package.json', 'prompts', 'dist/cli/review.js', 'dist/bootstrap/runner.js', 'dist/config', 'dist/domain',
    'dist/application/ports.js', 'dist/application/review-execution.js', 'dist/application/review-note.js',
    'dist/application/review-received.js', 'dist/infrastructure/codex', 'dist/infrastructure/gitlab',
    'dist/infrastructure/feishu', 'dist/infrastructure/git/runner-workspace.js',
  ];
  for (const relative of paths) {
    await fs.mkdir(path.dirname(path.join(image, relative)), { recursive: true });
    await fs.cp(path.join(project, relative), path.join(image, relative), { recursive: true });
  }
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(checkout, 'a.ts'), 'base();\n');
  await git('add', '.');
  await git('commit', '-m', 'base');
  const baseSha = await git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(checkout, 'a.ts'), 'changed();\n');
  await git('commit', '-am', 'change');
  const sourceSha = await git('rev-parse', 'HEAD');
  const fakeCodex = path.join(temporary, 'fake-codex.mjs');
  const writeCodex = () => fs.writeFile(fakeCodex, `
    import fs from 'node:fs';
    if(!fs.statSync(process.env.CODEX_HOME).isDirectory()) throw new Error('Codex home must exist before invocation');
    if(process.env.GITLAB_TOKEN || process.env.CI_JOB_TOKEN || process.env.FEISHU_WEBHOOK_URL) throw new Error('credential isolation failed');
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    if(!input.includes('changed();')) throw new Error('pipeline content missing');
    process.stdout.write(${JSON.stringify(malformedOutput ? 'bad-json' : JSON.stringify({ summary: 'Smoke test', findings: [{
      severity: 'medium', title: 'Finding', description: 'Description', file: 'a.ts',
      line_start: 1, line_end: 1, code: 'changed();', recommendation: 'Fix',
    }] }))});
  `);
  await writeCodex();
  // An audited repository's .env must not supply or override Runner configuration.
  await fs.writeFile(path.join(checkout, '.env'), 'PORT=invalid\nGITLAB_TOKEN=wrong-token\nDATABASE_PATH=/invalid/database.db\n');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: process.env.PATH, HOME: temporary, CI_PIPELINE_SOURCE: 'merge_request_event',
    CI_SERVER_URL: endpoint, CI_PROJECT_PATH: 'group/repo', CI_PROJECT_DIR: checkout,
    CI_MERGE_REQUEST_PROJECT_ID: '42', CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '42', CI_MERGE_REQUEST_IID: '7',
    CI_COMMIT_SHA: sourceSha, CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
    GITLAB_TOKEN: 'smoke-gitlab-secret', CI_JOB_TOKEN: 'smoke-ci-secret',
    OPENAI_API_KEY: 'smoke-api-secret', CODEX_MODEL: 'smoke-model', CODEX_COMMAND: process.execPath, CODEX_ARGS: fakeCodex,
    FEISHU_ENABLED: 'true', FEISHU_WEBHOOK_URL: `${endpoint}/feishu`,
    PORT: 'invalid', DATABASE_PATH: '/not-writable/database.db',
  };
  const entry = path.join(image, 'dist/cli/review.js');
  const result = await exec(process.execPath, [entry], { cwd: checkout, env, timeout: 20_000 });
  assert.match(result.stdout, /Review: succeeded/);
  assert.equal(notes[0], '🤖⏳ 赛博老王 正在细品你的优雅代码');
  assert.match(notes[1], new RegExp(`codereview:run:${sourceSha}`));
  assert.equal(notifications, 1);
  for (const location of ['node_modules', 'db', 'data', 'dist/infrastructure/database', 'dist/http']) {
    await assert.rejects(fs.stat(path.join(image, location)), { code: 'ENOENT' });
  }
  assert.equal((await git('worktree', 'list', '--porcelain')).match(/^worktree /gm)?.length, 1);
  assert.equal(await git('rev-parse', 'HEAD'), sourceSha);
  console.log('RUNNER_WITHOUT_DATABASE_WEB_QUEUE_OR_NODE_MODULES_OK');
  console.log('MR_RECEIPT_REVIEW_COMMENT_AND_FEISHU_OK');
  console.log('CI_COMMIT_PINNING_ENV_ISOLATION_AND_CLEANUP_OK');

  malformedOutput = true;
  await writeCodex();
  const beforeNotes = notes.length;
  await assert.rejects(exec(process.execPath, [entry], { cwd: checkout, env, timeout: 20_000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /not valid JSON/);
    assert.doesNotMatch(error.stderr, /smoke-(gitlab|api|ci)-secret/);
    return true;
  });
  assert.equal(notes.length, beforeNotes + 1); // Receipt only, no malformed result published.
  assert.equal(notifications, 1);
  console.log('CLI_REVIEW_FAILURE_RETURNS_EXIT_1_OK');

  malformedOutput = false;
  failNotification = true;
  await writeCodex();
  const beforeFailureNotes = notes.length;
  await assert.rejects(exec(process.execPath, [entry], { cwd: checkout, env, timeout: 20_000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /Feishu: failed/);
    return true;
  });
  assert.equal(notes.length, beforeFailureNotes + 2); // Result comment remains published.
  assert.equal(notifications, 2);
  console.log('CLI_NOTIFICATION_FAILURE_PRESERVES_COMMENT_AND_RETURNS_EXIT_1_OK');

  const skipped = await exec(process.execPath, [entry], { cwd: checkout, env: { PATH: process.env.PATH } });
  assert.match(skipped.stdout, /not a merge request pipeline/);
  console.log('NON_MR_PIPELINE_SKIPPED_WITHOUT_CREDENTIALS_OK');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
