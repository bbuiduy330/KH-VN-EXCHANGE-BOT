FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --ignore-scripts
COPY . .
# npm run build = prisma generate (downloads engine binaries into
# node_modules/@prisma/engines and generates node_modules/.prisma/client) + tsc
RUN npm run build
# Prune devDependencies while KEEPING the generated client, prisma CLI and
# engine binaries already present in node_modules. --ignore-scripts prevents
# any lifecycle scripts from re-running during the prune.
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# Ship the already-prepared production tree from the build stage.
# NO second npm install: installing with --ignore-scripts omits Prisma engine
# binaries, forcing runtime engine downloads/writes into node_modules which
# fail under USER node + read_only filesystem. Everything Prisma needs at
# startup already exists inside this image.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
USER node
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node dist/src/server.js"]
