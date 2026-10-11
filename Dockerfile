# Mercurio in a container.
#
# One image, two roles. The command decides which:
#
#   docker run ... mercurio                      console and one worker
#   docker run ... mercurio npm run worker       a worker, and nothing else
#   docker run ... mercurio npm start -- --no-worker   the console, and nothing else
#
# That split is how this scales past one machine: the console where people can
# reach it, workers wherever there is capacity. They never talk to each other
# — they coordinate through the queue, which is in the database.
FROM node:22-slim

# openssl for Prisma's query engine, ca-certificates so the crawler can reach
# anything over https. Nothing else: no build toolchain, no python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not reinstall them. `postinstall`
# runs `prisma generate`, which needs the schema, so that comes too.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --no-audit --fund=false || npm install --no-audit --fund=false

COPY . .
RUN npx next build

# SQLite lives in a volume or the database disappears with the container. On
# Postgres this is unused and harmless.
VOLUME ["/app/data", "/app/outbox", "/app/inbox"]

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:./data/mercurio.db

EXPOSE 3000

# The health endpoint reports `degraded` when work is queued and nothing is
# consuming it, which is the failure a container probe would otherwise miss
# entirely: the console answers, and nothing happens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.status==='down'?1:0)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
