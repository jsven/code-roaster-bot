# Code Review 自动审核服务设计

## 1. 背景与目标

该服务用于 GitLab Merge Request 创建时的自动化代码审核：接收 GitLab 合并请求事件，拉取变更代码，调用本地 `codex-cli` 进行审核，将问题按高/中/低风险分级并回写到 MR，同时使用本地 SQLite 保存审核任务元数据，并提供 Web 界面查看审核状态。

第一阶段以 GitLab Merge Request 为首个适配器，接口层保留 Provider 抽象，以便后续接入 GitHub、Gitee 等平台。

## 2. 非目标

- 第一阶段不实现通用的云端大模型调用，审核只通过本机 `codex-cli` 完成。
- 第一阶段不引入 Redis、RabbitMQ 等外部消息中间件，使用 Node.js 进程内队列和 SQLite 持久化任务。
- 第一阶段不替代人工审批，不自动修改业务代码。
- 服务只负责生成审核结果并评论到 GitLab MR，不负责批准、阻断或判断是否允许合并。
- 第一阶段不在 SQLite 或 Web 页面中保存审核问题正文、代码片段、完整 Codex 输出或 SCM Token；问题内容只提交到 GitLab MR。

## 3. 推荐架构

采用单个 Node.js 进程承载 HTTP API 和后台轮询器；任务先写入 SQLite，再由进程内 Worker 顺序消费。这样保留了服务重启后的任务恢复能力，同时不引入外部队列服务。

```text
GitLab Webhook
      |
      v
Node.js Webhook API -- 校验、幂等、入队 --> SQLite 队列
                                               |
                                               v
                                         Review Worker
                                               |
                               +---------------+---------------+
                               |                               |
                               v                               v
                        Git Workspace                       Codex
                                                               |
                                                               v
                                                     标准化审核结果
                                                        /          \
                                                       /            \
                                                      v              v
                                             Comment Publisher   风险阈值判断
                                                      |              |
                                                      v        存在 high/medium
                                             GitLab Notes API         |
                                                      |              v
                                                      v       Feishu Notifier
                                               MR 汇总评论             |
                                                                     v
                                                                飞书群机器人

Node.js API + Server-rendered UI <--------- SQLite 状态记录
```

### 技术选型

- Node.js 20+
- Fastify：Webhook、管理 API、页面服务
- `better-sqlite3`：SQLite 数据访问
- EJS 或原生 HTML 模板：第一版管理界面，避免单独构建前端
- 系统 `git`：首次 clone 仓库，后续 fetch 并复用持久工作区
- 本地 `codex-cli`：审核执行器
- Vitest：单元测试、契约测试和端到端测试

## 4. 端到端流程

### 4.1 Webhook 接收

接口：`POST /webhooks/gitlab`

1. 使用 GitLab Webhook Secret Token 校验请求。
2. 只接受 `object_kind=merge_request` 且 `object_attributes.action=open` 的事件；其他事件记录后忽略。
3. 读取项目 ID、MR IID、source SHA、target SHA、仓库地址、MR URL 和发起人。
4. 以 `provider + project_id + mr_iid + source_sha` 建立幂等键。
5. 只保存事件元数据和 payload hash 到 `webhook_events`，不保存原始 payload。
6. 创建 `review_jobs`，状态为 `queued`。
7. 立即返回 `202 Accepted`，不在 HTTP 请求中执行审核。

首期只在 MR 创建时审核。后续如需覆盖 push 更新，可增加 `update` 事件而不改变队列和审核流程。

### 4.2 内部队列实现

`review_jobs` 同时承担任务表和队列表。Webhook 事务提交后，Node.js Worker 每秒轮询一个 `queued` 任务；首期并发数固定为 1，避免 SQLite 写锁和同一 MR 的竞态。领取任务使用短事务原子更新状态，服务重启时将超时的 `running`/`commenting` 任务重新置为 `queued`。失败任务最多重试 3 次，超过次数后保持 `failed`。

### 4.3 拉取代码

Worker 通过 GitLab MR API 获取 head/base SHA 和源/目标仓库 clone 地址。`WorkspaceManager` 首次为仓库 clone 到 `WORKSPACE_ROOT/<repository-key>`，后续任务复用同一目录，执行 `reset --hard`、`clean -fdx`、`fetch --prune` 和 checkout 新 head SHA，再生成完整 diff 和变更文件内容交给 Codex。审核结束不删除工作区。

队列 Worker 首期并发数为 1，因此同一时间不会有两个任务修改持久工作区；后续提高并发时必须增加按仓库加锁。

### 4.4 Codex 审核

由 Node.js 的 `CodexRunner` 封装 CLI 调用，业务层不依赖具体参数。配置示例：

```yaml
codex:
  command: codex
  args: [exec]
  model: gpt-5.2
  reasoning_effort: medium
  sandbox: read-only
  approval_policy: never
  profile: null
  ephemeral: true
  output_schema: null
  prompt_file: ./prompts/code-review.md
  timeout_seconds: 900
  max_output_bytes: 2000000
```

提示词为本地可编辑文件。运行时可记录其 SHA-256，首期不保存提示词正文。

Codex 必须输出可校验的 JSON：

```json
{
  "summary": "整体审核结论",
  "findings": [
    {
      "severity": "high",
      "title": "问题标题",
      "description": "问题说明",
      "file": "src/example.py",
      "line_start": 42,
      "line_end": 45,
      "code": "受影响的代码片段",
      "recommendation": "建议整改意见",
      "category": "security",
      "confidence": 0.94
    }
  ]
}
```

服务端使用 JSON Schema 校验输出：`severity` 只允许 `high`、`medium`、`low`；问题说明、代码片段和整改建议为必填；文件必须属于本次 diff；行号必须有效。无法解析时任务失败，但不把原始输出写入 SQLite。

### 4.5 评论回写

为保持服务简单，首期只向 MR 发布一条汇总 Note。`CommentPublisher` 使用 GitLab API：

```http
POST /api/v4/projects/:id/merge_requests/:iid/notes
PRIVATE-TOKEN: ${GITLAB_TOKEN}
Content-Type: application/json

{"body":"渲染后的审核汇总 Markdown"}
```

请求体中的 `body` 由审核结果渲染，按 high、medium、low 三个分组排列。每个问题包含风险等级、问题说明、代码片段、整改建议、文件和行号；首期不实现 Inline Discussion。

发布成功后，将 GitLab 返回的 `note.id` 和 `comment_status=succeeded` 写入 SQLite；发布失败则记录错误并将任务标记为 `failed`，页面提供重试操作。

每个问题使用稳定 fingerprint：

```text
hash(repository + file + line + title + normalized_description)
```

汇总评论带有 `<!-- codereview:run:<source_sha> -->` 标记，防止 GitLab Webhook 重试造成重复评论。

评论模板必须包含：风险等级、问题说明、代码片段、建议整改意见、文件和行号。

### 4.6 飞书群通知

审核结果完成后，由 `FeishuNotifier` 判断问题等级：只要存在至少一个 high 或 medium 问题，就向配置的飞书群机器人发送通知；只有 low 问题或没有问题时不发送。

飞书消息首期只发送摘要，不复制完整问题内容，避免审核内容在多个系统重复保存。消息包含：

- 仓库名称
- MR 标题和链接
- 发起人
- 高/中/低风险数量
- 审核状态
- GitLab MR 链接

飞书通知失败不改变 GitLab 审核结果，单独记录 `feishu_status` 和错误信息，并允许在审核详情页重试通知。

推荐使用飞书“群自定义机器人”Webhook，而不是第一版就接入飞书开放平台应用。服务端配置：

```env
FEISHU_ENABLED=true
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
FEISHU_SECRET=xxxxxxxx
FEISHU_MIN_SEVERITY=medium
FEISHU_TIMEOUT_MS=10000
```

其中 `FEISHU_MIN_SEVERITY=medium` 表示 high 和 medium 触发通知，low 不触发。`FEISHU_SECRET` 仅在飞书机器人开启“签名校验”时配置；服务端按飞书要求计算 timestamp + 签名并发送请求。

### 4.7 飞书侧需要准备的内容

1. 在目标飞书群中创建“群自定义机器人”。
2. 设置机器人名称和头像。
3. 选择安全策略，推荐开启签名校验；如果使用关键词校验，需要把服务发送的关键词加入机器人配置。
4. 复制机器人 Webhook URL。
5. 如果开启签名校验，复制并安全保存 Signing Secret，填入 `FEISHU_SECRET`。
6. 确认部署环境可以访问 `open.feishu.cn`，并确认群管理员允许添加机器人。

如果企业安全策略不允许群自定义机器人，才改用飞书开放平台应用机器人；届时还需要 App ID、App Secret、Tenant Access Token 获取方式和目标群的 `chat_id`，实现复杂度会明显增加。

## 5. 核心模块边界

```text
src/
├── api/              Webhook、Review、Settings API
├── providers/        SCM Provider 接口与 GitLab 实现
├── review/
│   ├── orchestrator  审核状态机
│   ├── workspace      持久 clone、fetch、checkout、diff 和文件上下文
│   ├── codex_runner  CLI 启动、超时、输出采集
│   ├── output_parser JSON Schema 校验和规范化
│   ├── publisher     GitLab 评论格式化、去重、回写
│   └── notifier      飞书阈值判断、签名和群消息发送
├── db/               SQLite engine、迁移和 Repository
├── queue/            SQLite 队列、任务领取和重试
├── worker.js         任务轮询、锁和重试
└── views/            EJS 页面
```

GitLab Provider 接口至少包含：`get_merge_request`、`get_project`、`create_note`、`find_existing_run_note`。

## 6. SQLite 数据模型

SQLite 只保存审核任务和运行状态，不保存问题正文、代码片段、整改建议或完整 Codex 输出。

### repositories

`id`、`provider`、`external_project_id`、`name`、`clone_url`、`enabled`、时间字段。

### webhook_events

`id`、`provider`、`event_id`、`event_type`、`project_id`、`mr_iid`、`received_at`、`processed_at`、`status`、`payload_hash`。不保存原始 Webhook payload。

### review_jobs

`id`、`repository`、`project_id`、`mr_iid`、`mr_url`、`author`、`target_sha`、`source_sha`、`status`、`attempt`、`error_code`、`error_message`、`comment_status`、`feishu_status`、`feishu_error`、`created_at`、`started_at`、`finished_at`。

状态：`queued`、`running`、`commenting`、`succeeded`、`failed`、`cancelled`。

### review_findings

首期不建立该表。问题内容和风险统计以 GitLab MR 评论为准；如后续需要统计，仅保存计数或脱敏汇总字段。

### review_comments

可选的轻量记录：`id`、`review_job_id`、`external_comment_id`、`status`、`error_message`、时间字段；不保存 `content`。

### prompt_versions

`id`、`file_path`、`sha256`、`created_at`；不保存提示词正文。

## 7. API 与页面

### API

```text
POST /webhooks/gitlab
POST /api/reviews/{id}/retry
POST /api/reviews/{id}/retry-feishu
GET  /api/reviews
GET  /api/reviews/{id}
GET  /api/health
GET  /api/ready
```

### 页面

- `/reviews`：审核任务列表，展示仓库、MR 地址、发起人、状态、评论状态和时间。
- `/reviews/{id}`：审核任务元数据、MR 链接、状态流转、错误信息和重试按钮；问题详情通过 MR 链接查看。
- 审核详情页同时展示飞书通知状态，并提供单独的飞书通知重试按钮。
- `/settings`：GitLab、codex-cli、Worker 和当前提示词文件 SHA 的可用性检查。

## 8. 可靠性与安全

- Webhook Secret Token 校验和事件幂等。
- 同仓库同一 MR 同时只运行一个审核任务。
- 任务失败最多重试 3 次，指数退避；服务重启时将遗留的 `running` 任务恢复为 `queued`。
- Git、Codex 和评论 API 均设置超时。
- Token 只从环境变量或受保护配置读取，日志中脱敏。
- 仓库地址、分支名、SHA 做 allowlist 和格式校验。
- 持久工作区按仓库 key 隔离；每次审核前执行 hard reset 和 clean，避免上次任务残留修改。
- 限制 diff 大小、文件数、单文件长度和最大问题数。
- 只记录任务元数据、状态、错误和评论提交状态；不落盘原始 Codex 输出及问题正文。
- 飞书通知只记录发送状态和错误信息，不保存飞书消息正文。

## 9. 实施阶段与验收标准

### Phase 1：MVP

GitLab MR 创建 Webhook、Node.js 内部队列、SQLite、持久 clone/fetch 工作区、codex-cli、JSON 解析、总览评论、审核列表/详情页、失败重试。

### Phase 2：增强

Inline 评论、评论更新去重、多仓库配置、手动重审、提示词版本页面。

### Phase 3：生产化

GitHub/Gitee Provider、Redis 或独立队列、多 Worker、登录权限、监控告警和结果导出。

验收必须证明：Webhook 能安全幂等接收 MR 创建事件；拉取正确 SHA 的 diff；Codex 输出可校验；问题按高/中/低顺序回写；每个问题具备说明、代码片段和整改建议；SQLite 只留存仓库、MR 地址、发起人、审核状态等元数据；存在 high 或 medium 问题时发送飞书群通知；只有 low 或无问题时不发送；飞书失败不影响 GitLab 评论；页面可查询并可单独重试飞书通知；失败可重试；修改提示词后新任务使用新版本；重复事件不会重复评论。

## 10. 待确认的产品决策

1. 是否允许服务访问多个仓库，还是先配置单个仓库。
2. 是否需要第二阶段再增加 GitLab Inline Discussion（首期默认只发一条汇总评论）。
