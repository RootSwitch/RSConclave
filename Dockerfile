# RSConclave - zero-dependency Node app, so the image is just Node + source.
# No npm install, no build stage, nothing to compile.
FROM node:24-alpine

WORKDIR /app
COPY server/ ./server/
COPY public/ ./public/
COPY tsconfig.json ./
# package.json holds no dependencies - it is here so module resolution is
# identical inside and outside the container. It currently sets no "type", and
# if that ever changes the container must change with it; otherwise dev and
# production disagree about whether files are ESM or CommonJS, which fails in
# whichever one you are not looking at.
COPY package.json ./

# data/ lives here; mount a volume over it to persist sessions across updates
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# Inside a container the server must bind beyond loopback or the published
# port maps to nothing. The startup warning about no authentication still
# prints - it is still true. The container boundary is your access control.
ENV HOST=0.0.0.0
ENV PORT=7777
EXPOSE 7777

# The server speaks HTTP, or HTTPS once a cert exists in data/certs - try both.
# The HTTPS probe makes BusyBox wget spawn an ssl_client child, which is why
# docker-compose.yml sets init: true. Without an init at PID 1, node never
# reaps that child and one zombie accrues per probe, forever.
#
# /api/health, not /api/state: state now requires a login, and a healthcheck
# that cannot authenticate would mark a perfectly working container unhealthy
# and restart it in a loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:$PORT/api/health" >/dev/null || \
      wget -qO- --no-check-certificate "https://127.0.0.1:$PORT/api/health" >/dev/null || exit 1

# --disable-warning: Node warns that package.json sets no "type", and advises
# adding "type": "module" - which breaks this project (see the //type note in
# package.json). Suppressed so container logs are not led astray on every boot.
CMD ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "server/main.ts"]
