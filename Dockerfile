FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/world/package.json packages/world/
COPY packages/connectors/package.json packages/connectors/
COPY packages/engine/package.json packages/engine/
COPY packages/scoring/package.json packages/scoring/
COPY packages/report/package.json packages/report/
COPY packages/vision/package.json packages/vision/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci
COPY . .
USER node
CMD ["npm", "run", "api"]
