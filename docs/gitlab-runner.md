# GitLab CI/CD Runner 模式

从零准备服务器、注册 Runner、发布镜像及完成真实 MR 验收，参见 [GitLab CI/CD Runner 完整部署手册](gitlab-runner-deployment.md)。本文侧重运行模式及程序行为。

Runner 模式是一次性审核程序，职责只有：发送开始评论、读取本次 MR 的代码变更、调用 Codex、发表评论、按阈值通知飞书，然后退出。

它不启动 HTTP 服务，不初始化 SQLite，不创建应用数据库，不使用应用队列或 Worker，也无需配置 GitLab Webhook 和 `GITLAB_WEBHOOK_SECRET`。数据库与审核记录页面属于原有服务模式，两种模式共享审核规则及评论/通知实现。

## 1. 构建 Runner 镜像

在本项目根目录执行：

```bash
docker build --target runner -t code-review:runner .
```

将镜像推送到你们 Runner 能访问的镜像仓库。例如将下列地址替换为实际仓库和版本：

```bash
docker tag code-review:runner registry.example.com/tools/code-review:VERSION
docker push registry.example.com/tools/code-review:VERSION
```

Runner 目标包含 Node.js、Git、Codex、审核代码和固定提示词，不安装应用的 `better-sqlite3`、Fastify 或其他项目 npm 运行依赖，也不复制数据库脚本、页面或 `/app/data`。不需要挂载数据目录、登录卷或映射 3000 端口。

默认 `docker build` 以及现有 Compose 使用 `service` 目标，继续运行原有 Webhook、数据库、队列和后台页面。

## 2. 在被审核项目配置 CI/CD Variables

在 GitLab 项目或组的 **Settings → CI/CD → Variables** 设置：

| 变量 | 是否必填 | 用途 |
| --- | --- | --- |
| `CODE_REVIEW_IMAGE` | 是 | Runner 镜像地址，建议固定版本，不使用浮动标签 |
| `GITLAB_TOKEN` | 是 | 能读取 MR 并创建 MR Note 的 API Token；按你们 GitLab 版本配置相应 API 权限 |
| `OPENAI_API_KEY` | 是 | 模型接口密钥，Runner 不使用交互式账号登录 |
| `CODEX_MODEL` | 是 | 模型接口实际支持的模型名 |
| `OPENAI_BASE_URL` | 否 | 自定义 Responses API 基址；留空使用程序内置的官方地址 |
| `GITLAB_BASE_URL` | 否 | 默认读取 `CI_SERVER_URL` |
| `FEISHU_ENABLED` | 否 | 默认 `false`，通知时设为 `true` |
| `FEISHU_WEBHOOK_URL` | 启用通知时必填 | 飞书机器人 Webhook |
| `FEISHU_SECRET` | 否 | 飞书签名密钥 |
| `FEISHU_MIN_SEVERITY` | 否 | 默认 `medium`，与服务模式相同 |
| `CODEX_REASONING_EFFORT` | 否 | 默认 `medium` |
| `REVIEW_RETRY_NOTIFICATION` | 否 | 设为 `true` 时重新审核并重试通知，即使该 SHA 已有结果评论 |

不要把真实密钥写进 `.gitlab-ci.yml`。默认 `CI_JOB_TOKEN` 不具备创建 MR Note 的权限，因此程序不会拿它代替 `GITLAB_TOKEN`。

需要 Maintainer/管理员确认变量确实对目标 MR Pipeline 可用。Protected 变量对 MR 的可见性受分支、项目、发起人权限和 GitLab 版本限制，不能仅为了让 Job 运行就向不可信 MR 开放所有密钥。模板及程序均默认跳过 Fork MR。

MR 的 CI 配置本身也可能被修改，因此应只在可信项目/参与者范围使用，审核脚本与镜像由维护者管理。模板不执行被审核项目的安装、测试或构建命令，并覆盖默认 `before_script`、`after_script`，避免继承这些命令。Codex 子进程只获得模型访问所需环境，不继承 GitLab 评论 Token、CI Job Token、飞书地址/密钥。

## 3. 添加审核 Job

将本项目的 [ci/gitlab-code-review.yml](../ci/gitlab-code-review.yml) 中的 `code-review` Job 复制到**被审核业务仓库根目录的 `.gitlab-ci.yml`**。已有其他 Job 时合并该 Job，不需要覆盖整个文件。

若该业务仓库只有审核 Job，请改用 [完整独立 CI 示例](../ci/gitlab-code-review.standalone.yml)，其中使用普通 `review` stage 和明确的 Runner tag。只有 `.pre` / `.post` Job 的流水线不会运行；已有流水线也要确认 MR 触发时至少包含一个普通 stage 的 Job，否则应将审核 Job 调整到普通 stage。

模板已经包含：

- `rules`：只处理同项目的 `merge_request_event`，不执行普通分支、标签或 Fork 流水线。
- `stage: .pre` 与 `needs: []`：不等待其他阶段的业务构建；仍需等待 Runner 获得执行资源。
- `GIT_DEPTH: "0"`：确保本次 MR 的 diff base 和源提交在 Git 历史中。
- `script: node /app/dist/cli/review.js`：执行镜像里的审核程序，而不是业务仓库里的脚本。
- `allow_failure: true`：本项目只评论和通知，不决定是否允许合并；运行错误仍会显示在 Job 日志中。
- `timeout: 20m`：为默认 15 分钟的 Codex 超时以及 GitLab、通知操作预留时间。

若使用共享模板 `include`，同时检查业务仓库根配置中的 `workflow/rules` 是否允许创建 MR Pipeline，并按 GitLab 要求在根配置直接定义相关 MR 规则。使用 Docker 或 Kubernetes executor 运行该镜像；Shell executor 不会通过 `image` 字段加载镜像。

## 4. 执行过程与提交准确性

Job 开始后先评论：

> 🤖⏳ 赛博老王 正在细品你的优雅代码

这是 Job 开始后的回复，Runner 排队期间无法保证即时回复。

程序使用 `CI_MERGE_REQUEST_PROJECT_ID`、`CI_MERGE_REQUEST_IID` 和流水线中的固定提交 SHA：

- 普通 detached MR Pipeline 使用 `CI_COMMIT_SHA`。
- Merged result / merge train 使用 `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA`，审核源分支提交，不把合成 merge commit 当作源 SHA。
- Diff 基点使用 `CI_MERGE_REQUEST_DIFF_BASE_SHA`。

程序从 GitLab API 获取 MR 标题、作者和 URL，但不会用 API 中后来更新的 HEAD 替换流水线 SHA。基于 Runner 已检出的 Git 对象创建临时 detached worktree，Codex 在这个快照中只读审核，结束后移除快照；不会 reset、clean 或再次 clone 业务仓库，也不需要另配持久工作区。

缺少对应提交时明确报错并要求补齐历史，不会改审当前分支或最新 MR。提示词默认来自镜像中的 `prompts/code-review.md`，不从业务仓库的 `.env` 加载配置。

## 5. 结果与退出码

- `0`：审核完成并发布结果；发现高/中/低风险本身不会导致退出失败。非 MR 和 Fork 场景跳过时也返回 `0`。
- `1`：配置错误、Git 快照错误、Codex 失败、审核输出无效、结果评论失败或飞书通知失败。
- 开始评论失败时会在日志中报告并继续审核；通知失败时保留已经成功发布的审核结果评论。

最终评论使用原有的 SHA 标记，重复运行同一 SHA 时可以识别已发布的结果并跳过重复审核。开始评论按每次执行发送。由于 Runner 不记录数据库状态，如果只想重试失败的飞书通知，应使用 `REVIEW_RETRY_NOTIFICATION=true` 重跑；这会重新审核，但不重复发布最终结果。

执行状态和错误查看 GitLab Job 日志，MR 查看评论，飞书查看通知。Runner 模式不生成 Web 后台审核记录，也不保存问题正文到本地数据库或默认上传代码/审核正文 artifact。

## 6. 本地验证 CLI

开发环境一次性执行入口为 `npm run review`，编译后入口为 `npm run review:prod`。这两个命令需要显式提供上述 CI 变量，且 `CI_PROJECT_DIR` 指向已存在的 Git checkout；不会自动加载当前目录的 `.env`。

不调用真实 GitLab/模型/飞书的离线验证：

```bash
npm run test:runner
```

该命令构建后按 Runner 镜像目录打包程序到临时目录，使用真实 Git 仓库和本地模拟接口验证评论、审核、通知、退出码、密钥隔离和清理。打包目录不含项目 `node_modules`、数据库、队列和 HTTP 服务。

## 与服务模式配合

两个模式可以分别部署。对同一个项目不要同时启用服务 Webhook 和 CI 审核，以免重复开始评论、并发审核或竞相发布结果。CI 模式无需启动本项目的常驻服务。

GitLab 官方文档：

- https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/
- https://docs.gitlab.com/ci/variables/predefined_variables/
- https://docs.gitlab.com/ci/jobs/ci_job_token/
