FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY prompts ./prompts

RUN mkdir -p /data && chown node:node /data
ENV ROBERT_HOME=/data ROBERT_CONTAINER=1 NODE_ENV=production
VOLUME /data
USER node

ENTRYPOINT ["node", "bin/robert.ts"]
CMD ["start"]
