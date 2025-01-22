# Use Node 20 base image
FROM node:20-alpine AS base

# Set working directory inside the container
WORKDIR /usr/src/app

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install --production=false

# Copy source files
COPY . .

# Build the project
FROM base AS build
RUN yarn run build

# Production image
FROM node:20 AS production

# Set working directory inside the container
WORKDIR /usr/src/app

RUN apt-get update && \
    apt-get install -y git python3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install only production dependencies
COPY package.json yarn.lock ./
RUN yarn install --production

# Copy built files from the build stage
COPY --from=build /usr/src/app/dist ./dist

# Set the command to run the server
CMD ["node", "dist/src/server.js"]
