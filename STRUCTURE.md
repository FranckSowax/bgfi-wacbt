# 📁 Structure du Projet - BGFI WhatsApp Marketing SaaS

```
bgfi-whatsapp-saas/
│
├── 📄 index.html                    # Application Frontend (React + Tailwind)
│
├── 📁 backend/                      # API Backend (Node.js/Express)
│   ├── 📄 package.json
│   ├── 📄 Dockerfile
│   ├── 📄 .env.example
│   │
│   ├── 📁 src/
│   │   ├── 📄 server.js             # Point d'entrée
│   │   │
│   │   ├── 📁 routes/               # Routes API
│   │   │   ├── 📄 auth.js           # Authentification
│   │   │   ├── 📄 campaigns.js      # Gestion des campagnes
│   │   │   ├── 📄 contacts.js       # Gestion des contacts
│   │   │   ├── 📄 templates.js      # Templates WhatsApp
│   │   │   ├── 📄 chatbot.js        # Chatbot RAG
│   │   │   ├── 📄 analytics.js      # Analytics & reporting
│   │   │   └── 📄 webhooks.js       # Webhooks Respond.io
│   │   │
│   │   ├── 📁 services/             # Services métier
│   │   │   ├── 📄 respondio.js      # Intégration Respond.io
│   │   │   └── 📄 campaign.js       # Logique des campagnes
│   │   │
│   │   ├── 📁 middleware/           # Middlewares
│   │   │   ├── 📄 auth.js           # Authentification JWT
│   │   │   ├── 📄 rateLimit.js      # Rate limiting
│   │   │   └── 📄 errorHandler.js   # Gestion des erreurs
│   │   │
│   │   └── 📁 utils/                # Utilitaires
│   │       ├── 📄 logger.js         # Logger Winston
│   │       └── 📄 metrics.js        # Métriques Prometheus
│   │
│   └── 📁 prisma/
│       └── 📄 schema.prisma         # Schéma de base de données
│
├── 📁 rag-service/                  # Service RAG (Python/FastAPI)
│   ├── 📄 requirements.txt
│   ├── 📄 Dockerfile
│   ├── 📄 main.py                   # Point d'entrée FastAPI
│   │
│   ├── 📁 services/
│   │   ├── 📄 rag_pipeline.py       # Pipeline RAG (LangChain)
│   │   └── 📄 document_processor.py # Traitement des documents
│   │
│   └── 📁 utils/
│       └── 📄 logger.py             # Logger
│
├── 📁 nginx/                        # Configuration Nginx
│   └── 📄 nginx.conf
│
├── 📁 monitoring/                   # Monitoring & Observabilité
│   ├── 📄 prometheus.yml            # Configuration Prometheus
│   │
│   └── 📁 grafana/
│       ├── 📁 dashboards/           # Dashboards Grafana
│       └── 📁 datasources/          # Sources de données
│
├── 📄 docker-compose.yml            # Orchestration Docker
├── 📄 start.sh                      # Script de démarrage
│
├── 📄 README.md                     # Documentation principale
├── 📄 API.md                        # Documentation API
├── 📄 DEPLOYMENT.md                 # Guide de déploiement
└── 📄 STRUCTURE.md                  # Ce fichier
```

---

## 🔄 Flux de données

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────▶│    Nginx    │────▶│  API Node   │
│  (React)    │◀────│   (Proxy)   │◀────│  (Express)  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                                │
                       ┌────────────────────────┼────────────────────────┐
                       │                        │                        │
                       ▼                        ▼                        ▼
               ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
               │  PostgreSQL  │        │    Redis     │        │  RAG Python  │
               │  (Campaigns) │        │   (Queue)    │        │  (Chatbot)   │
               └──────────────┘        └──────────────┘        └──────┬───────┘
                                                                       │
                                                                       ▼
                                                              ┌──────────────┐
                                                              │   Pinecone   │
                                                              │ (Vector DB)  │
                                                              └──────────────┘
```

---

## 🛠️ Technologies utilisées

### Frontend
- **React 18** - Framework UI
- **Tailwind CSS** - Styling
- **Chart.js** - Graphiques

### Backend
- **Node.js 18** - Runtime
- **Express.js** - Framework web
- **Prisma** - ORM
- **Bull** - File d'attente
- **JWT** - Authentification

### RAG Service
- **Python 3.11** - Runtime
- **FastAPI** - Framework web
- **LangChain** - Framework LLM
- **OpenAI** - Modèles GPT
- **Pinecone** - Base vectorielle

### Infrastructure
- **Docker** - Conteneurisation
- **Nginx** - Reverse proxy
- **PostgreSQL** - Base de données
- **Redis** - Cache & Queue
- **Prometheus** - Métriques
- **Grafana** - Dashboards

---

## 📊 Schéma de la base de données

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│     User     │       │   Campaign   │       │   Template   │
├──────────────┤       ├──────────────┤       ├──────────────┤
│ id (PK)      │◀──────│ createdBy(FK)│       │ id (PK)      │
│ email        │       │ id (PK)      │──────▶│ templateId   │
│ password     │       │ name         │       │ name         │
│ name         │       │ type         │       │ category     │
│ role         │       │ status       │       │ content      │
└──────────────┘       │ segment      │       │ status       │
                       │ variables    │       └──────────────┘
                       └──────┬───────┘
                              │
                              ▼
                       ┌──────────────┐
                       │   Message    │
                       ├──────────────┤
                       │ id (PK)      │
                       │ campaignId   │
                       │ contactId    │
                       │ content      │
                       │ status       │
                       └──────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │   Contact    │
                       ├──────────────┤
                       │ id (PK)      │
                       │ phone        │
                       │ email        │
                       │ name         │
                       │ segment      │
                       │ status       │
                       └──────────────┘
```

---

## 🚀 Commandes utiles

```bash
# Démarrer tous les services
./start.sh

# Ou avec Docker Compose
docker-compose up -d --build

# Voir les logs
docker-compose logs -f

# Logs d'un service spécifique
docker-compose logs -f api

# Redémarrer un service
docker-compose restart api

# Arrêter tous les services
docker-compose down

# Reset complet (perte de données)
docker-compose down -v

# Exécuter les migrations
docker-compose exec api npx prisma migrate dev

# Accéder à la base de données
docker-compose exec db psql -U postgres -d bgfi_whatsapp
```

---

## 📞 Support

Pour toute question sur la structure du projet:
- 📧 Email: support@bgfi.ga
- 📖 Documentation: https://docs.bgfi-whatsapp.ga
