FROM node:22-bookworm-slim

WORKDIR /usr/app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for optimal Docker layer caching
COPY package.json package-lock.json /usr/app/

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code
COPY assets /usr/app/assets
COPY discord /usr/app/discord
COPY languages /usr/app/languages
COPY misc /usr/app/misc
COPY valorant /usr/app/valorant
COPY SkinPeek.js /usr/app/

CMD ["node", "SkinPeek.js"]
