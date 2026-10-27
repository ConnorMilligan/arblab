# The base image is pinned by digest; deploy/update.sh moves the pin to the latest 22.x slim build.
# Node runs the TypeScript directly (type stripping), so there is no build step.
# better-sqlite3 ships prebuilt binaries inside its npm package. --ignore-scripts skips
# npm's implicit `node-gyp rebuild` (a no-op that still needs Python), so no toolchain is needed.
FROM node:22.22-slim@sha256:16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/arblab.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
EXPOSE 8080
CMD ["node", "src/server.ts"]
