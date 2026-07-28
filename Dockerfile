# email-mcp — container image for remote HTTP hosting (App Runner / Fargate / any host).
FROM node:22-slim

WORKDIR /app

# Install production deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# HTTP transport on the port the platform expects.
ENV MCP_HTTP=1 \
    PORT=8080 \
    NODE_ENV=production
EXPOSE 8080

# Credentials + MCP_BEARER_TOKEN are injected at runtime from Secrets Manager /
# env — never baked into the image.
CMD ["node", "src/index.mjs"]
