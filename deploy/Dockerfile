# KaiSign Wallet RPC gateway image. Built on the user's own server from a pinned git
# commit (the cloud-init from deploy/wizard.html), so no prebuilt KaiSign image has to be trusted.
# Full image for the build stage: c-kzg (EIP-4844 blob support) compiles native code and
# this image already ships python3/make/g++. The runtime stage below stays slim.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    KAISIGN_DATA_DIR=/data \
    KAISIGN_WALLET_RPC_HOST=127.0.0.1 \
    KAISIGN_WALLET_RPC_PORT=8546
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY metadata ./metadata
COPY registry ./registry
RUN install -d -o node -g node -m 700 /data
USER node
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.KAISIGN_WALLET_RPC_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/wallet-rpc.js"]
