# 数据库脚本规范

数据库使用 SQLite。所有建表、索引及后续结构变更脚本统一放在本目录，TypeScript 中的数据库连接类只负责连接、PRAGMA 配置和调用迁移器。

```text
db/
├── migration-history.sql          # 迁移版本记录表
└── migrations/
    ├── 001_initial_schema.sql     # 原有业务表及队列索引
    └── 002_review_list_indexes.sql # 列表分页、仓库/时间筛选索引
```

服务启动时自动按版本号执行待应用脚本，也可以单独执行：

```bash
npm run db:migrate
# 构建后的生产环境
npm run db:migrate:prod
```

维护命令只需要 `DATABASE_PATH`，不需要 GitLab、Codex 或飞书配置。默认数据库路径仍为 `data/reviews.db`。

迁移器通过 `schema_migrations` 保存版本号、文件名、SHA-256 校验值和执行时间；已执行脚本不会重复运行。旧版数据库没有迁移记录时，`001` 使用 `IF NOT EXISTS` 接入现有表，`002` 补充索引，保留已有任务。

新增结构变更时，追加形如 `003_add_review_field.sql` 的文件，版本号必须唯一且递增。已应用的文件不得修改、改名或删除，需要修正时追加新迁移。空目录、文件命名错误、版本重复、旧脚本缺失或校验不匹配会阻止启动。

迁移器在 `BEGIN IMMEDIATE` 事务中读取历史并执行本轮全部待应用脚本，防止多个进程重复执行。任何脚本失败，本轮新增结构及版本记录一起回滚，服务不会带着部分升级的数据库启动。SQL 文件中不要自行加入事务控制语句，也不要放入不能在事务中执行的操作（例如 `VACUUM`）。

业务查询和状态更新的参数化 SQL 放在 `src/infrastructure/database/review-queue.ts`，与连接管理、结构迁移分开维护。数据库文件、WAL 文件及仓库工作区仍放在 `data/`，不进入版本库。
