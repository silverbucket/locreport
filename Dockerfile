# syntax=docker/dockerfile:1

# --- build stage: compile TypeScript -> dist ---
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: the image only runs `tsc` here and `node` at runtime, so no
# dependency's native build step (e.g. esbuild) is needed. It also avoids pnpm's
# non-interactive ERR_PNPM_IGNORED_BUILDS failure on unapproved build scripts.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# --- runtime stage ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=4317 \
    LOCREPORT_CACHE_DIR=/cache
WORKDIR /app

# git is required to clone/analyze; cloc gives the more accurate counter.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git cloc ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable

# Production dependencies only (includes chart.js, which the server self-hosts).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY public ./public
COPY --from=build /app/dist ./dist

# Persistent cache dir, owned by the unprivileged runtime user.
RUN mkdir -p /cache && chown -R node:node /cache
VOLUME ["/cache"]
USER node
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/server.js"]
