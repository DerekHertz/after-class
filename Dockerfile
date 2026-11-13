# Replay-mode backend for the hosted skeleton. Build for Fargate ARM:
#   docker build --platform linux/arm64 -t after-class .
# Bun 1.4.3 matches CI. The digest pins the multi-arch index of oven/bun:1.4.3-slim.
# Dependencies install in a stage that runs on the build machine, so an ARM image builds on an x86 runner without
# emulation. The three production dependencies are pure JavaScript, so the node_modules folder is the same on both.
ARG BUN_IMAGE=oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288

FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
RUN mkdir -p /skeleton/data/db /skeleton/data/config

FROM ${BUN_IMAGE}
WORKDIR /app
COPY --from=deps --chown=bun:bun /skeleton/data /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bunfig.toml tsconfig.json ./
COPY src/shared ./src/shared
COPY src/backend ./src/backend
COPY scripts/build-app.ts ./scripts/build-app.ts

# Replay mode has no keys file. The container binds every interface for the load balancer, relaxes the Host check for
# GET /health only, and skips building the review app, which is not served from here.
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
