# 工程目录与职责

本项目按业务模型、应用编排、基础设施、HTTP 接口分层。保持现有 Node.js、Fastify、SQLite 和服务行为，按实际职责组织代码。

```text
code-review/
├── db/                           # 数据库版本脚本与维护规范
│   ├── migration-history.sql
│   └── migrations/
├── public/
│   └── styles.css                # 页面样式，通过 /assets/styles.css 提供
├── prompts/                      # Codex 审核提示词
├── scripts/                      # 构建辅助脚本
├── src/
│   ├── server.ts                 # 进程启动、监听、退出
│   ├── bootstrap/                # service 装配数据库和 Worker；runner 装配无状态审核
│   ├── cli/                      # migrate 数据库迁移；review 单次 CI 审核
│   ├── config/                   # 环境配置与运行资源路径
│   ├── domain/                   # 任务模型、审核结果规则
│   ├── application/              # 共用无状态审核流程、服务编排、Worker、评论格式、依赖接口
│   ├── infrastructure/
│   │   ├── database/             # SQLite 连接、迁移执行、任务队列持久化
│   │   ├── gitlab/               # GitLab API 适配
│   │   ├── codex/                # 本地 Codex 进程适配
│   │   ├── feishu/               # 飞书通知适配
│   │   └── git/                  # clone、fetch、工作区和 diff
│   └── http/
│       ├── app.ts                # Fastify 应用和路由装配
│       ├── routes/               # Webhook、审核任务、健康检查、静态资源
│       ├── schemas/              # HTTP 查询参数校验和转换
│       └── views/                # 页面布局、任务列表、任务详情
├── test/                         # 按职责对应 src；integration 为装配流程测试
├── ci/                           # 被审核业务仓库使用的 GitLab Job 模板
├── docs/                         # 设计文档与工程规范
├── data/                         # 本地 SQLite 和仓库工作区，不提交
├── tsconfig.json                 # 源码与测试的类型检查
└── tsconfig.build.json           # 仅构建 src，产物放到 dist
```

## 依赖方向

- `domain` 定义任务和审核结果规则，不依赖 HTTP、数据库或外部客户端。
- `application` 依赖业务模型及 `ports.ts` 中定义的接口，负责任务编排；Worker 不直接依赖 SQLite 实现。
- `infrastructure` 实现应用接口，收纳 SQL 查询、网络请求、Git 和进程调用。
- `http` 处理协议、参数校验和页面输出，通过应用接口访问队列，不直接执行 SQL。
- `bootstrap` 是具体实现的装配入口；`server.ts` 只处理进程生命周期，维护命令单独放在 `cli`。

新增外部服务适配器时，先在 `application/ports.ts` 定义需要的接口，再在 `infrastructure` 中实现并由 `bootstrap` 装配。新增路由放进对应 `http/routes` 文件，页面放入 `http/views`，避免重新集中到单个入口文件中。

## 数据库变更

结构变更通过 `db/migrations` 中的 SQL 文件执行，连接类不包含建表语句。新增变更追加版本文件，历史版本不可修改。旧库接入、事务、校验和维护命令见 [数据库规范](../db/README.md)。

## 构建与运行资源

`npm run build` 清理旧 `dist` 后仅编译 `src`，入口为 `dist/server.js`，不再把测试文件放入生产产物。`npm run typecheck` 仍同时检查源码和测试。

服务模式生产部署需要保留同一级下的 `dist/`、`db/`、`public/`、`prompts/`、`package.json`、锁文件以及生产依赖。SQL 和 CSS 按模块位置解析项目根目录，源码运行与构建后运行使用相同资源，避免依赖启动命令所在目录。`DATABASE_PATH`、`WORKSPACE_ROOT` 和显式配置的提示词路径仍按现有配置语义解析。

Dockerfile 已复制数据库脚本和静态资源，并使用新的构建入口；`.dockerignore` 排除本地依赖、数据库、凭据文件及 Git 元数据。

Dockerfile 提供 `service`（默认）和 `runner` 两个运行目标。`runner` 仅复制单次审核需要的原生 Node.js 模块代码与提示词，不复制数据库脚本、HTTP 页面或安装应用运行依赖。它通过 `src/cli/review.ts` → `src/bootstrap/runner.ts` → `src/application/review-execution.ts` 完成审核，不进入 `bootstrap/service.ts`。

`review-execution.ts` 是两种模式共享的无状态核心，服务模式由 `review-orchestrator.ts` 通过回调更新任务持久化状态，Runner 则直接使用执行结果和进程退出码；不通过“内存假队列”复用服务流程。详见 [Runner 模式说明](gitlab-runner.md)。
