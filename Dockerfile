# Multi-stage Next.js build. Mirrors payroll-rebuild's Dockerfile so
# the deploy + observability story is a single learned playbook.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown) \
    && BUILD_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
    && echo "Building $GIT_SHA at $BUILD_AT" \
    && BUILD_GIT_SHA=$GIT_SHA BUILD_AT=$BUILD_AT npm run build \
    && echo "$GIT_SHA" > /app/.git-sha \
    && echo "$BUILD_AT" > /app/.build-at

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# postgresql-client + gzip → pg_dump for the admin "Take snapshot"
# action. The compose stack's db service exposes 5432 over the
# internal Docker network; pg_dump connects via DATABASE_URL.
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-client \
      gzip \
    && rm -rf /var/lib/apt/lists/*

ARG BUILD_GIT_SHA=dev
ARG BUILD_GIT_BRANCH=unknown
ARG BUILD_AT=unknown
ENV BUILD_GIT_SHA=$BUILD_GIT_SHA
ENV BUILD_GIT_BRANCH=$BUILD_GIT_BRANCH
ENV BUILD_AT=$BUILD_AT

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/.git-sha /app/.git-sha
COPY --from=build /app/.build-at /app/.build-at
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/lib ./lib
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 3000 9464
CMD ["sh", "-c", "node ./node_modules/.bin/tsx ./scripts/migrate.ts && node ./node_modules/.bin/tsx ./scripts/seed.ts && node ./server.js"]
