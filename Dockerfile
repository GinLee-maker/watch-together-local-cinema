FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY . .
ENV PORT=3210 HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 3210
VOLUME ["/data"]
CMD ["node", "server.js"]
