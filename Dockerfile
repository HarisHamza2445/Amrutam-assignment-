# ---- deps ----
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----
FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app

# npm/corepack aren't needed at runtime and only add attack surface (and CVEs) to the image
RUN apk add --no-cache tini \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
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
