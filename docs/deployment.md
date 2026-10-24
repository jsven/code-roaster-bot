# 线上部署与配置注入

本文说明常驻服务模式。若部署目标是 GitLab CI/CD 中的一次性审核任务，请构建 `Dockerfile --target runner`，并参考 [GitLab Runner 模式](gitlab-runner.md)；该模式无需启动 Web 服务、挂载数据目录或配置数据库。

本项目通过环境变量读取 GitLab、模型 API、飞书及数据目录配置。部署时使用服务器的配置文件注入容器；镜像中不保存密钥，也不需要复制本地开发 `.env` 到镜像。

## docker run

以下以服务器部署目录 `/opt/code-review` 为例，该目录可以换成实际部署目录。请先将本次代码构建的镜像推送到镜像仓库并在服务器拉取，或通过 `docker save` / `docker load` 传输。下面命令以服务器已有的 `code-review:local` 标签为例，部署时替换为实际镜像名和版本。

服务器上准备以下文件：

```text
/opt/code-review/
├── production.env      # 服务器配置文件，包含实际密钥
└── data/               # SQLite 文件和审核仓库工作区
```

创建数据目录，将 `deploy/production.env.example` 模板复制到服务器的 `/opt/code-review/production.env`，填写实际配置：

```bash
mkdir -p /opt/code-review/data
# 将模板复制到 /opt/code-review/production.env，填写实际值后：
chmod 600 /opt/code-review/production.env
```

至少需要配置 `GITLAB_BASE_URL`、`GITLAB_TOKEN`、`GITLAB_WEBHOOK_SECRET`、`OPENAI_API_KEY` 和接口支持的 `CODEX_MODEL`。使用自定义 API 服务时填写 `OPENAI_BASE_URL`。模板中的数据库路径和工作区路径是容器内路径，保持 `/app/data/...`，宿主机路径通过挂载指定。

```bash
docker run -d \
  --name code-review \
  --init \
  --restart unless-stopped \
  --env-file /opt/code-review/production.env \
  --mount type=bind,source=/opt/code-review/data,target=/app/data \
  -p 3000:3000 \
  code-review:local
```

`--env-file` 把文件中的 `KEY=value` 设置为容器进程的环境变量。这个文件由 Docker 客户端读取，无需挂载到容器。`--mount` 则把宿主机数据目录挂载给容器，两者用途不同。

配置文件使用实际字面值，不加 `export`，不要使用 `${OTHER_VARIABLE}` 插值。`docker run --env-file` 不像 Compose 那样解析变量引用。不要把真实配置提交到 Git，也不要将完整的容器环境变量输出到日志。

确认服务：

```bash
docker logs --tail 100 code-review
curl --fail http://127.0.0.1:3000/health
```

`/health` 仅检查服务存活；GitLab 仓库和评论权限、模型接口可用性仍需用一次真实 MR 审核确认。

## 更新配置

容器环境变量在创建时注入。修改服务器的 `production.env` 后，需要停止并重建容器；单独执行 `docker restart` 不会重新读取这个文件。

确认没有正在执行的审核后，使用：

```bash
docker stop code-review
docker rm code-review
# 再次执行前面的 docker run 命令
```

绑定挂载的 `/opt/code-review/data` 会保留。若现有容器未挂载数据目录，应先停止服务并用 `docker cp` 备份原 `/app/data`，再切换到挂载部署，避免将原数据留在即将移除的容器中。

## Compose

现有 `compose.yaml` 已配置：

```yaml
env_file:
  - .env
```

在服务器的 Compose 文件同目录放服务器自己的 `.env` 即可注入。`env_file` 才是这里将变量传入容器的设置；不要把命令行 `docker compose --env-file ...` 的插值文件与服务的 `env_file` 混淆。现有 Compose 的数据目录为文件旁的 `./data`。

首次使用源代码构建并启动：

```bash
docker compose up -d --build
```

只修改配置时：

```bash
docker compose up -d --force-recreate
```

## 部署平台

如果通过 CI/CD 或容器部署平台运行，也可以在平台的环境变量或密钥配置中提供相同变量名，由平台在创建容器时注入。本项目当前读取环境变量，不会自动读取 Docker secrets 的 `/run/secrets/*` 文件，也没有 `_FILE` 配置支持；使用这类文件密钥机制时需要额外接入。

Docker 文档参考：

- https://docs.docker.com/reference/cli/docker/container/run/
- https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/
