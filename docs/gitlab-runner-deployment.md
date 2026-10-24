# GitLab CI/CD Runner 完整部署手册

本文从零部署本项目的 **Runner 模式**：业务仓库创建或更新 MR 后，由 GitLab 调度审核 Job，Job 在审核镜像中完成开始评论、代码审核、结果评论和飞书通知，随后退出。

已有可用 Docker executor Runner 时，从第 3 节开始；已有审核镜像时，从第 4 节开始。本文提供操作步骤和模板，不代表已经在你们 GitLab、镜像仓库或 Runner 服务器上完成部署。

快速定位：

- [Runner 准备与注册](#2-准备-gitlab-和-runner)
- [镜像构建发布](#3-构建发布及验证审核镜像)
- [凭据和 CI 变量](#4-配置业务项目凭据和变量)
- [业务仓库 CI 接入](#5-给业务仓库接入流水线)
- [首次 MR 验收](#6-第一次真实-mr-验收)
- [更新重跑与回滚](#7-日常更新重跑和回滚)
- [故障排查](#8-常见故障定位)

## 1. 部署拓扑与最终结果

### 1.1 四个对象及职责

| 对象 | 放在哪里 | 职责 | 是否常驻 |
| --- | --- | --- | --- |
| GitLab | 现有 GitLab 实例 | 管理业务仓库、MR、流水线、变量、评论和 Job 日志 | 是 |
| GitLab Runner 管理进程 | CI 服务器 | 向 GitLab 领取 Job，通过 Docker 创建执行容器 | 是 |
| 审核镜像 | 镜像仓库 | 打包 Node.js、Git、Codex 和本项目审核代码 | 镜像本身不运行 |
| 审核 Job 容器 | Runner 服务器上的 Docker | 运行一次 `/app/dist/cli/review.js`，审核、评论、通知后退出 | 否 |

`gitlab/gitlab-runner` 是 GitLab 的调度执行器管理镜像；本项目的 `code-review:runner` 是审核工具镜像，二者不能互相替代。[S1][S2]

### 1.2 本项目 Runner 模式的数据流

```text
业务仓库创建 MR / 向 MR 分支推送新提交
  → GitLab 创建 merge_request_event 流水线
  → Runner 拉取审核镜像、检出本次流水线代码
  → 执行 node /app/dist/cli/review.js
  → 在 MR 评论「🤖⏳ 赛博老王 正在细品你的优雅代码」
  → 固定流水线源提交及 diff base，创建临时快照，默认以 read-only sandbox 审核
  → Codex 调用配置的模型接口进行审核
  → 发布完整 MR 结果评论
  → 达到通知阈值时发送飞书摘要
  → 删除临时快照、退出；GitLab 保存 Job 执行状态和日志
```

Runner 等到获得执行资源后才开始回复 MR，无法在排队期间发送开始评论。当前程序对每次执行发送开始评论；最终结果按提交 SHA 检查已有评论，避免普通重跑时重复发布结果。

### 1.3 本模式需要与不需要的资源

| 资源 | 本模式要求 |
| --- | --- |
| Runner executor | 主流程使用 Linux Docker executor；Shell executor 不会自动加载 Job 的 `image` |
| Node.js、Git、Codex | 已打包进审核镜像，业务仓库无需安装 |
| `GITLAB_TOKEN` | 需要，用于读取 MR、读取已有评论、创建评论 |
| `OPENAI_API_KEY`、`CODEX_MODEL` | 需要；Runner 模式显式要求 API Key，不进行交互式登录 |
| 飞书配置 | 可选，先关闭即可验证审核和评论 |
| SQLite、数据库目录挂载 | 不需要 |
| 内部队列、Worker、审核 Web 页面 | 不启动 |
| Webhook、`GITLAB_WEBHOOK_SECRET` | 不需要 |
| 审核服务端口 3000 | 不需要 |
| 容器 Codex 登录卷 | 不需要，使用 CI 注入的 API Key |

Runner 管理进程自己的 `config.toml` 需要持久保存；这是 Runner 注册配置，不是本项目的数据库。

## 2. 准备 GitLab 和 Runner

### 2.1 准备权限、版本及网络

请先确定以下信息，本文的示例域名、目录和版本标签都需要换成实际值：

| 项目 | 示例 | 由谁准备 |
| --- | --- | --- |
| GitLab 地址 | `https://gitlab.example.com` | GitLab 管理员 |
| 业务仓库 | `business/lock-app` | 业务仓库维护者 |
| 审核工具仓库 | `tools/code-review` | 本项目维护者 |
| 镜像地址 | `registry.example.com/tools/code-review:runner-v1` | 镜像仓库维护者 |
| Runner 标签 | `code-review` | Runner 维护者 |
| Runner 配置目录 | `/opt/gitlab-runner/config` | CI 服务器管理员 |
| GitLab Runner 镜像版本 | 与 GitLab 实例相容的明确版本标签 | GitLab/Runner 管理员 |

创建项目 Runner 需要项目 Maintainer；组或实例 Runner 由对应管理者创建。Developer 可以参与 MR 和运行允许的流水线，但首次创建 Runner、配置密钥和项目令牌需要维护者配合。[S3][S8]

本文按 Runner authentication token（通常以 `glrt-` 开头）的新注册方式说明。先在 GitLab 的 Help 页面确认实例版本，再选择匹配的 Runner 版本；旧实例的 UI、受保护变量能力和注册方式可能不同，不能机械套用新版本步骤。[S2]

网络需要分两层确认：

| 发起方 | 必须能够访问 |
| --- | --- |
| Runner 管理进程 / 宿主机 Docker daemon | GitLab、审核镜像仓库、Runner helper 镜像仓库 |
| 审核 Job 容器 | GitLab 克隆和 API 地址、模型 API 地址、启用时的飞书机器人地址 |
| 镜像构建环境 | Node 基础镜像仓库、系统软件源、npm registry |

不要仅在自己电脑上验证网络。Job 容器的 DNS、路由、代理和 CA 信任配置也要成立。容器中的 `localhost` 指容器自身，不是 GitLab、模型服务或 Runner 宿主机。

如果 GitLab 使用类似内网 IP 地址，确保 Runner 宿主机和 Job 容器都有到该网段的路由。本模式不依赖 GitLab Webhook 的“允许访问本地网络”开关：请求由 Runner/Job 主动发出，而不是 GitLab 向审核服务发送 Hook。

### 2.2 已有 Runner：先确认可复用

在**业务仓库**的 **Settings → CI/CD → Runners** 查看可用 Runner，确认：

1. Runner 在线、未暂停且允许该项目使用。
2. 使用 Docker executor，能够从目标镜像仓库拉取审核镜像。[S1]
3. Runner 标签与审核 Job 的 `tags` 一致；本文统一使用 `code-review`。
4. Runner 的 protected 设置和变量策略允许目标 MR 执行；不要仅为消除 Pending 就放宽保护范围。
5. Runner/项目超时至少允许 20 分钟；按实际模型耗时调整。

都满足时无需再创建 Runner，继续第 3 节。

### 2.3 没有 Runner：在 GitLab 创建项目 Runner

在**业务仓库** **Settings → CI/CD → Runners → Create project runner** 创建：

| 设置 | 本文示例 |
| --- | --- |
| Description | `code-review-docker` |
| Tags | `code-review` |
| Run untagged | 若仅运行带标签审核 Job，可关闭 |
| Protected | 由维护者按 MR 来源与密钥策略设置，参见第 4.3 节 |

创建后保存 UI 临时显示的 Runner authentication token，只用于下一步注册。不要把这个 token 填成程序的 `GITLAB_TOKEN`，两者用途不同。[S2][S3]

### 2.4 在 CI 服务器运行 Runner 管理进程

以下命令在**Linux Runner 服务器**执行，要求已安装并启动 Docker。若系统用 Docker 权限组或 `sudo` 管理，按该服务器规范运行。

```bash
# 替换为管理员选定的明确版本标签，不使用下面的占位文字。
export REVIEW_RUNNER_IMAGE='gitlab/gitlab-runner:替换为版本标签'

mkdir -p /opt/gitlab-runner/config
docker pull "$REVIEW_RUNNER_IMAGE"

docker run -d \
  --name code-review-gitlab-runner \
  --restart unless-stopped \
  --volume /opt/gitlab-runner/config:/etc/gitlab-runner \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  "$REVIEW_RUNNER_IMAGE"
```

这是常驻的 **Runner 管理进程**，不是本项目的审核服务。管理进程通过宿主机 Docker socket 创建 Job 容器；应部署在由 CI 管理员控制的执行服务器上。不要将 Docker socket 再挂到审核 Job 容器，也不需要在审核 Job 中配置 Docker-in-Docker 或 `privileged=true`。[S1][S4]

### 2.5 注册 Docker executor

在同一台 **Runner 服务器**执行交互式注册，不要把 authentication token 写入仓库：

```bash
docker exec -it code-review-gitlab-runner gitlab-runner register
```

按当前 GitLab UI/注册程序提示填写：

| 提示项 | 填写内容 |
| --- | --- |
| GitLab instance URL | 实际 GitLab 地址，例如 `https://gitlab.example.com` |
| Runner authentication token | 第 2.3 节获得的 token |
| Runner name / description | 如 `code-review-docker` |
| Executor | **`docker`** |
| Default Docker image | `node:20-bookworm-slim`，审核 Job 会通过 `image` 覆盖它 |

新创建流程中的标签、protected、run untagged 等属性应在 GitLab UI 设置，不要混用旧 registration token 的参数。注册结果保存在 `/opt/gitlab-runner/config/config.toml`，该文件包含敏感 token，不要贴到日志或文档。[S2]

### 2.6 核对 Runner 在线

在 **Runner 服务器**执行：

```bash
docker exec code-review-gitlab-runner gitlab-runner verify
docker logs --tail 100 code-review-gitlab-runner
```

在 GitLab 的 Runners 页面确认 Runner 在线，executor、标签和项目范围正确。`verify` 只能确认注册连接，拉镜像、检出代码和模型访问仍需要实际 Job 验证。

## 3. 构建、发布及验证审核镜像

### 3.1 在本项目构建环境完成代码验证

以下在 **本项目 `code-review` 仓库根目录**执行，不是在被审核业务仓库里执行：

```bash
npm ci
npm run typecheck
npm test
npm run test:runner
```

`test:runner` 使用临时 Git 仓库、本地模拟 GitLab/飞书接口和模拟审核命令，验证编译后的 CLI 在不带数据库、Web 模块或项目 npm 运行依赖时能够执行。它不会调用真实模型，也不能替代真实 GitLab Runner 验收。

### 3.2 构建 Runner 目标

仍在**本项目根目录、具有 Docker 构建能力的机器**执行：

```bash
export REVIEW_IMAGE='registry.example.com/tools/code-review:runner-v1'
docker build --target runner --tag "$REVIEW_IMAGE" .
```

必须使用 **`--target runner`**。默认 Dockerfile 最终目标是常驻 `service`，普通 `docker build` 或项目现有 Compose 都用于服务模式。

构建阶段会编译整个项目；最终 Runner 目标只复制单次审核需要的模块和提示词，不复制 SQLite、HTTP 页面、数据库脚本、Worker 或队列实现。构建机可以装开发依赖，运行镜像不需要应用的 `better-sqlite3` / Fastify。

构建机器和 Runner CPU 架构必须相容。若在 Apple Silicon Mac 构建、Linux x86_64 Runner 上运行，需要面向 Runner 架构构建，例如：

```bash
docker build --platform linux/amd64 --target runner --tag "$REVIEW_IMAGE" .
```

架构以实际 Runner 为准，不要假设所有服务器都是 amd64。

### 3.3 镜像基本检查

在**镜像构建机器**执行：

```bash
docker run --rm "$REVIEW_IMAGE" node --version
docker run --rm "$REVIEW_IMAGE" git --version
docker run --rm "$REVIEW_IMAGE" codex --version

# 目录检查：只验证文件，不调用 GitLab 或模型。
docker run --rm "$REVIEW_IMAGE" node -e '
  const fs = require("node:fs");
  for (const file of ["/app/dist/cli/review.js", "/app/prompts/code-review.md"]) {
    if (!fs.existsSync(file)) throw new Error("Missing runtime file: " + file);
  }
  for (const dir of ["/app/db", "/app/data", "/app/dist/http", "/app/dist/infrastructure/database"]) {
    if (fs.existsSync(dir)) throw new Error("Unexpected service runtime directory: " + dir);
  }
  console.log("Runner image layout OK");
'

# 不注入 CI 变量时，预期跳过，不会发评论或请求模型。
docker run --rm "$REVIEW_IMAGE"
```

最后一条应输出 `Skipped: not a merge request pipeline`，退出码为 0。这只是入口检查，不能把它当作真实审核成功。

### 3.4 登录并推送镜像

在**镜像构建机器**执行，将地址和用户名替换为实际值：

```bash
docker login registry.example.com --username your-registry-user
docker push "$REVIEW_IMAGE"
```

密码或 registry token 在交互提示中输入，不写进命令行。推送完成记录版本标签、镜像 digest、对应本项目 Git 提交。后续业务项目用固定版本标签或 digest，不反复覆盖同一个生产标签。[S5]

### 3.5 配置 Runner 拉取私有镜像

“构建机器能 push”不等于“Runner 能 pull”。审核镜像在 Job 的 `script` 执行前就需要拉取，不能等脚本启动后再执行 `docker login` 来解决。[S5]

可选方式：

| 场景 | 处理方式 |
| --- | --- |
| 镜像公开、Runner 可匿名拉取 | 不额外配置 registry 凭据 |
| 同一 GitLab 的 Container Registry | 按实例策略配置跨项目 Job Token allowlist 和读取镜像的身份权限 |
| 其他私有 Registry / 跨项目权限不适用 | 在业务项目 CI/CD Variables 中配置 `DOCKER_AUTH_CONFIG`，或由 Runner 管理员配置镜像拉取凭据 |

`DOCKER_AUTH_CONFIG` 的结构如下，填写真实 registry 地址及 registry 用户名/只读凭据生成的认证值；这是拉镜像密钥，不是模型 Key 或 GitLab 评论 Token：

```json
{
  "auths": {
    "registry.example.com": {
      "auth": "BASE64_OF_USERNAME_COLON_REGISTRY_TOKEN"
    }
  }
}
```

如果镜像地址带端口，`auths` 中的 key 也必须包含相同端口。Base64 是编码，不是加密，认证值需要按密钥保管。企业镜像仓库使用自签 CA 时，应由管理员在 Docker daemon / Runner 层配置信任，不能靠关闭 Job 内 Git TLS 验证解决拉镜像失败。[S5]

## 4. 配置业务项目凭据和变量

### 4.1 创建评论用 GitLab Token

由维护者在**业务仓库**的 **Settings → Access tokens** 创建项目访问令牌（该功能的可用性以实例版本和订阅为准）。优先使用限定到该项目的机器人身份；若使用机器人账号的个人令牌，也应限制账号能访问的项目。[S8]

建议初次按项目 Developer 角色及 `api` scope 验证 MR 读取和评论创建，随后根据组织策略收敛权限、设置到期时间。`read_api` 是只读范围，不能替代评论写权限；镜像拉取凭据不应拿来当评论 Token。

程序实际使用：

```text
GET  /api/v4/projects/:project_id/merge_requests/:mr_iid
GET  /api/v4/projects/:project_id/merge_requests/:mr_iid/notes
POST /api/v4/projects/:project_id/merge_requests/:mr_iid/notes
```

默认 `CI_JOB_TOKEN` 对 Notes API 的支持以读取为主，不能直接代替本程序的评论认证，当前代码明确要求 `GITLAB_TOKEN`。[S6][S9]

如果要在本地验证 Token，先通过当前 shell 的环境变量准备 `GITLAB_BASE_URL`、`GITLAB_TOKEN`、`REVIEW_PROJECT_ID` 和 `REVIEW_MR_IID`，再执行以下只读探测：

```bash
node --input-type=module <<'JS'
const names = ['GITLAB_BASE_URL', 'GITLAB_TOKEN', 'REVIEW_PROJECT_ID', 'REVIEW_MR_IID'];
for (const name of names) if (!process.env[name]) throw new Error('Missing ' + name);
const base = process.env.GITLAB_BASE_URL.replace(/\/$/, '');
const project = encodeURIComponent(process.env.REVIEW_PROJECT_ID);
const mr = encodeURIComponent(process.env.REVIEW_MR_IID);
const response = await fetch(`${base}/api/v4/projects/${project}/merge_requests/${mr}`, {
  headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN },
  signal: AbortSignal.timeout(10000),
});
console.log('MR metadata HTTP', response.status);
if (!response.ok) process.exitCode = 1;
JS
```

输出 200 只证明能读取该 MR；评论写权限由第一次真实审核验证。不要为了预检查向生产 MR 随意发测试评论。

### 4.2 配置 CI/CD Variables

在**业务仓库** **Settings → CI/CD → Variables** 添加。需要多个仓库共用时由组管理员配置合适范围的组变量，项目级 GitLab Token 通常仍按项目分别提供。

| Key | 必填 | 示例 / 默认 | 敏感 | 说明 |
| --- | --- | --- | --- | --- |
| `CODE_REVIEW_IMAGE` | 是 | `registry.example.com/tools/code-review:runner-v1` | 否 | 第 3 节推送的完整镜像地址 |
| `GITLAB_TOKEN` | 是 | 实际项目/机器人 API Token | 是 | MR API 读取和评论 |
| `OPENAI_API_KEY` | 是 | 实际模型 Key | 是 | Runner 模式不使用设备登录 |
| `CODEX_MODEL` | 是 | 供应方实际支持的模型名 | 否 | 不要直接复制本机可能不可用的模型名 |
| `OPENAI_BASE_URL` | 否 | 留空使用内置官方 API 基址 | 否 | 自定义接口应提供 Responses API，通常基址含 `/v1` |
| `GITLAB_BASE_URL` | 否 | 默认 `CI_SERVER_URL` | 否 | 不添加 `/api/v4`，程序会追加 |
| `FEISHU_ENABLED` | 否 | `false` | 否 | 首次只验证审核可先关闭 |
| `FEISHU_WEBHOOK_URL` | 启用飞书时 | 实际机器人 URL | 是 | 不是模型 API 地址 |
| `FEISHU_SECRET` | 否 | 实际签名密钥 | 是 | 机器人启用签名验证时填写 |
| `FEISHU_MIN_SEVERITY` | 否 | `medium` | 否 | `high`、`medium` 或 `low` |
| `CODEX_REASONING_EFFORT` | 否 | `medium` | 否 | 按模型兼容性选择 |
| `CODEX_TIMEOUT_MS` | 否 | `900000` | 否 | 毫秒；调大时同步调大 Job 超时 |
| `CODEX_MAX_OUTPUT_BYTES` | 否 | `2000000` | 否 | 模型输出上限 |
| `REVIEW_RETRY_NOTIFICATION` | 否 | 默认不设置 | 否 | 临时设为 `true`，重审并重试通知 |
| `DOCKER_AUTH_CONFIG` | 私有镜像按需 | 第 3.5 节 JSON | 是 | 在拉取审核镜像前生效 |

变量类型选择 **Variable**，不是 File。当前程序读取环境变量的实际值，不会自动读取 GitLab File 变量指向的临时文件，也没有 `_FILE` 协议。环境范围通常选 `*`，避免审核 Job 没有匹配 `environment` 而拿不到变量。

不要从本地 `.env` 整份复制配置。Runner 不需要 `DATABASE_PATH`、`WORKSPACE_ROOT`、`HOST`、`PORT`、`GITLAB_WEBHOOK_SECRET`，也不要覆盖 GitLab 自动提供的 `CI_*` 变量。`OPENAI_BASE_URL` 填 API 基址，不追加 `/responses` 或 `/chat/completions`，地址中不放账号密码或 query 密钥。

提示词默认来自审核镜像；不要把本机的绝对路径填入 `CODEX_PROMPT_FILE`，也不要配置服务模式的 `CODEX_PROFILE` 来指向容器里并不存在的本地 profile。

### 4.3 Masked、Protected 与 MR Pipeline

对 Key/Token 使用 Masked（实例支持时可使用 Masked and hidden），关闭不必要的变量展开。Masked 只减少日志泄漏，不能防止有权限修改 CI 脚本的人读取密钥。[S7]

Protected 是独立的访问限制。GitLab 18.1 起提供 MR Pipeline 访问受保护资源的相关控制；官方条件涉及源/目标分支都受保护、同项目，以及发起人具备目标分支所需权限。普通未保护 feature 分支的 MR 不应假定能读取 Protected 变量。旧实例以其自身文档为准。[S10]

满足条件且确实需要此能力时，由 Maintainer/Owner 在 **Settings → CI/CD → Variables → Access protected resources in merge request pipelines** 核对 **Allow merge request pipelines to access protected variables and runners** 设置。仅开启此项不等于未保护的功能分支也能读取受保护变量。[S10]

部署前由项目维护者决定：

| 项目范围 | 可行安排 |
| --- | --- |
| 参与者和 MR 来源均可信的内部项目 | 经维护者确认后，让专用、权限有限的审核凭据在这些 MR Job 中可用，设置合适项目/组范围 |
| 必须保持 Protected 凭据 | 确认当前 MR 满足受保护变量和 Runner 的访问条件，或先在受控分支流程验证 |
| 外部贡献、Fork 或不可信 CI 修改 | 当前模板及代码默认不执行 Fork MR；不要通过解除保护绕过该边界，应另设计受控执行机制 |

镜像里的审核代码和 Codex 子进程环境隔离不能消除“MR 修改 CI 脚本”带来的权限风险。本文不是让所有 MR 自动获得生产密钥的配置方案。

## 5. 给业务仓库接入流水线

### 5.1 场景 A：仓库尚无 CI，只需要代码审核

复制本项目 [完整独立示例](../ci/gitlab-code-review.standalone.yml) 到**业务仓库根目录 `.gitlab-ci.yml`**。不是改本项目工具仓库的根 CI 文件，也不是在 Runner 服务器目录里放 YAML。

完整配置如下（与独立示例保持一致）：

```yaml
workflow:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - when: never

stages:
  - review

code-review:
  stage: review
  image:
    name: "$CODE_REVIEW_IMAGE"
    entrypoint: [""]
  tags:
    - code-review
  needs: []
  dependencies: []
  before_script: []
  after_script: []
  cache: []
  variables:
    GIT_DEPTH: "0"
    GIT_SUBMODULE_STRATEGY: none
    GIT_LFS_SKIP_SMUDGE: "1"
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_MERGE_REQUEST_PROJECT_ID'
    - when: never
  script:
    - node /app/dist/cli/review.js
  timeout: 20m
  interruptible: true
  allow_failure: true
```

此配置只创建 MR 流水线，普通 push、tag、定时任务和页面普通 “Run pipeline” 不会创建审核 Job。不要拿它覆盖已有业务构建和发版配置。

这里使用普通 `review` stage。GitLab 规定流水线只有 `.pre` / `.post` Job 时不会运行，因此“只有一个审核 Job”的仓库不应直接用 `.pre` 模板。[S11]

### 5.2 场景 B：已有构建、测试、发布流水线

从 [增量 Job 模板](../ci/gitlab-code-review.yml) 复制 `code-review` Job，合并到业务仓库现有根 `.gitlab-ci.yml`，保留原有 `stages`、`workflow`、build/test/deploy Job。

增量模板使用 `stage: .pre`、`needs: []`，可在允许的流水线中尽早开始。需要同时做到：

1. 给该 Job 添加 `tags: [code-review]`，或换成实际 Docker Runner 的标签；增量模板本身未固定标签。
2. 确认 **MR 流水线中**还有至少一个正常 stage 的 Job。只有分支/发布流水线里有 build 不够；若 MR 流水线实际只剩审核 Job，应把审核 stage 改成已有普通 stage（如 `test`），或新增 `review` 到现有 stages。
3. 如果已有 `workflow: rules`，把允许 `merge_request_event` 的规则合并到会被匹配的位置，不能放在先匹配的拒绝规则之后。
4. 检查项目级默认 image/tags/services/hooks/artifacts 等继承配置。模板覆盖了 `before_script`、`after_script`、cache 和依赖下载，但不会替你审查所有全局默认行为。

需要添加到已有 `workflow.rules` 的关键规则为：

```yaml
# 合并进原 workflow.rules，不是创建第二个 workflow 节点。
workflow:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    # 下面继续保留原项目应有的 push、tag、schedule 等规则。
```

这段只演示应合并的 MR 规则，不能单独覆盖原生产流水线的完整 `workflow`。

### 5.3 场景 C：多仓库使用中心模板

可将本项目的 Job 模板通过 `include:project` 复用，中心模板的路径、项目名和 `ref` 必须指向已发布且业务项目能读取的版本。以下是“只做审核”的业务仓库完整根配置示例：

```yaml
include:
  - project: tools/code-review
    ref: review-template-v1
    file: /ci/gitlab-code-review.yml

workflow:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - when: never

stages:
  - review

# 覆盖中心模板的 .pre，避免仅有 .pre Job 的流水线不运行。
code-review:
  stage: review
  tags:
    - code-review
```

`review-template-v1` 需要先在中心仓库实际创建，不能保留不存在的示例 ref。对于已有业务流水线，按场景 B 合并，保留原有阶段和触发规则。

根配置直接定义 MR `workflow.rules`：官方 MR Pipeline 文档说明，仅存在于 include 文件里的相关规则不满足根配置的要求。[S10]

### 5.4 校验并提交配置

使用业务仓库的 **Build/CI/CD → Pipeline editor → Validate / CI Lint** 校验完整配置；不同 GitLab 版本菜单名称可能不同。检查展开后的配置中：

- `code-review` 的 `image` 指向 Runner 镜像，而非 service 镜像。
- `tags` 匹配可用 Runner。
- MR 流水线可以创建，Job stage 合法，未被顶层 workflow 拒绝。
- `script` 是 `node /app/dist/cli/review.js`，不调用业务仓库的 `npm install`、`npm run review` 或另一个相对路径脚本。
- `GIT_DEPTH` 为字符串 `"0"`，不覆盖成浅克隆。

提交到受控验证分支后创建真实 MR。界面普通运行分支 Pipeline 的 `CI_PIPELINE_SOURCE=web` 不等于 MR Pipeline；本程序会跳过非 MR 上下文。[S10]

## 6. 第一次真实 MR 验收

### 6.1 先停用同项目旧 Webhook 触发

如果业务项目原先接过常驻审核服务的 Webhook，维护者先停用那条审核 Hook。不要停止其他项目需要的共享服务，也不要删除无关集成。

同一项目同时开 Webhook 和 CI 会造成重复开始评论、并发审核和结果竞争；本项目没有设计跨触发器的全局互斥。

### 6.2 发起测试 MR

在**业务仓库**创建内部验证分支，做一处有意义的小变更并提交，再向目标分支创建 MR。随后打开 MR 的 Pipelines 查看 `code-review` Job。

建议按以下顺序验收：

| 步骤 | 期望证据 | 不满足时定位 |
| --- | --- | --- |
| MR 创建流水线 | 标签为 merge request，能看到审核 Job | workflow / Job rules / 根配置位置 |
| Runner 接单 | Job 从 Pending 进入 Running | Runner 在线、tags、protected 条件 |
| 拉取镜像、检出仓库 | 日志显示正确镜像及 checkout 成功 | Registry 凭据、架构、DNS、CA |
| 开始评论 | MR 出现机器人/等待文案 | `GITLAB_TOKEN`、API 网络、变量可见性 |
| 执行审核 | 运行期间不要求数据库、Webhook 或端口配置 | 是否选错镜像/入口 |
| 结果评论 | MR 出现高/中/低风险结果或“未发现问题” | 模型接口、输出 JSON、评论权限 |
| Job 结束 | 正常完成后退出，不常驻监听 | CLI 超时、模型进程或网络问题 |
| 飞书通知 | 启用且至少一个问题达到阈值时发送摘要 | 阈值、地址、签名、机器人网络 |

正常日志示例：

```text
MR receipt comment: succeeded
Review: succeeded; result comment: <note-id>; Feishu: succeeded
```

没有达到阈值或通知关闭时 `Feishu: skipped` 是正常结果。不能要求每次审核都有飞书消息；不要为了制造高风险结论而要求模型固定返回问题。

### 6.3 确认没有审到后来的提交

对同一 MR 再推一个新提交，GitLab 应创建相应的新 MR Pipeline。程序固定使用该流水线的 source SHA 和 diff base，不从最新 MR API 的 HEAD 替换本次审核对象。最终评论中的提交 SHA 应与对应 Pipeline 一致。

普通 MR 使用 `CI_COMMIT_SHA`；merged result / merge train 使用 `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA`；diff 基点使用 `CI_MERGE_REQUEST_DIFF_BASE_SHA`。缺失对象会报错，不会自动改成当前分支 HEAD。

### 6.4 退出码与流水线颜色

| 情况 | 程序退出码 / 行为 |
| --- | --- |
| 审核及评论成功，飞书发送成功或无需通知 | 0 |
| 审核发现高风险问题 | 仍为 0，结果通过评论和通知反馈 |
| 非 MR 或 Fork Pipeline | 跳过并返回 0；模板也会提前过滤 |
| 缺少配置、Git 快照失败、模型失败、输出 JSON 无效、结果评论失败 | 1 |
| 开始评论失败 | 日志报告，继续后续审核 |
| 飞书失败，但最终结果评论成功 | 保留评论、返回 1 |

模板 `allow_failure: true` 表示审核运行失败也不直接阻止主流水线/合并。它不会把模型结论变成合并门禁；需要门禁是另一项业务需求，不要只看 Pipeline 总体绿色判断模型调用已成功。

## 7. 日常更新、重跑和回滚

### 7.1 配置更新

在业务项目或组的 CI/CD Variables 更新模型名、API 基址、Key 或飞书设置。新 Job 获取其创建/运行上下文中的变量，不会修改已在运行的进程环境。

希望使用新配置时，在 MR 上新建一条 MR Pipeline，再确认变量生效。不要假定对旧 Job 点 Retry 一定能刷新所有创建时已经解析的变量/镜像配置；以实际新 Job 配置为准。

### 7.2 更新审核代码或提示词

1. 在工具仓库修改、验证代码或提示词。
2. 使用 `--target runner` 构建新版本，例如 `runner-v2`，推送并记录 digest。
3. 将业务项目的 `CODE_REVIEW_IMAGE` 切到新版本，或在 YAML 里更新固定镜像地址。
4. 创建新的验证 MR Pipeline，确认开始评论、结果评论及通知。

Runner 会按 Job image 拉镜像，不需要 SSH 到服务器执行 `docker run` 启动审核服务，也不需要 `docker compose up`。Runner 镜像没有业务数据卷可迁移。

### 7.3 只重跑审核 / 重试飞书

同一 SHA 已有最终结果评论时，普通重跑仍发开始评论，但随后可能显示 `Review: skipped`，不重复模型调用和最终评论。

需要重新执行模型并重试飞书时，临时将 `REVIEW_RETRY_NOTIFICATION=true` 注入新的 MR Job。程序会重新审核、保留已有最终评论、按阈值再次通知；验证后移除该变量，避免后续所有重跑都重复通知。

因为没有数据库，Runner 不保存“上一次只有飞书失败”的本地状态。这个开关是显式重试策略，不是仅重发已缓存的审核正文。

### 7.4 回滚和暂停

| 操作 | 方式 |
| --- | --- |
| 回滚审核程序 | `CODE_REVIEW_IMAGE` 改回上一可用版本，并创建新的 MR Pipeline |
| 回滚 CI 模板 | 根配置回退到上一审核模板 commit/tag，保留其他业务 CI |
| 暂停一个项目审核 | 在该项目停用/移除审核 Job 的触发规则；不要停掉共享 Runner 上所有项目的任务 |
| 暂停专用 Runner | 在 GitLab Runner 页面 Pause，已有 Job 按管理策略处理 |

无需数据库回滚。若要恢复 Webhook 服务模式，再按原服务部署和数据挂载文档恢复，切换时确保同项目不同时触发两套审核。

## 8. 常见故障定位

按 Job 实际失败阶段排查，而不是只看 MR 有没有评论：

| 现象 / 日志 | 常见原因 | 检查与处理 |
| --- | --- | --- |
| 没有 MR Pipeline | 根 workflow 不允许 MR；只有 include 里的 MR 规则 | 按第 5 节合并根配置；从 MR 页面触发 |
| Pipeline 不运行，只有审核 `.pre` | 整条 MR 流水线没有普通 stage 的 Job | 使用独立模板 `review` stage 或合法已有 stage |
| 审核 Job 长期 Pending | tags 不匹配、Runner 离线/暂停、protected 条件或资源不足 | 检查 Runners 页面、Job tags 和权限范围 |
| `image` 为空或 invalid reference | `CODE_REVIEW_IMAGE` 未注入、拼错或被 Protected 限制 | 检查变量名、作用域、真实镜像地址 |
| `pull access denied` / registry 401 | Runner 拉镜像凭据无效或跨项目权限不足 | 检查 `DOCKER_AUTH_CONFIG`、registry 主机端口、Job Token allowlist |
| `no matching manifest` / `exec format error` | 镜像 CPU 架构与 Runner 不一致 | 按第 3.2 节重建对应架构镜像 |
| Job 启动后一直运行 Web 服务 | 构建了 service 目标或执行了 server 入口 | 使用 `--target runner` 和绝对 CLI 路径 |
| `GITLAB_TOKEN is required` | Token 没配置、变量是 File 类型或 MR 取不到 Protected 变量 | 按第 4 节检查，不打印变量值 |
| `OPENAI_API_KEY` / `CODEX_MODEL is required` | 模型配置未注入 | 用 Variable 类型在业务项目/组配置，确认新 MR Job 可读 |
| GitLab 401 | API Token 失效/过期、使用了错误 Token | 核对评论 Token，不使用 runner authentication token 替代 |
| GitLab 403 / 404 | 项目范围或角色不匹配；MR 项目/IID 不正确；无权访问时也可能表现 404 | 核对目标业务项目和 Token 权限 |
| `Pipeline commit is missing` | 浅克隆、base/source 对象未获取、上游历史被重写 | 确认展开配置 `GIT_DEPTH: "0"`，必要时全新 clone 或新 MR Pipeline，不强行替换 SHA |
| `Runner mode requires a merge request pipeline` / `Skipped: not ...` | 普通分支、web、schedule、parent pipeline 上下文 | 从 MR 创建正确的 MR Pipeline；当前程序不支持任意下游上下文猜测 MR |
| Fork 被跳过 | 当前默认边界 | 使用同项目可信分支验证，不解除密钥边界绕过 |
| `CODEX_PROFILE` / 提示词文件缺失 | 沿用了本机路径、profile，镜像没有相应文件 | 移除无效覆盖，使用镜像默认提示词和 API Key |
| `codex: not found` | 旧/错误镜像，不含 Codex | 用第 3.3 节检查并确认 `CODE_REVIEW_IMAGE` 指向新镜像 |
| 模型 401 / 403 / 404 | Key、API 基址、模型名、服务权限不正确 | 确认供应方协议及 Responses 支持，不把完整 endpoint 当 base URL |
| 模型输出不是 JSON | 模型/网关兼容性或提示词输出不符合规则 | 查看错误阶段、确认模型配置；不要把错误当审核通过 |
| `MR diff exceeds ...` | MR diff 超过当前 2,000,000 字节上下文上限 | 拆分 MR；这是代码设定的输入上限，`CODEX_MAX_OUTPUT_BYTES` 只调整输出上限 |
| TLS / DNS / connection timeout | Job 容器与宿主机网络环境不同或缺少企业 CA | 在对应层修复 DNS、路由、代理、CA；不关闭 TLS 校验 |
| 第一条开始评论成功，后面没有结果 | 开始评论仅证明评论 API 可用，后续代码或模型步骤仍会失败 | 打开 Job 日志定位，不把开始评论当完成标志 |
| `Feishu: skipped` | 关闭通知或无问题达到阈值 | 对照变量和实际审核结果，这是可能的正常情况 |
| Job failed 但 MR 已有结果 | 后续飞书失败 | 保留结果，修复飞书后显式重试通知 |
| 同一 MR 出现两套审核 | Webhook 和 CI 同时启用，或业务根 CI 重复定义触发 | 停用该项目旧审核 Hook / 重复 Job |

本程序的普通去重检查只读取最近一页（最多 100 条）MR Note，且没有跨 Job 的原子互斥；极高评论量或并发执行同一 SHA 时，不应把它视为严格的 exactly-once 保证。

## 9. 部署验收记录模板

部署负责人完成后填写，不能用本地单元测试结果代替实际生产证据：

| 项目 | 实际值 / 结果 |
| --- | --- |
| GitLab 地址和版本 | 待填写 |
| 业务项目、验证 MR 地址 | 待填写 |
| Runner 名称、版本、executor、tags | 待填写 |
| 镜像地址、版本、digest、本项目 Git 提交 | 待填写 |
| CI 模板 commit/tag | 待填写 |
| 非敏感变量：模型名、API 基址、通知开关/阈值 | 待填写；不记录密钥值 |
| MR Pipeline / Job 地址 | 待填写 |
| 开始评论、最终结果评论 | 待填写评论链接 |
| 结果提交 SHA 与流水线匹配 | 待确认 |
| 飞书发送或 skipped 原因 | 待填写 |
| Job 按预期退出、无数据库/服务进程要求 | 待确认 |
| 同项目旧审核 Hook 已停用 | 待确认 |
| 回滚版本及维护者 | 待填写 |

## 10. 本仓库配套文件

| 文件 | 用途 |
| --- | --- |
| [Dockerfile](../Dockerfile) | `runner` 和 `service` 构建目标 |
| [独立 CI 示例](../ci/gitlab-code-review.standalone.yml) | 业务仓库只执行审核时的完整根配置 |
| [增量 Job 模板](../ci/gitlab-code-review.yml) | 合并到已有流水线，注意普通 stage 和 tags |
| [Runner 模式与程序行为](gitlab-runner.md) | 上下文、退出码、无状态策略 |
| [离线验证脚本](../scripts/smoke-runner.mjs) | 编译后 Runner 打包与模拟端到端验证 |
| [常驻服务部署说明](deployment.md) | 需要 Web 后台/数据库时使用，非本文模式 |

## 11. 官方资料与核对范围

本手册于 2026-10-24 根据仓库实现和以下 GitLab 官方文档整理。企业自建实例请优先以其实际版本的 UI、管理员策略和版本对应文档为准。

- [S1：Docker executor](https://docs.gitlab.com/runner/executors/docker/)
- [S2：Runner 注册与 authentication token](https://docs.gitlab.com/runner/register/)
- [S3：创建和管理项目 Runner](https://docs.gitlab.com/ci/runners/runners_scope/)
- [S4：用 Docker 部署 GitLab Runner 管理进程](https://docs.gitlab.com/runner/install/docker/)
- [S5：Job 镜像和私有镜像拉取认证](https://docs.gitlab.com/ci/docker/using_docker_images/)
- [S6：CI Job Token 支持的 API](https://docs.gitlab.com/ci/jobs/ci_job_token/)
- [S7：CI/CD Variables](https://docs.gitlab.com/ci/variables/)
- [S8：项目访问令牌](https://docs.gitlab.com/user/project/settings/project_access_tokens/)
- [S9：MR Notes API](https://docs.gitlab.com/api/notes/)
- [S10：MR Pipeline 触发、根配置和受保护资源](https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/)
- [S11：YAML stage、`.pre` 与 Job 配置](https://docs.gitlab.com/ci/yaml/)
