# Strata application image, for the Ubuntu target only (DD-027).
#
# Three stages so the runtime image carries production dependencies and compiled
# JS but no toolchain: no TypeScript, no vitest, no pnpm store.

FROM node:22-alpine AS base
WORKDIR /app
# corepack pins pnpm to package.json's `packageManager` field, so the image and
# the Mac build with the same pnpm (DD-031: pnpm only, never npm).
RUN corepack enable

# Production dependencies, resolved from the lockfile alone. Kept in its own stage
# so a source edit does not invalidate the install layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM base AS build
# pnpm-workspace.yaml carries `allowBuilds: esbuild`. Without it pnpm 11 aborts the
# install with ERR_PNPM_IGNORED_BUILDS rather than merely skipping the script.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# `build` also copies src/db/migrations into dist — migrate() reads them from disk
# at boot, so omitting them yields a container that starts and then cannot migrate.
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Required at runtime, not just for scripts: without `"type": "module"` Node parses
# dist/*.js as CommonJS and every import fails.
COPY package.json ./
USER node

# Exec form, so PID 1 is node itself and SIGTERM reaches the shutdown handlers in
# src/mcp/stdio.ts rather than a shell that ignores it.
CMD ["node", "dist/main.js"]
