FROM node:23-slim

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install all dependencies
RUN npm ci

# Copy source and config
COPY tsconfig.json ./
COPY fix-libsodium.cjs ./
COPY src/ ./src/

# Fix broken ESM exports AFTER npm install
RUN node fix-libsodium.cjs

# Compile TypeScript (no bundling - let Node resolve modules)
RUN npm run build

# Expose port
EXPOSE 3000

# Start server from the compiled output
CMD ["node", "dist/index.js"]

