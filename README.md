# GitLab Code Review Service

一个简单的 Node.js 代码审核服务：GitLab 创建 Merge Request 时发送 Webhook，服务将任务写入 SQLite 内部队列，首次 clone 仓库、后续复用并更新持久工作区，调用本地 `codex-cli` 审核，把按高/中/低风险排序的汇总评论提交到 GitLab MR；出现中风险或高风险时，再通知飞书群机器人。

服务只负责审核和评论，不负责批准、阻断或判断是否允许合并。

## 启动

要求 Node.js 20+、Git、可执行的 `codex-cli` 和一个可访问 GitLab API 的 Token。

```bash
npm install
cp .env.example .env
# 编辑 .env，至少配置 GITLAB_TOKEN、GITLAB_WEBHOOK_SECRET
npm run dev
```

生产构建：

```bash
npm run typecheck
npm test
npm run build
npm start
```

默认页面：`http://localhost:3000/reviews`

Codex 模型参数：

```env
CODEX_MODEL=gpt-5.2
# 推理强度：low / medium / high / xhigh（也支持 低 / 中 / 高 / 极高）
CODEX_REASONING_EFFORT=medium
CODEX_SANDBOX=read-only
CODEX_APPROVAL_POLICY=never
CODEX_PROFILE=
CODEX_EPHEMERAL=true
CODEX_OUTPUT_SCHEMA=
```

- `CODEX_MODEL`：传给 `codex exec --model`；为空时使用 Codex 默认模型。
- `CODEX_REASONING_EFFORT`：推理强度，支持 `low`（低）、`medium`（中）、`high`（高）、`xhigh`（极高）；服务通过 `-c model_reasoning_effort="..."` 传给 Codex，默认 `medium`。
- `CODEX_SANDBOX`：默认 `read-only`，可选 `workspace-write` 或 `danger-full-access`。
- `CODEX_APPROVAL_POLICY`：默认 `never`，可选 `untrusted`、`on-failure`、`on-request`。
- `CODEX_PROFILE`：可选的 Codex 配置 profile。
- `CODEX_EPHEMERAL`：默认 `true`，不保留 Codex 会话文件。
- `CODEX_OUTPUT_SCHEMA`：可选 JSON Schema 文件路径，用于约束 Codex 最终输出。

## GitLab Webhook

在 GitLab 项目中添加 URL：

```text
https://<service-host>/webhooks/gitlab
```

配置 Secret Token，填入 `.env` 的 `GITLAB_WEBHOOK_SECRET`，并只勾选 Merge request events。服务首期只接受 `object_attributes.action=open` 的 MR 创建事件，其它动作会返回 202 但不会入队。

GitLab API Token 需要能够读取项目信息、读取仓库代码并创建 MR Note，推荐使用项目级或机器人账号的最小权限 Token（通常至少需要 `read_api`/`read_repository`，创建 Note 需要 API 写权限）。对于来自 Fork 的 MR，Token 还必须能读取 source project。

## Codex 提示词

提示词文件默认为 `prompts/code-review.md`，可通过 `CODEX_PROMPT_FILE` 修改路径。Codex 必须输出严格 JSON，字段格式见该文件。服务不会把原始输出或问题正文写入 SQLite。

## 飞书群机器人

启用飞书通知时，在目标群添加自定义机器人，复制 Webhook URL；如果开启签名校验，同时配置 Signing Secret：

```env
FEISHU_ENABLED=true
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
FEISHU_SECRET=xxxxxxxx
FEISHU_MIN_SEVERITY=medium
```

存在至少一个高风险或中风险问题时发送摘要；只有低风险或无问题时不发送。飞书发送失败不会改变 GitLab 审核结果，可以在任务详情页触发“重试飞书通知”（该操作会重新执行整次审核，因为本地不保存问题正文）。

## 数据与页面

SQLite 默认路径为 `data/reviews.db`，仅保存仓库、MR 地址、发起人、SHA、审核状态、GitLab 评论状态、飞书通知状态和错误信息。

仓库工作区默认路径为 `data/workspaces`。首次审核会 clone，后续审核会复用对应仓库目录并 fetch 最新提交；Worker 首期串行执行，避免同一工作区并发写入。

- `GET /reviews`：审核任务列表
- `GET /reviews/:id`：审核任务详情和重试按钮
- `GET /health`：存活检查
- `GET /ready`：就绪检查

## 安全注意事项

- Webhook 必须使用 Secret Token。
- GitLab Token、飞书 Webhook 和 Signing Secret 只放在环境变量或受保护的部署配置中。
- 不要把 `.env`、SQLite 数据库和审核工作目录提交到版本库。
