# One image for two jobs: `init` runs infra/init.mjs, `web` builds and serves
# the app. The build happens when `web` starts, not here, so the image (and
# therefore `init`) works before any app code exists.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
# Node 24 ships Corepack, which fetches exactly this pnpm version.
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
EXPOSE 8080