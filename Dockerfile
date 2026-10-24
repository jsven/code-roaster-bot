FROM node:20-bookworm-slim

WORKDIR /app

ARG CODEX_CLI_VERSION=0.154.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_CLI_VERSION}

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY db ./db
COPY public ./public
COPY prompts ./prompts
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/data/workspaces
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server.js"]
