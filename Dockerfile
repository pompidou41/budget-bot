# syntax=docker/dockerfile:1
# Build for the server's architecture (scripts/deploy-docker.sh does it):
#   docker buildx build --platform linux/amd64 -t budget-bot:<sha> .
# Pin the digest once: NODE_IMAGE=node:24-bookworm-slim@sha256:<docker buildx imagetools inspect node:24-bookworm-slim>.
ARG NODE_IMAGE=node:24-bookworm-slim

# Yarn classic 1.x ships with the official node image; the lockfile is v1.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# MEMO_API_HOST=0.0.0.0 is for the container network only: compose publishes the port on the
# host's 127.0.0.1, and the API still requires its bearer token.
ENV NODE_ENV=production \
    MEMO_API_HOST=0.0.0.0
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets ./assets
# Files stay root-owned and read-only; only the mounted data/ is writable by the app user.
# Numeric UID/GID: unique per app on the host so one app cannot read another's data.
USER 1104:1104
CMD ["node", "dist/index.js"]
