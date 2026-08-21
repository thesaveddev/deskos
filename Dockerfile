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
RUN npm run build --workspace=@deskos/web
RUN npm run build --workspace=@deskos/api
RUN npm run build --workspace=@deskos/relay

# -- production --
FROM node:20-slim AS prod
WORKDIR /app
COPY --from=base /app/apps/api/dist apps/api/dist
COPY --from=base /app/apps/web/dist apps/web/dist
COPY --from=base /app/apps/relay/dist apps/relay/dist
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
