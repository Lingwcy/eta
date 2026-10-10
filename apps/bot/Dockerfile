# Build apps/bot/dist with the repository's Vite+ toolchain before building this image.
FROM node:24-bookworm-slim AS sandbox-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev && rm -rf /var/lib/apt/lists/*
COPY packages/core/src/platform/sandbox/linux-launcher.c /tmp/linux-launcher.c
RUN gcc -O2 -Wall -Wextra -Werror /tmp/linux-launcher.c -o /tmp/sandbox-launcher

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates bubblewrap && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/lib/eta-bot /workspaces && chown node:node /var/lib/eta-bot /workspaces
WORKDIR /opt/eta-bot
COPY apps/bot/dist/ ./dist/
COPY --from=sandbox-build /tmp/sandbox-launcher ./dist/sandbox-launcher
ENV NODE_ENV=production ETA_BOT_CONFIG=/etc/eta-bot/config.json
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
