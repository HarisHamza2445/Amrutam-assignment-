# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY docs/openapi.yaml ./docs/openapi.yaml

USER node
EXPOSE 4000

# tini forwards SIGTERM properly so graceful shutdown works
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
