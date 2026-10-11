# --- build the web app
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- runtime: agent + API + static site
FROM node:22-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY --from=web /web/dist /app/frontend/dist
ENV STATIC_DIR=/app/frontend/dist DB_PATH=/data/heist.sqlite PORT=8787
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
