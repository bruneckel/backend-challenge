FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json bunfig.toml ./
COPY src ./src
USER bun
EXPOSE 3000
CMD ["bun", "src/main.api.ts"]
