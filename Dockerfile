FROM node:20-slim

# Install git (needed for bolta-skills)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install OpenClaw + mcporter globally
RUN npm install -g openclaw mcporter

# Install BoltaClaw
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/
RUN npm link

# Clone bolta-skills
RUN git clone --depth 1 https://github.com/boltaai/bolta-skills.git /root/.boltaclaw/skills || true

# Data volume for persistent state (SQLite, config, memory)
ENV BOLTACLAW_DATA_DIR=/data
VOLUME /data

# Health check — verify gateway is running
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD openclaw health 2>/dev/null || exit 1

ENTRYPOINT ["node", "src/cli.js", "start"]
