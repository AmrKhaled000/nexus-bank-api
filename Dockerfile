# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npx prisma generate \
  && npm run build \
  && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nexus && adduser -S nexus -G nexus
COPY --from=build --chown=nexus:nexus /app/node_modules ./node_modules
COPY --from=build --chown=nexus:nexus /app/dist ./dist
COPY --chown=nexus:nexus package.json ./
COPY --chown=nexus:nexus prisma ./prisma
USER nexus
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]
