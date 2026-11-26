FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/setup.ts ./scripts/setup.ts
COPY admin ./admin
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/admin/dist ./admin/dist
COPY --from=build /app/apps/web/public ./apps/web/public
COPY database/migrations ./database/migrations
USER node
CMD ["node", "dist/apps/api/src/main.js"]
