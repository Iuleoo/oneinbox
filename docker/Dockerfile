# Base image is overridable so mirrors can be used on hosts without Docker Hub access:
#   NODE_IMAGE=docker.m.daocloud.io/library/node:20-slim docker compose build
ARG NODE_IMAGE=node:20-slim

# ── build ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
# Debian apt mirror host (e.g. mirrors.ustc.edu.cn). Default = official.
ARG APT_MIRROR=deb.debian.org
# npm registry (e.g. https://registry.npmmirror.com/). Default = official.
ARG NPM_REGISTRY=https://registry.npmjs.org/
# Mirror for better-sqlite3 prebuilt binaries (empty = GitHub releases).
ARG SQLITE_PREBUILD_MIRROR=

# BuildKit cache mounts: apt package cache and the pnpm store survive between builds, so a
# code-only change no longer re-downloads the toolchain and every dependency (~3 min saved).
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
 && if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates

ENV npm_config_registry=${NPM_REGISTRY} \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
RUN npm install -g pnpm@10

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm config set store-dir /root/.local/share/pnpm/store \
 && if [ -n "$SQLITE_PREBUILD_MIRROR" ]; then \
      export npm_config_better_sqlite3_binary_host_mirror="$SQLITE_PREBUILD_MIRROR"; \
    fi \
 && pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm -r build
RUN pnpm --filter @inbox/server deploy --prod --legacy /out

# ── runtime ───────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=build /out .
COPY --from=build /app/packages/server/drizzle ./drizzle
COPY --from=build /app/packages/web/dist ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 WEB_DIST=/app/public
VOLUME ["/data"]
EXPOSE 8080
# No wget/curl in slim; use node's built-in fetch for the health probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# PID 1 handling is provided by `init: true` in docker-compose.yml (or `docker run --init`).
CMD ["node", "dist/index.js"]
