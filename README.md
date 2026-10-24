# GitLab Code Review Service

一个简单的 Node.js 代码审核服务：GitLab 创建 Merge Request 时发送 Webhook，服务将任务写入 SQLite 内部队列，首次 clone 仓库、后续复用并更新持久工作区，调用本地 `codex-cli` 审核，把按高/中/低风险排序的汇总评论提交到 GitLab MR；出现中风险或高风险时，再通知飞书群机器人。

服务只负责审核和评论，不负责批准、阻断或判断是否允许合并。

## 运行模式

| 模式 | 职责 | 入口 | 数据库与队列 |
| --- | --- | --- | --- |
| 服务模式 | Webhook、统一审核记录页面、后台执行审核 | `npm run dev` / `npm start` / Compose | 使用 SQLite 与内部队列 |
| GitLab Runner 模式 | 一次性审核、MR 评论、飞书通知，完成后退出 | `npm run review` / `npm run review:prod` | 不初始化数据库、队列、Worker 或 HTTP 服务 |

Runner 镜像使用 `docker build --target runner -t code-review:runner .` 构建；默认镜像和 Compose 继续使用服务模式。Runner 不需要 Webhook、3000 端口或 `data` 挂载。

从零部署请看 [GitLab CI/CD Runner 完整部署手册](docs/gitlab-runner-deployment.md)，涵盖 Runner 创建注册、镜像发布、私有镜像认证、变量配置、业务 CI 接入、验收、更新回滚和排障。

程序行为与变量速查见 [GitLab Runner 模式](docs/gitlab-runner.md)。没有其他 CI Job 时使用 [完整独立 CI 示例](ci/gitlab-code-review.standalone.yml)；已有流水线时使用 [增量 Job 模板](ci/gitlab-code-review.yml)。配置应放到被审核业务仓库的 `.gitlab-ci.yml`。

同一项目选择一种触发方式，避免 Webhook 和 MR Pipeline 同时发起审核。

## 工程目录

- `src/domain`：任务模型与审核结果规则。
- `src/application`：审核编排、Worker 和外部依赖接口。
- `src/infrastructure`：SQLite、GitLab、Codex、飞书和 Git 工作区实现。
- `src/http`：路由、参数校验与页面渲染。
- `src/bootstrap`、`src/config`、`src/cli`：依赖装配、配置、维护命令。
- `db/migrations`：按版本维护的数据库结构 SQL；`public`：页面样式。
- `test`：按模块职责组织的测试；`docs`：设计与维护文档。
- `ci`：GitLab MR Pipeline 审核 Job 模板。

完整目录和依赖约定见 [工程目录规范](docs/project-structure.md)，数据库变更约定见 [数据库脚本规范](db/README.md)。

## 本地开发

支持以下两种启动方式，任选一种即可。所有命令均在项目根目录执行。

| 方式 | 本机要求 | 启动命令 | 停止方式 |
| --- | --- | --- | --- |
| 直接运行源码 | Node.js 20+、Git、Codex CLI | `npm run dev` | 运行终端按 `Ctrl+C` |
| Docker Compose | 已启动的 Docker Desktop 或 Docker Engine，以及 Compose | `docker compose up -d --build` | `docker compose down` |

### 公共配置

首次使用时准备 `.env`，已有文件则保留：

```bash
if [ ! -f .env ]; then
  cp .env.example .env
fi
```

编辑 `.env`，填写 `GITLAB_BASE_URL`、`GITLAB_TOKEN`、`GITLAB_WEBHOOK_SECRET`，以及 API Key 模式使用的 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CODEX_MODEL`。API Key 模式的详细说明和可选的账号登录方式见 [API Key 与请求地址](#api-key-与请求地址)。两种启动方式使用同一份 `.env`，Docker 方式通过 Compose 的 `env_file` 注入配置。

### 方式一：npm run dev

本机需已安装 Node.js 20+、Git 和 Codex CLI。

```bash
# 首次使用或依赖发生变化时安装项目依赖
npm ci

# 直接运行源码，不需要先执行 npm run build
npm run dev
```

服务在当前终端前台运行，可直接查看输出，按 `Ctrl+C` 停止。当前 `dev` 脚本未启用自动重启，修改源码或 `.env` 后，需要按 `Ctrl+C` 停止，再执行 `npm run dev`。

### 方式二：Docker Compose

先启动 Docker Desktop 或 Docker Engine。本机无需另外安装项目使用的 Node.js、Git、Codex CLI，这些依赖会在构建镜像时安装。

```bash
# 首次构建镜像并在后台启动服务
docker compose up -d --build
```

查看容器状态及日志：

```bash
docker compose ps
docker compose logs -f code-review
```

日志跟随模式下按 `Ctrl+C` 只退出日志查看，服务仍在后台运行。停止服务使用：

```bash
docker compose down
```

源码、SQL、页面样式和提示词随镜像构建，修改这些文件后重新构建并启动：

```bash
docker compose up -d --build
```

如果只修改 `.env`，重新创建容器以加载新配置：

```bash
docker compose up -d --force-recreate
```

### 访问、数据和模式切换

- 默认访问 `http://localhost:3000/`，自动跳转到 `/reviews` 审核记录首页；健康检查为 `http://localhost:3000/health`。
- 两种方式默认均将数据库放在工程的 `data/reviews.db`，仓库工作区放在 `data/workspaces`。Compose 通过 `./data:/app/data` 挂载工程数据目录，停止或重建容器后数据仍保留。
- 切换前先停止另一种方式：从 npm 切到 Docker 先按 `Ctrl+C`；从 Docker 切到 npm 先执行 `docker compose down`。避免抢占同一端口或同时处理同一批审核任务。
- `.env` 的 `PORT` 可调整访问端口。直接运行时服务使用该端口，Compose 将该宿主机端口映射到容器固定的 3000 端口。
- Compose 中的数据、工作区和提示词路径使用容器内绝对路径。若配置 `CODEX_OUTPUT_SCHEMA` 或其他自定义文件路径，需要挂载对应文件并使用容器内路径。

## 构建运行与数据库迁移

直接在本机运行构建产物时：

```bash
npm run typecheck
npm test
npm run build
npm start
```

构建仅输出源码到 `dist/`，入口为 `dist/server.js`。部署时同时保留 `db/`、`public/` 和 `prompts/` 资源目录。

服务启动时自动执行待应用的数据库迁移；也可以预先独立运行 `npm run db:migrate`（源码环境）或 `npm run db:migrate:prod`（构建后）。已有数据库保留原有数据并补齐版本记录与索引。

以上数据库迁移仅针对服务模式；Runner 入口不加载数据库模块。可执行 `npm run test:runner` 离线验证无数据库的 CLI 流程。

线上 `docker run --env-file`、服务器配置文件、数据挂载及更新流程见 [线上部署说明](docs/deployment.md)，配置模板为 [deploy/production.env.example](deploy/production.env.example)。

## Codex 运行参数

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

## API Key 与请求地址

在 `.env` 中填写 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `CODEX_MODEL`，开发环境与 Docker Compose 都会读取这份配置：

```env
OPENAI_API_KEY=你的API密钥
OPENAI_BASE_URL=https://api.openai.com/v1
CODEX_MODEL=接口支持的模型名
```

使用 OpenAI 官方 API 时，`OPENAI_BASE_URL` 可留空（默认 `https://api.openai.com/v1`）；使用代理或自建兼容接口时，填写该服务的 API 基址，通常含 `/v1`，不要填写完整的 `/responses` 或 `/chat/completions` 路径。兼容服务需要支持 Responses API，模型名以该服务实际提供的名称为准。

填写 Key 后，审核进程会显式使用这份 API 配置，不需要再执行 `codex login`，也不依赖容器中的历史登录状态。Key 只通过进程环境传递，不进入命令行参数。Key 和地址都留空时，继续使用原有 Codex 登录及 provider/profile 配置；单独填写自定义地址而不填写 Key 会在启动时报告缺少配置。

配置修改后，本地重启 `npm run dev`；容器执行 `docker compose up -d --force-recreate`。如果同时更新了本次 API 配置功能的代码，需要先执行 `docker compose up -d --build`。

### 可选：账号登录模式

配置了 `.env` 中的 `OPENAI_API_KEY` 时，无需执行以下登录步骤。如果使用账号登录，将 `OPENAI_API_KEY` 与 `OPENAI_BASE_URL` 都留空：本机运行模式使用本机 Codex 的登录和配置，容器模式需要单独完成设备登录。

```bash
# 仅账号登录模式需要；首次构建后执行
docker compose run --rm --no-deps code-review codex login --device-auth
```

容器不会自动继承本机 Codex 的登录状态或自定义 provider/profile 配置。设备登录凭据保存在项目的 `codex-home` 命名卷中；登录模式下若使用自定义 provider/profile，需要在容器内的 `/root/.codex/config.toml` 配置对应项。API Key 模式直接读取 `.env`，无需手工编辑容器内配置。

不要把凭据写入镜像或提交到仓库。`docker compose down` 保留数据目录和登录卷；`docker compose down -v` 会删除登录卷，账号登录模式需要重新登录。

## GitLab Webhook

在 GitLab 项目中添加 URL：

```text
https://<service-host>/webhooks/gitlab
```

配置 Secret Token，填入 `.env` 的 `GITLAB_WEBHOOK_SECRET`，并只勾选 Merge request events。服务首期只接受 `object_attributes.action=open` 的 MR 创建事件，其它动作会返回 202 但不会入队。

每次收到有效的 MR 创建消息，服务会在 Webhook 处理阶段立即向该 MR 评论「🤖⏳ 赛博老王 正在细品你的优雅代码」，无需等待 Worker、拉取仓库或 Codex 审核。该回复不做消息去重，审核完成后仍发布完整结果评论。即时回复失败不会阻止已入队的审核任务，Webhook 响应通过 `receiptCommentStatus` 返回 `succeeded` 或 `failed`。

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

任务列表支持仓库、创建日期范围组合筛选，以及分页（默认每页 20 条，可选 50、100 条）。日期筛选和列表中的创建时间均使用北京时间（UTC+8），结束日期包含当天。翻页保留筛选条件，重新筛选时从第一页开始。

`GET /api/reviews` 使用相同筛选条件，返回 `{ items, total, page, pageSize, totalPages }`（原先的直接数组改为分页对象）。查询参数：

- `page`：页码，从 1 开始；超出总页数时返回最后一页。
- `pageSize`：每页条数，默认 20，范围 1–100。
- `repository`：完整仓库名，精确匹配，例如 `group/demo`。
- `startDate`、`endDate`：可单独或组合使用，格式 `YYYY-MM-DD`，按任务创建日期筛选。

例如：`/api/reviews?page=1&pageSize=20&repository=group%2Fdemo&startDate=2026-10-01&endDate=2026-10-24`。

## 安全注意事项

- Webhook 必须使用 Secret Token。
- GitLab Token、飞书 Webhook 和 Signing Secret 只放在环境变量或受保护的部署配置中。
- 不要把 `.env`、SQLite 数据库和审核工作目录提交到版本库。
