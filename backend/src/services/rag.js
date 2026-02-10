const { PrismaClient } = require('@prisma/client');
const fetch = require('node-fetch');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// Service RAG interne (pgvector + OpenAI Embeddings)
// Pas de service externe - tout dans Netlify Functions
// ============================================

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSION = 1536;

// ============================================
// Initialisation des tables pgvector
// ============================================
let initialized = false;

async function initialize() {
  if (initialized) return true;
  try {
    await prisma.$queryRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

    await prisma.$queryRawUnsafe(`
      CREATE TABLE IF NOT EXISTS rag_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        content TEXT,
        type VARCHAR(50) DEFAULT 'text',
        metadata JSONB DEFAULT '{}',
        chunk_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await prisma.$queryRawUnsafe(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID REFERENCES rag_documents(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        chunk_index INT NOT NULL,
        embedding vector(${EMBEDDING_DIMENSION}),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await prisma.$queryRawUnsafe(`
      CREATE TABLE IF NOT EXISTS rag_config (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        bot_name VARCHAR(100) DEFAULT 'Cassiopee',
        welcome_message TEXT DEFAULT 'Bonjour ! Je suis Cassiopee, votre assistant BGFI disponible 24/7. Comment puis-je vous aider aujourd''hui ?',
        system_prompt TEXT DEFAULT 'Tu es Cassiopee, l''assistant virtuel de BGFI Bank Gabon sur WhatsApp. Tu reponds de maniere concise, professionnelle et chaleureuse en francais. Tu aides les clients avec leurs questions bancaires (comptes, cartes, virements, agences, horaires, produits). Si tu ne connais pas la reponse, oriente le client vers le service client au 011 76 32 29. Ne fournis jamais d''informations sensibles sur les comptes. Reponds en 2-3 phrases maximum.',
        model VARCHAR(50) DEFAULT 'gpt-4',
        chunk_count INT DEFAULT 5,
        similarity_threshold FLOAT DEFAULT 0.7,
        include_sources BOOLEAN DEFAULT true,
        fallback_response BOOLEAN DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await prisma.$queryRawUnsafe(`INSERT INTO rag_config (id) VALUES (1) ON CONFLICT DO NOTHING`);

    initialized = true;
    logger.info('RAG tables initialized');
    return true;
  } catch (error) {
    logger.error('RAG initialization error', { error: error.message });
    return false;
  }
}

// ============================================
// Generer un embedding via OpenAI
// ============================================
async function generateEmbedding(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY non configure');

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8000)
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Erreur embedding OpenAI');
  return data.data[0].embedding;
}

// ============================================
// Decouper un texte en chunks
// ============================================
function chunkText(text, chunkSize = 500, overlap = 50) {
  // Split by paragraphs first, then sentences
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > chunkSize && current.trim()) {
      chunks.push(current.trim());
      // Keep overlap from end of current chunk
      const words = current.split(/\s+/);
      current = words.slice(-Math.ceil(overlap / 5)).join(' ') + '\n\n' + para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // If no paragraphs were found, split by sentences
  if (chunks.length === 0) {
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
    current = '';
    for (const sentence of sentences) {
      if ((current + ' ' + sentence).length > chunkSize && current.trim()) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += (current ? ' ' : '') + sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text.substring(0, chunkSize)];
}

// ============================================
// Ajouter un document a la base de connaissances
// ============================================
async function addDocument(title, content, type = 'text', metadata = {}) {
  await initialize();

  // Creer le document
  const docs = await prisma.$queryRawUnsafe(
    `INSERT INTO rag_documents (title, content, type, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, title, type, chunk_count, created_at`,
    title, content, type, JSON.stringify(metadata)
  );
  const doc = docs[0];

  // Decouper en chunks et generer les embeddings
  const chunks = chunkText(content);
  let embedded = 0;

  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await generateEmbedding(chunks[i]);
      const embeddingStr = `[${embedding.join(',')}]`;

      await prisma.$queryRawUnsafe(
        `INSERT INTO rag_chunks (document_id, content, chunk_index, embedding)
         VALUES ($1::uuid, $2, $3, $4::vector)`,
        doc.id, chunks[i], i, embeddingStr
      );
      embedded++;
    } catch (err) {
      logger.warn('Failed to embed chunk', { docId: doc.id, chunk: i, error: err.message });
    }
  }

  // Mettre a jour le nombre de chunks
  await prisma.$queryRawUnsafe(
    `UPDATE rag_documents SET chunk_count = $1 WHERE id = $2::uuid`,
    embedded, doc.id
  );

  logger.info('Document added to RAG', { id: doc.id, title, chunks: embedded });
  return { ...doc, chunk_count: embedded };
}

// ============================================
// Recherche par similarite vectorielle
// ============================================
async function searchSimilar(query, topK = 5, threshold = 0.7) {
  await initialize();

  const queryEmbedding = await generateEmbedding(query);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  const results = await prisma.$queryRawUnsafe(
    `SELECT c.content, c.chunk_index, c.document_id,
            d.title as doc_title,
            1 - (c.embedding <=> $1::vector) as similarity
     FROM rag_chunks c
     JOIN rag_documents d ON d.id = c.document_id
     WHERE 1 - (c.embedding <=> $1::vector) > $2
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    embeddingStr, threshold, topK
  );

  return results;
}

// ============================================
// Chat avec contexte RAG
// ============================================
async function chat(message, contactId = null) {
  await initialize();

  const config = await getConfig();

  // Rechercher les chunks pertinents
  let chunks = [];
  let sources = [];
  try {
    chunks = await searchSimilar(
      message,
      config.chunk_count || 5,
      config.similarity_threshold || 0.7
    );
    sources = [...new Set(chunks.map(c => c.doc_title))];
  } catch (err) {
    logger.warn('RAG search failed, continuing without context', { error: err.message });
  }

  // Construire le contexte
  let context = '';
  if (chunks.length > 0) {
    context = '\n\nContexte documentaire (base de connaissances BGFI):\n' +
      chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');
  }

  // Prompt systeme
  const systemPrompt = (config.system_prompt ||
    "Tu es Cassiopee, l'assistant virtuel de BGFI Bank Gabon sur WhatsApp. Tu reponds de maniere concise, professionnelle et chaleureuse en francais.") +
    context;

  // Appel OpenAI
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY non configure');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: config.model || process.env.OPENAI_MODEL || 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.5,
      max_tokens: 500
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Erreur OpenAI');

  let reply = data.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Pas de reponse OpenAI');

  // Ajouter les sources si configure
  if (config.include_sources && sources.length > 0) {
    reply += '\n\n_Sources: ' + sources.join(', ') + '_';
  }

  return {
    response: reply,
    sources,
    chunks_used: chunks.length
  };
}

// ============================================
// Lister les documents
// ============================================
async function listDocuments() {
  await initialize();
  return prisma.$queryRawUnsafe(
    `SELECT id, title, type, chunk_count, metadata, created_at, updated_at
     FROM rag_documents ORDER BY created_at DESC`
  );
}

// ============================================
// Supprimer un document (cascade supprime les chunks)
// ============================================
async function deleteDocument(id) {
  await initialize();
  await prisma.$queryRawUnsafe(`DELETE FROM rag_documents WHERE id = $1::uuid`, id);
  logger.info('RAG document deleted', { id });
  return true;
}

// ============================================
// Lire la configuration RAG
// ============================================
async function getConfig() {
  await initialize();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM rag_config WHERE id = 1`);
  if (!rows[0]) return {};

  const c = rows[0];
  return {
    botName: c.bot_name,
    welcomeMessage: c.welcome_message,
    systemPrompt: c.system_prompt,
    system_prompt: c.system_prompt,
    model: c.model,
    chunkCount: c.chunk_count,
    chunk_count: c.chunk_count,
    similarityThreshold: c.similarity_threshold,
    similarity_threshold: c.similarity_threshold,
    includeSources: c.include_sources,
    include_sources: c.include_sources,
    fallbackResponse: c.fallback_response
  };
}

// ============================================
// Mettre a jour la configuration RAG
// ============================================
async function updateConfig(updates) {
  await initialize();

  const mapping = {
    botName: 'bot_name',
    welcomeMessage: 'welcome_message',
    systemPrompt: 'system_prompt',
    model: 'model',
    chunkCount: 'chunk_count',
    similarityThreshold: 'similarity_threshold',
    includeSources: 'include_sources',
    fallbackResponse: 'fallback_response'
  };

  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    const col = mapping[key] || key;
    if (Object.values(mapping).includes(col)) {
      fields.push(`${col} = $${idx}`);
      values.push(value);
      idx++;
    }
  }

  if (fields.length === 0) return getConfig();

  fields.push('updated_at = NOW()');

  await prisma.$queryRawUnsafe(
    `UPDATE rag_config SET ${fields.join(', ')} WHERE id = 1`,
    ...values
  );

  return getConfig();
}

// ============================================
// Statistiques RAG
// ============================================
async function getStats() {
  await initialize();
  const docs = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int as count FROM rag_documents`);
  const chunks = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int as count FROM rag_chunks`);

  // Sessions 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sessions = await prisma.chatSession.count({
    where: { createdAt: { gte: oneDayAgo } }
  }).catch(() => 0);

  return {
    documents: docs[0]?.count || 0,
    chunks: chunks[0]?.count || 0,
    sessions_24h: sessions
  };
}

module.exports = {
  initialize,
  generateEmbedding,
  chunkText,
  addDocument,
  searchSimilar,
  chat,
  listDocuments,
  deleteDocument,
  getConfig,
  updateConfig,
  getStats
};
