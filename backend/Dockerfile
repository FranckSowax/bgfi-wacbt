# ============================================
# BGFI API Backend Dockerfile
# ============================================

FROM node:18-alpine AS base

# Installation des dépendances système
RUN apk add --no-cache curl

WORKDIR /app

# Copie des fichiers de dépendances
COPY package*.json ./

# Installation des dépendances
RUN npm ci --only=production && npm cache clean --force

# ============================================
# Stage: Development
# ============================================
FROM base AS development

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]

# ============================================
# Stage: Production
# ============================================
FROM base AS production

# Création des répertoires nécessaires
RUN mkdir -p logs uploads

# Copie du code source
COPY . .

# Création d'un utilisateur non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Changement de propriétaire
RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["npm", "start"]
