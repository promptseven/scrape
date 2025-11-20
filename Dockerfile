FROM node:24-bullseye-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && \
    corepack prepare pnpm@10.22.0 --activate

RUN pnpm install --frozen-lockfile --prod

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["pnpm", "start"]
