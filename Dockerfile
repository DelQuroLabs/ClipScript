# ClipScript Studio — production image (Coolify / any Docker host)
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm test && npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATABASE_FILE=/data/clipscript.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY lib ./lib
RUN mkdir -p /data && chown -R node:node /data
USER node
# Persistent data lives in /data. Mount a named volume there (Coolify: Persistent Storage → Volume Mount → /data).
# No anonymous VOLUME here on purpose: it would be recreated empty on redeploy and hide a missing mount.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
