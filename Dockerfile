FROM node:22-alpine

WORKDIR /usr/app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package manifests first for optimal Docker layer caching
COPY package.json package-lock.json /usr/app/

# Install production dependencies
RUN npm ci --omit=dev

# Clean up build tools to minimize image size
RUN apk del python3 make g++

# Copy application source code
COPY assets /usr/app/assets
COPY discord /usr/app/discord
COPY languages /usr/app/languages
COPY misc /usr/app/misc
COPY valorant /usr/app/valorant
COPY SkinPeek.js /usr/app/

CMD ["node", "SkinPeek.js"]
