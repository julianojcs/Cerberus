# syntax=docker/dockerfile:1
# Imagem da API do Cerberus (Servidor Central). Monorepo Turborepo + npm workspaces:
# o build compila @cerberus/shared e @cerberus/api; o runtime serve só a API.
#
# Contexto de build = RAIZ do repositório (ver render.yaml: dockerContext=".").
#   docker build -f apps/api/Dockerfile -t cerberus-api .

# ---------- build: instala o workspace e compila shared + api ----------
FROM node:20-alpine AS build
WORKDIR /app

# Instala com o lockfile (determinístico). `COPY . .` traz o monorepo já filtrado
# pelo .dockerignore (sem node_modules/dist/app móvel).
COPY . .
RUN npm ci \
  && npm run build --workspace @cerberus/shared \
  && npm run build --workspace @cerberus/api \
  && npm prune --omit=dev

# ---------- runtime: só o necessário para servir a API ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Encerramento limpo dos sinais (Fastify trata SIGINT/SIGTERM em server.ts).
RUN apk add --no-cache tini

# node_modules já podado para produção + artefatos compilados (dist).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

# Porta padrão (o Render injeta PORT; a API lê de env — ver config/env.ts).
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
