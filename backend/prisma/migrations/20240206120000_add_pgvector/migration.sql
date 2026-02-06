-- ============================================
-- Migration: Ajout de pgvector pour le RAG
-- ============================================

-- Activer l'extension pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Créer la table knowledge_chunks si elle n'existe pas
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(3072),
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_chunks_document_id_fkey" 
        FOREIGN KEY ("document_id") 
        REFERENCES "knowledge_documents"("id") 
        ON DELETE CASCADE
);

-- Index pour la recherche vectorielle (similarité cosinus)
CREATE INDEX IF NOT EXISTS "knowledge_chunks_embedding_idx" 
    ON "knowledge_chunks" 
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Index pour la recherche par document
CREATE INDEX IF NOT EXISTS "knowledge_chunks_document_id_idx" 
    ON "knowledge_chunks"("document_id");

-- ============================================
-- Fonction de recherche vectorielle
-- ============================================
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

-- ============================================
-- Fonction pour activer pgvector (appelée par l'app)
-- ============================================
CREATE OR REPLACE FUNCTION enable_pgvector()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
END;
$$;

-- ============================================
-- Trigger pour mettre à jour le nombre de chunks
-- ============================================
CREATE OR REPLACE FUNCTION update_document_chunks_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE knowledge_documents 
        SET chunks = chunks + 1 
        WHERE id = NEW.document_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE knowledge_documents 
        SET chunks = chunks - 1 
        WHERE id = OLD.document_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

-- Créer le trigger
DROP TRIGGER IF EXISTS update_chunks_count ON knowledge_chunks;
CREATE TRIGGER update_chunks_count
    AFTER INSERT OR DELETE ON knowledge_chunks
    FOR EACH ROW
    EXECUTE FUNCTION update_document_chunks_count();
