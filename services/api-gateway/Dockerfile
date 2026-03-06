# ── Build Stage ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root config
COPY package.json package-lock.json turbo.json tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api-gateway/package.json ./services/api-gateway/

# Install dependencies
RUN npm ci --workspace=@breeze/api-gateway --include-workspace-root

# Copy source
COPY packages/shared/ ./packages/shared/
COPY services/api-gateway/ ./services/api-gateway/

# Build
RUN npx turbo run build --filter=@breeze/api-gateway

# ── Production Stage ─────────────────────────────────────────────
FROM node:20-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

RUN addgroup --system breeze && adduser --system --ingroup breeze breeze

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/packages/shared/dist/ ./packages/shared/dist/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/services/api-gateway/dist/ ./services/api-gateway/dist/
COPY --from=builder /app/services/api-gateway/package.json ./services/api-gateway/

USER breeze

EXPOSE 3000

CMD ["node", "services/api-gateway/dist/index.js"]
