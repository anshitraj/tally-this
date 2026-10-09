# Build from the repository root: docker build -f backend/api/Dockerfile .
FROM node:22-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY backend/api ./backend/api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build
# Keep external runtime dependencies, including AWS SDK and PDF assets.
RUN pnpm --filter @workspace/api-server deploy --prod --legacy /runtime

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tesseract-ocr poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p uploads && chown node:node uploads
COPY --from=builder --chown=node:node /runtime ./
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
