FROM node:20-bookworm-slim AS base

WORKDIR /app

ARG CODEX_CLI_VERSION=0.154.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_CLI_VERSION}

FROM base AS build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

# CI image: only the one-shot review workflow and native Node.js modules.
# No Fastify, better-sqlite3, application database scripts, UI, or data volume.
FROM base AS runner
COPY package.json ./
COPY --from=build /app/dist/cli/review.js ./dist/cli/review.js
COPY --from=build /app/dist/bootstrap/runner.js ./dist/bootstrap/runner.js
COPY --from=build /app/dist/config ./dist/config
COPY --from=build /app/dist/domain ./dist/domain
COPY --from=build /app/dist/application/ports.js ./dist/application/ports.js
COPY --from=build /app/dist/application/review-execution.js ./dist/application/review-execution.js
COPY --from=build /app/dist/application/review-note.js ./dist/application/review-note.js
COPY --from=build /app/dist/application/review-received.js ./dist/application/review-received.js
COPY --from=build /app/dist/infrastructure/codex ./dist/infrastructure/codex
COPY --from=build /app/dist/infrastructure/gitlab ./dist/infrastructure/gitlab
COPY --from=build /app/dist/infrastructure/feishu ./dist/infrastructure/feishu
COPY --from=build /app/dist/infrastructure/git/runner-workspace.js ./dist/infrastructure/git/runner-workspace.js
COPY prompts ./prompts
ENV NODE_ENV=production
CMD ["node", "/app/dist/cli/review.js"]

# Default target preserves the existing long-running service deployment.
FROM base AS service
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db ./db
COPY public ./public
COPY prompts ./prompts
RUN mkdir -p /app/data/workspaces
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server.js"]
