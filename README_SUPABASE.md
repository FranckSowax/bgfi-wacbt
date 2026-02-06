# 🚀 BGFI WhatsApp Marketing SaaS - Configuration Supabase

Ce document explique comment configurer le service RAG avec **Supabase** et **pgvector** pour le stockage vectoriel.

---

## 📋 Prérequis

1. **Compte Supabase** - Créez un projet sur [supabase.com](https://supabase.com)
2. **OpenAI API Key** - Pour les embeddings et GPT-4

---

## 🔧 Configuration Supabase

### 1. Créer un projet Supabase

1. Allez sur [supabase.com](https://supabase.com)
2. Créez un nouveau projet
3. Notez l'URL et les clés API

### 2. Activer pgvector

Dans le SQL Editor de Supabase, exécutez :

```sql
-- Activer l'extension pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Vérifier que l'extension est activée
SELECT * FROM pg_extension WHERE extname = 'vector';
```

### 3. Créer les tables pour le RAG

Exécutez ce SQL dans Supabase :

```sql
-- Table des documents
CREATE TABLE IF NOT EXISTS "knowledge_documents" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "path" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "chunks" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMP WITH TIME ZONE,
    "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table des chunks avec embeddings
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL REFERENCES "knowledge_documents"("id") ON DELETE CASCADE,
    "content" TEXT NOT NULL,
    "embedding" vector(3072),
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index pour la recherche vectorielle
CREATE INDEX ON "knowledge_chunks" 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Index pour la recherche par document
CREATE INDEX ON "knowledge_chunks"("document_id");

-- Fonction de recherche vectorielle
CREATE OR REPLACE FUNCTION match_knowledge_chunks(
    query_embedding vector(3072),
    match_threshold float,
    match_count int
)
RETURNS TABLE(
    id uuid,
    document_id uuid,
    content text,
    metadata jsonb,
    similarity float,
    document_name text
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        kc.id,
        kc.document_id,
        kc.content,
        kc.metadata,
        1 - (kc.embedding <=> query_embedding) as similarity,
        kd.name as document_name
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd ON kc.document_id = kd.id
    WHERE 1 - (kc.embedding <=> query_embedding) > match_threshold
    ORDER BY kc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
```

### 4. Récupérer les clés API

Dans les paramètres de votre projet Supabase :

1. Allez dans **Project Settings** > **API**
2. Copiez :
   - **Project URL** → `SUPABASE_URL`
   - **service_role secret** → `SUPABASE_SERVICE_KEY`

---

## ⚙️ Configuration du fichier .env

```bash
# Supabase
SUPABASE_URL=https://votre-projet.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIs...
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...

# OpenAI
OPENAI_API_KEY=sk-votre-cle-openai
OPENAI_MODEL=gpt-4

# RAG Configuration
CHUNK_SIZE=1000
CHUNK_OVERLAP=200
TOP_K=5
SIMILARITY_THRESHOLD=0.75
```

---

## 🔄 Architecture avec Supabase

```
┌─────────────────┐
│   Application   │
│    (React)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   API Node.js   │
│    (Express)    │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌──────────┐
│PostgreSQL│ │  Redis   │
│Supabase │ │  (Queue) │
│+pgvector│ └──────────┘
└────┬───┘
     │
     │ Embeddings
     │ (3072 dims)
     ▼
┌─────────────────┐
│   RAG Service   │
│  (Python/FastAPI)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     OpenAI      │
│  (GPT-4 + Emb)  │
└─────────────────┘
```

---

## 📊 Schéma de la base de données

### Table `knowledge_documents`
| Champ | Type | Description |
|-------|------|-------------|
| id | UUID | ID unique |
| name | TEXT | Nom du fichier |
| type | TEXT | Type (pdf, docx, etc.) |
| size | INT | Taille en bytes |
| status | TEXT | PROCESSING, INDEXED, FAILED |
| chunks | INT | Nombre de chunks |
| indexed_at | TIMESTAMP | Date d'indexation |

### Table `knowledge_chunks`
| Champ | Type | Description |
|-------|------|-------------|
| id | UUID | ID unique |
| document_id | UUID | Référence au document |
| content | TEXT | Contenu textuel |
| embedding | vector(3072) | Vecteur OpenAI |
| metadata | JSONB | Métadonnées (page, etc.) |

---

## 🚀 Démarrage

### Option 1: Avec Supabase Cloud

```bash
# 1. Configurer les variables
export SUPABASE_URL=https://votre-projet.supabase.co
export SUPABASE_SERVICE_KEY=votre_service_key
export OPENAI_API_KEY=sk-votre-cle

# 2. Démarrer uniquement le RAG service
cd rag-service
pip install -r requirements.txt
uvicorn main:app --reload
```

### Option 2: Avec Docker (PostgreSQL local + pgvector)

```bash
# Démarrer tous les services
docker-compose up -d

# La base de données locale inclut pgvector
# Utile pour le développement local
```

---

## 🧪 Tester le RAG

```bash
# Health check
curl http://localhost:8000/health

# Chat
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Comment récupérer mes identifiants ?"}'

# Lister les documents
curl http://localhost:8000/documents

# Stats
curl http://localhost:8000/stats
```

---

## 📈 Monitoring

### Vérifier les embeddings dans Supabase

```sql
-- Nombre de documents
SELECT COUNT(*) FROM knowledge_documents;

-- Nombre de chunks
SELECT COUNT(*) FROM knowledge_chunks;

-- Documents par statut
SELECT status, COUNT(*) FROM knowledge_documents GROUP BY status;

-- Tester la recherche vectorielle
SELECT * FROM match_knowledge_chunks(
    ARRAY[0.1, 0.2, ...]::vector(3072),  -- votre embedding
    0.75,  -- seuil
    5      -- top_k
);
```

---

## 🔍 Dépannage

### Erreur: "pgvector extension not found"

```sql
-- Vérifier que pgvector est installé
SELECT * FROM pg_available_extensions WHERE name = 'vector';

-- L'installer si nécessaire
CREATE EXTENSION vector;
```

### Erreur: "dimension mismatch"

Vérifiez que la dimension du vecteur correspond :
- `text-embedding-3-large` → 3072 dimensions
- `text-embedding-3-small` → 1536 dimensions
- `text-embedding-ada-002` → 1536 dimensions

```sql
-- Modifier la dimension si nécessaire
ALTER TABLE knowledge_chunks 
ALTER COLUMN embedding TYPE vector(1536);
```

### Erreur: "connection refused"

Vérifiez que les variables d'environnement sont correctement définies :
```bash
echo $SUPABASE_URL
echo $SUPABASE_SERVICE_KEY
```

---

## 💰 Coûts

| Service | Coût estimé |
|---------|-------------|
| Supabase Free Tier | $0 (500MB, 2M requêtes/mois) |
| Supabase Pro | $25/mois (8GB, 100M requêtes) |
| OpenAI Embeddings | ~$0.10 / 1M tokens |
| OpenAI GPT-4 | ~$0.03 / 1K tokens |

---

## 📚 Ressources

- [Supabase Documentation](https://supabase.com/docs)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [OpenAI Embeddings](https://platform.openai.com/docs/guides/embeddings)
- [LangChain Supabase](https://python.langchain.com/docs/integrations/vectorstores/supabase)
