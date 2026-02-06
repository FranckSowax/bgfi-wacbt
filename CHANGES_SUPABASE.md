# 🔄 Migration vers Supabase pgvector

## Résumé des changements

Le service RAG a été migré de **Pinecone** vers **Supabase avec pgvector**.

---

## ✅ Changements effectués

### 1. Service RAG (`rag-service/`)

#### Nouveau fichier: `services/supabase_rag.py`
- Remplace `rag_pipeline.py`
- Utilise Supabase client pour stocker les embeddings
- Fonction de recherche vectorielle via RPC
- Gestion des documents et chunks dans PostgreSQL

#### Mise à jour: `main.py`
- Intègre le nouveau `SupabaseRAGService`
- Même API, implémentation différente

#### Mise à jour: `requirements.txt`
- Ajout de `supabase`, `psycopg2-binary`, `pgvector`
- Suppression de `pinecone-client`

### 2. Base de données (`backend/prisma/`)

#### Mise à jour: `schema.prisma`
- Ajout de la table `KnowledgeChunk` avec type `vector(3072)`
- Relation avec `KnowledgeDocument`

#### Nouveau: `migrations/20240206120000_add_pgvector/migration.sql`
- Création de l'extension pgvector
- Création des tables
- Fonction `match_knowledge_chunks()` pour la recherche
- Trigger pour mettre à jour le compteur de chunks

### 3. Configuration

#### Mise à jour: `.env.example`
- Ajout de `SUPABASE_URL`
- Ajout de `SUPABASE_SERVICE_KEY`
- Ajout de `SUPABASE_ANON_KEY`
- Configuration RAG (`CHUNK_SIZE`, `TOP_K`, etc.)

#### Mise à jour: `docker-compose.yml`
- Image PostgreSQL avec pgvector: `ankane/pgvector:latest`
- Variables d'environnement Supabase

### 4. Documentation

#### Nouveau: `README_SUPABASE.md`
- Guide complet de configuration Supabase
- Instructions SQL pour créer les tables
- Exemples de requêtes
- Dépannage

---

## 📊 Comparaison Pinecone vs Supabase

| Critère | Pinecone | Supabase pgvector |
|---------|----------|-------------------|
| **Coût** | $70/mois (départ) | $0 (free tier) |
| **Base de données** | Séparée | PostgreSQL intégré |
| **Latence** | ~50ms | ~20-100ms |
| **Dimensions** | Jusqu'à 20,000 | Jusqu'à 16,000 |
| **Métriques** | Cosine, Euclidean, Dot | Cosine, Euclidean, Inner |
| **Filtrage** | Limité | Complet (SQL) |
| **Backup** | Payant | Inclus |

---

## 🚀 Avantages de Supabase

1. **Coût réduit** - Free tier généreux
2. **Simplicité** - Une seule base de données
3. **SQL natif** - Requêtes complexes possibles
4. **Backup intégré** - Point-in-time recovery
5. **Auth intégrée** - Si besoin plus tard
6. **Realtime** - WebSockets disponibles

---

## 📁 Fichiers modifiés

```
rag-service/
├── requirements.txt          ✅ Mis à jour
├── main.py                   ✅ Mis à jour
├── services/
│   ├── supabase_rag.py       ✅ Nouveau
│   └── document_processor.py ✅ Mis à jour

backend/prisma/
├── schema.prisma             ✅ Mis à jour
└── migrations/
    └── 20240206120000_add_pgvector/
        └── migration.sql     ✅ Nouveau

backend/
└── .env.example              ✅ Mis à jour

docker-compose.yml            ✅ Mis à jour
README_SUPABASE.md            ✅ Nouveau
CHANGES_SUPABASE.md           ✅ Nouveau (ce fichier)
```

---

## 🔧 Configuration requise

### Variables d'environnement

```bash
# Supabase (obligatoire)
SUPABASE_URL=https://votre-projet.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIs...

# OpenAI (obligatoire)
OPENAI_API_KEY=sk-votre-cle
OPENAI_MODEL=gpt-4

# RAG (optionnel, valeurs par défaut)
CHUNK_SIZE=1000
CHUNK_OVERLAP=200
TOP_K=5
SIMILARITY_THRESHOLD=0.75
```

### SQL à exécuter dans Supabase

```sql
-- 1. Activer pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Créer les tables (voir README_SUPABASE.md)
-- Le fichier migration.sql contient tout le SQL nécessaire
```

---

## 🧪 Tests

```bash
# 1. Démarrer le service RAG
cd rag-service
pip install -r requirements.txt
uvicorn main:app --reload

# 2. Tester le health check
curl http://localhost:8000/health

# 3. Tester le chat
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Bonjour !"}'

# 4. Vérifier les stats
curl http://localhost:8000/stats
```

---

## 📝 Notes importantes

### Dimensions des embeddings
- OpenAI `text-embedding-3-large` → **3072 dimensions**
- Si vous changez de modèle, modifiez :
  - `schema.prisma`: `vector(3072)` → `vector(NOUVELLE_DIM)`
  - Migration SQL correspondante

### Performance
- Index IVFFlat créé automatiquement
- Paramètre `lists = 100` pour ~10k+ vecteurs
- Pour moins de vecteurs, utiliser `lists = 10-50`

### Sécurité
- Utilisez toujours la `SERVICE_KEY` côté serveur
- La `ANON_KEY` est pour le client uniquement
- Row Level Security (RLS) peut être activé

---

## 🆘 Support

En cas de problème :
1. Vérifier les logs : `docker-compose logs rag-service`
2. Tester la connexion Supabase
3. Vérifier que pgvector est activé
4. Consulter `README_SUPABASE.md` section Dépannage
