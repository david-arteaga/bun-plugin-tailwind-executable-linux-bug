# This Dockerfile is designed to be built from the root of the monorepo.
# That means that the webapp package is located at ./packages/webapp.

# ========================================================
# 1. base - includes Bun runtime and wget for healthchecks
# ========================================================
FROM oven/bun:1.3.2-debian AS base

# Install wget for healthchecks (single layer, no upgrade, with cleanup)
RUN apt-get update && \
    apt-get install -y --no-install-recommends wget && \
    rm -rf /var/lib/apt/lists/*

# reference: https://bun.com/guides/ecosystem/docker

# ========================================================
# 2. install - installs dependencies for the webapp
# ========================================================
FROM base AS install

WORKDIR /app

# Copy monorepo root package.json and bun.lock*
COPY package.json bun.lock* bunfig.toml ./

# Install deps
RUN bun install --frozen-lockfile --production

# ========================================================
# 3. build - builds the webapp
# ========================================================
FROM install AS build

# Install dev deps so ts build can pass
RUN bun install --frozen-lockfile

# Copy source needed for webapp build
COPY . .

RUN bun run build:browser && bun run build:executable

# Production image
FROM base AS release
WORKDIR /app

COPY --from=build /app/server ./
COPY --from=build /app/dist ./

USER bun

# Expose port
EXPOSE 3000

# Set environment variable
ENV PORT=3000
ENV NODE_ENV=production

# Run the application
CMD ["./server"]

