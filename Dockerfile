# ---- 1. Build the React client ----
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- 2. Install server production dependencies ----
FROM node:22-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- 3. Runtime ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=5000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src
COPY --from=client /app/client/dist ./client/dist
# DATA_DIR holds crash.log (and db.json only in non-production runs); owned by the unprivileged node user.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/readyz || exit 1
# node is PID 1 here, so SIGTERM from "docker stop" reaches the graceful-shutdown handler directly.
CMD ["node", "server/src/index.js"]
