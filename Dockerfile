FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY prompts ./prompts
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/data/workspaces
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
