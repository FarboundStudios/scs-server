FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=30007 \
    INSTANCE_BIND_HOST=0.0.0.0 \
    INSTANCE_SCRIPTS_DIR=/var/lib/heavymp/scripts

WORKDIR /opt/heavymp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && install -d -o node -g node /var/lib/heavymp
COPY assets ./assets
COPY scripts ./scripts
COPY server ./server

WORKDIR /var/lib/heavymp
USER node
VOLUME ["/var/lib/heavymp"]
EXPOSE 30007/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '30007') + '/manager/', {signal: AbortSignal.timeout(3000)}).then(r => { if (!r.ok) process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"]
CMD ["node", "--env-file-if-exists=.env", "/opt/heavymp/server/system/main.mjs"]
