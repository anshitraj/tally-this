# Optional local container; production frontend uses Vercel.
# Build from the repository root: docker build -f frontend/Dockerfile .
FROM node:22-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY frontend ./frontend
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/finverify-os run build

FROM nginx:alpine
COPY --from=builder /repo/frontend/dist/public /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
