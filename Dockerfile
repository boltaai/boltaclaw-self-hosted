FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/
COPY install.sh ./

ENV BOLTACLAW_DATA_DIR=/data

VOLUME /data

ENTRYPOINT ["node", "src/cli.js", "start"]
