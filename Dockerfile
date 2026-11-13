# Replay-mode backend for the hosted skeleton. Build for Fargate ARM:
#   docker build --platform linux/arm64 -t after-class .
# Bun 1.4.3 matches CI. The digest pins the multi-arch index of oven/bun:1.4.3-slim.
# Dependencies install and the review app bundles in stages that run on the build machine, so an ARM image builds on an
# x86 runner without emulation. The production dependencies are pure JavaScript, so node_modules and the bundle are the
# same on both architectures.
ARG BUN_IMAGE=oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288

FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
RUN mkdir -p /skeleton/data/db /skeleton/data/config

# scripts/build-app.ts bundles src/app into dist/app. The server serves that folder under /app/.
FROM deps AS app
COPY tsconfig.json ./
COPY src/shared ./src/shared
COPY src/app ./src/app
COPY scripts/build-app.ts ./scripts/build-app.ts
RUN bun run scripts/build-app.ts

FROM ${BUN_IMAGE}
WORKDIR /app
COPY --from=deps --chown=bun:bun /skeleton/data /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bunfig.toml tsconfig.json ./
COPY src/shared ./src/shared
COPY src/backend ./src/backend
COPY scripts/build-app.ts ./scripts/build-app.ts
COPY --from=app /app/dist/app ./dist/app

# Replay mode has no keys file. The container binds every interface for the proxy and relaxes the Host check for
# GET /health only. The review app is already bundled into dist/app, so the server does not build it at start.
ENV AFTERCLASS_MODE=replay \
    AFTERCLASS_HOST=0.0.0.0 \
    AFTERCLASS_PORT=8080 \
    AFTERCLASS_HEALTH_ANY_HOST=1 \
    AFTERCLASS_BUILD_APP=0 \
    AFTERCLASS_DATA=/data/db \
    AFTERCLASS_CONFIG_DIR=/data/config

USER bun
EXPOSE 8080
CMD ["bun", "run", "src/backend/main.ts"]
