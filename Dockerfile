
# Stage 1: Builder
FROM node:20 AS builder

WORKDIR /app

# Install build tools
RUN apt-get update && \
    apt-get install -y python3-pip make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy and build source
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-slim

WORKDIR /app

# Copy only production deps
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

# Copy built code
COPY --from=builder /app/dist /app/dist

# Copy prebuilt Mediasoup worker binary
COPY --from=builder /app/node_modules/mediasoup/worker/out/Release/mediasoup-worker /app/node_modules/mediasoup/worker/out/Release/

# If needed for HTTPS
COPY ./cert ./cert

# Ports for server + WebRTC
EXPOSE 3000/tcp
EXPOSE 42000-42050/udp

CMD ["node", "dist/server.js"]
