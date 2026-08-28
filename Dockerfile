FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# -- workspace install --
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/relay/package.json apps/relay/
COPY apps/agent/Cargo.toml apps/agent/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN npm install --workspace=@deskos/api --workspace=@deskos/web --workspace=@deskos/relay --workspace=@deskos/shared --workspace=@deskos/ui --include=dev

# npm hoists shared deps to the root; ensure per-workspace node_modules dirs
# exist so the prod-stage COPY below is deterministic.
RUN mkdir -p apps/api/node_modules apps/relay/node_modules

# -- build --
COPY . .
# The Windows helper and Android APK are produced by the deployment workflow.
# Keep the copies optional so generic Docker/tag builds still work, while
# production deploys can verify that both artifacts were included before
# going live.
RUN mkdir -p /tmp/reydesk-helper /tmp/reydesk-apk && if [ -f artifacts/windows/reydesk-helper.exe ]; then cp artifacts/windows/reydesk-helper.exe /tmp/reydesk-helper/reydesk-helper.exe; fi && if [ -f artifacts/android/reydesk-agent.apk ]; then cp artifacts/android/reydesk-agent.apk /tmp/reydesk-apk/reydesk-agent.apk; fi
RUN npm run build --workspace=@deskos/web
RUN npm run build --workspace=@deskos/api
RUN npm run build --workspace=@deskos/relay

# -- production --
FROM node:20-slim AS prod
WORKDIR /app
COPY --from=base /app/apps/api/dist apps/api/dist
COPY --from=base /app/apps/web/dist apps/web/dist
COPY --from=base /app/apps/relay/dist apps/relay/dist
# Always copy the directories; they are empty for generic builds and contain
# the portable helper + Android APK for the production deployment workflow.
COPY --from=base /tmp/reydesk-helper artifacts/windows
COPY --from=base /tmp/reydesk-apk artifacts/android
COPY --from=base /app/node_modules node_modules
COPY --from=base /app/apps/api/node_modules apps/api/node_modules
COPY --from=base /app/apps/relay/node_modules apps/relay/node_modules
COPY --from=base /app/apps/api/package.json apps/api/
COPY --from=base /app/apps/relay/package.json apps/relay/

WORKDIR /app/apps/api
ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD ["node", "dist/index.js"]
