ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json bunfig.toml ./
COPY src ./src
EXPOSE 3000
CMD ["bun", "src/main.api.ts"]
