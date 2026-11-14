FROM node:22.23-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./tsconfig.json
COPY deploy/tsconfig.server.json ./deploy/tsconfig.server.json
RUN ./node_modules/.bin/tsc -p deploy/tsconfig.server.json
RUN cp src/bot-user-agents.txt dist/bot-user-agents.txt
RUN npm prune --omit=dev && npm uninstall --omit=dev playwright

FROM node:22.23-slim AS server
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_ROOT_DIR=/opt/video-kit/data DATA_DIR=/opt/video-kit/data
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
