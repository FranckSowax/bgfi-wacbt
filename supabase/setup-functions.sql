-- Note: Index vectoriel omis pour le moment (3072 dims > limite 2000 de pgvector)
-- En production, utiliser text-embedding-3-small (1536 dims) ou réduire les dimensions

-- Fonction de recherche vectorielle
CREATE OR REPLACE FUNCTION match_knowledge_chunks(
    query_embedding vector(3072),
    match_threshold float DEFAULT 0.75,
    match_count int DEFAULT 5
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
        (1 - (kc.embedding <=> query_embedding))::float as similarity,
        kd.name as document_name
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd ON kc.document_id = kd.id
    WHERE 1 - (kc.embedding <=> query_embedding) > match_threshold
    ORDER BY kc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Trigger pour compter les chunks
CREATE OR REPLACE FUNCTION update_document_chunks_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE knowledge_documents SET chunks = chunks + 1 WHERE id = NEW.document_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE knowledge_documents SET chunks = chunks - 1 WHERE id = OLD.document_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_update_chunks_count ON knowledge_chunks;
CREATE TRIGGER trigger_update_chunks_count
    AFTER INSERT OR DELETE ON knowledge_chunks
    FOR EACH ROW
    EXECUTE FUNCTION update_document_chunks_count();
