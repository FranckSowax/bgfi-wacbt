import os
import uuid
from typing import List, Dict, Any, Optional
from datetime import datetime

import openai
from supabase import create_client, Client
from langchain.schema import Document
from langchain.text_splitter import RecursiveCharacterTextSplitter

from utils.logger import logger


class SupabaseRAGService:
    """
    Service RAG utilisant Supabase avec pgvector pour le stockage vectoriel.
    """
    
    def __init__(self):
        self.supabase_url = os.getenv("SUPABASE_URL")
        self.supabase_key = os.getenv("SUPABASE_SERVICE_KEY")
        self.openai_api_key = os.getenv("OPENAI_API_KEY")
        
        # Configuration RAG
        self.config = {
            "model": os.getenv("OPENAI_MODEL", "gpt-4"),
            "embedding_model": "text-embedding-3-large",
            "chunk_size": int(os.getenv("CHUNK_SIZE", "1000")),
            "chunk_overlap": int(os.getenv("CHUNK_OVERLAP", "200")),
            "top_k": int(os.getenv("TOP_K", "5")),
            "similarity_threshold": float(os.getenv("SIMILARITY_THRESHOLD", "0.75"))
        }
        
        # Initialiser les clients
        self._init_supabase()
        self._init_openai()
        self._init_text_splitter()
        
        # Créer les tables si elles n'existent pas
        self._init_database()
    
    def _init_supabase(self):
        """Initialiser le client Supabase"""
        if not self.supabase_url or not self.supabase_key:
            raise ValueError("SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis")
        
        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        logger.info("Supabase client initialized")
    
    def _init_openai(self):
        """Initialiser le client OpenAI"""
        openai.api_key = self.openai_api_key
        self.openai_client = openai.OpenAI(api_key=self.openai_api_key)
        logger.info("OpenAI client initialized")
    
    def _init_text_splitter(self):
        """Initialiser le splitter de texte"""
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.config["chunk_size"],
            chunk_overlap=self.config["chunk_overlap"],
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""]
        )
    
    def _init_database(self):
        """Initialiser la base de données (créer les tables si nécessaire)"""
        try:
            # Activer l'extension pgvector
            self.supabase.rpc('enable_pgvector').execute()
        except Exception as e:
            logger.warning(f"pgvector may already be enabled: {e}")
        
        logger.info("Database initialized")
    
    async def generate_embedding(self, text: str) -> List[float]:
        """Générer un embedding avec OpenAI"""
        try:
            response = self.openai_client.embeddings.create(
                model=self.config["embedding_model"],
                input=text
            )
            return response.data[0].embedding
        except Exception as e:
            logger.error(f"Error generating embedding: {e}")
            raise
    
    async def index_document(self, doc_id: str, filename: str, content: str, 
                            doc_type: str, chunks: List[Document]) -> Dict[str, Any]:
        """
        Indexer un document dans Supabase.
        
        Args:
            doc_id: ID unique du document
            filename: Nom du fichier
            content: Contenu brut du document
            doc_type: Type de document (pdf, docx, etc.)
            chunks: Liste des chunks LangChain
        """
        try:
            # 1. Insérer le document dans knowledge_documents
            doc_data = {
                "id": doc_id,
                "name": filename,
                "type": doc_type,
                "size": len(content),
                "status": "INDEXING",
                "chunks": len(chunks),
                "created_at": datetime.utcnow().isoformat()
            }
            
            self.supabase.table("knowledge_documents").insert(doc_data).execute()
            logger.info(f"Document {doc_id} inserted into knowledge_documents")
            
            # 2. Générer les embeddings et insérer les chunks
            chunk_records = []
            for i, chunk in enumerate(chunks):
                # Générer l'embedding
                embedding = await self.generate_embedding(chunk.page_content)
                
                chunk_record = {
                    "id": str(uuid.uuid4()),
                    "document_id": doc_id,
                    "content": chunk.page_content,
                    "embedding": embedding,
                    "metadata": {
                        "page": chunk.metadata.get("page", 1),
                        "chunk_index": i,
                        **chunk.metadata
                    },
                    "created_at": datetime.utcnow().isoformat()
                }
                chunk_records.append(chunk_record)
            
            # Insérer les chunks par batch de 100
            batch_size = 100
            for i in range(0, len(chunk_records), batch_size):
                batch = chunk_records[i:i + batch_size]
                self.supabase.table("knowledge_chunks").insert(batch).execute()
                logger.info(f"Inserted batch {i//batch_size + 1} of chunks for document {doc_id}")
            
            # 3. Mettre à jour le statut du document
            self.supabase.table("knowledge_documents").update({
                "status": "INDEXED",
                "indexed_at": datetime.utcnow().isoformat()
            }).eq("id", doc_id).execute()
            
            logger.info(f"Document {doc_id} indexed successfully with {len(chunks)} chunks")
            
            return {
                "success": True,
                "document_id": doc_id,
                "chunks_indexed": len(chunks)
            }
            
        except Exception as e:
            logger.error(f"Error indexing document {doc_id}: {e}")
            # Mettre à jour le statut en erreur
            try:
                self.supabase.table("knowledge_documents").update({
                    "status": "FAILED"
                }).eq("id", doc_id).execute()
            except:
                pass
            raise
    
    async def search_similar(self, query: str, top_k: int = None) -> List[Dict[str, Any]]:
        """
        Rechercher les chunks similaires à une requête.
        
        Args:
            query: Texte de la requête
            top_k: Nombre de résultats (défaut: config.top_k)
        
        Returns:
            Liste des chunks similaires avec leur score
        """
        try:
            top_k = top_k or self.config["top_k"]
            
            # Générer l'embedding de la requête
            query_embedding = await self.generate_embedding(query)
            
            # Recherche par similarité cosinus
            # Supabase avec pgvector supporte l'opérateur <=> pour la distance
            response = self.supabase.rpc(
                'match_knowledge_chunks',
                {
                    'query_embedding': query_embedding,
                    'match_threshold': self.config["similarity_threshold"],
                    'match_count': top_k
                }
            ).execute()
            
            results = response.data if response.data else []
            
            logger.info(f"Search for '{query[:50]}...' returned {len(results)} results")
            
            return results
            
        except Exception as e:
            logger.error(f"Error searching similar chunks: {e}")
            raise
    
    async def query(self, question: str, session_id: str = None) -> Dict[str, Any]:
        """
        Interroger le système RAG avec une question.
        
        Args:
            question: Question de l'utilisateur
            session_id: ID de session (optionnel)
        
        Returns:
            Réponse générée avec les sources
        """
        try:
            # 1. Rechercher les documents pertinents
            similar_chunks = await self.search_similar(question)
            
            if not similar_chunks:
                return {
                    "response": "Je n'ai pas trouvé d'information pertinente dans ma base de connaissances. Je vous invite à contacter le service client au 0770 12 34 56.",
                    "sources": [],
                    "confidence": 0
                }
            
            # 2. Construire le contexte
            context_parts = []
            sources = []
            
            for chunk in similar_chunks:
                context_parts.append(chunk["content"])
                sources.append({
                    "document": chunk.get("document_name", "Inconnu"),
                    "page": chunk.get("metadata", {}).get("page", 1),
                    "score": round(1 - chunk.get("similarity", 0), 3)  # Convertir distance en similarité
                })
            
            context = "\n\n---\n\n".join(context_parts)
            
            # 3. Générer la réponse avec GPT-4
            system_prompt = f"""Tu es Cassiopée, l'assistant virtuel intelligent de BGFI Bank.

CONTEXTE:
Tu assistes les clients de BGFI Bank pour leurs questions sur les services bancaires.

RÈGLES STRICTES:
1. Réponds UNIQUEMENT en français
2. Base-toi UNIQUEMENT sur le contexte fourni ci-dessous
3. Si l'information n'est pas dans le contexte, dis "Je n'ai pas trouvé cette information"
4. Sois professionnel, chaleureux et concis
5. Ne partage JAMAIS d'informations sensibles
6. Cite toujours tes sources

CONTEXTE DOCUMENTAIRE:
{context}

QUESTION DU CLIENT:
{question}

RÉPONSE:"""
            
            response = self.openai_client.chat.completions.create(
                model=self.config["model"],
                messages=[
                    {"role": "system", "content": system_prompt}
                ],
                temperature=0.3,
                max_tokens=1000
            )
            
            answer = response.choices[0].message.content
            
            # Calculer la confiance moyenne
            avg_confidence = sum(s["score"] for s in sources) / len(sources) if sources else 0
            
            logger.info(f"Generated response for query with confidence {avg_confidence:.3f}")
            
            return {
                "response": answer,
                "sources": sources,
                "confidence": round(avg_confidence, 3),
                "session_id": session_id or str(uuid.uuid4())
            }
            
        except Exception as e:
            logger.error(f"Error in query: {e}")
            raise
    
    async def list_documents(self) -> List[Dict[str, Any]]:
        """Lister tous les documents indexés"""
        try:
            response = self.supabase.table("knowledge_documents").select("*").order("created_at", desc=True).execute()
            return response.data if response.data else []
        except Exception as e:
            logger.error(f"Error listing documents: {e}")
            raise
    
    async def get_document(self, doc_id: str) -> Optional[Dict[str, Any]]:
        """Récupérer un document par son ID"""
        try:
            response = self.supabase.table("knowledge_documents").select("*").eq("id", doc_id).single().execute()
            return response.data
        except Exception as e:
            logger.error(f"Error getting document {doc_id}: {e}")
            return None
    
    async def delete_document(self, doc_id: str) -> bool:
        """Supprimer un document et ses chunks"""
        try:
            # Supprimer les chunks d'abord
            self.supabase.table("knowledge_chunks").delete().eq("document_id", doc_id).execute()
            
            # Supprimer le document
            self.supabase.table("knowledge_documents").delete().eq("id", doc_id).execute()
            
            logger.info(f"Document {doc_id} deleted")
            return True
            
        except Exception as e:
            logger.error(f"Error deleting document {doc_id}: {e}")
            raise
    
    async def get_stats(self) -> Dict[str, Any]:
        """Récupérer les statistiques du RAG"""
        try:
            # Compter les documents
            docs_response = self.supabase.table("knowledge_documents").select("*", count="exact").execute()
            total_docs = docs_response.count if hasattr(docs_response, 'count') else 0
            
            # Compter les chunks
            chunks_response = self.supabase.table("knowledge_chunks").select("*", count="exact").execute()
            total_chunks = chunks_response.count if hasattr(chunks_response, 'count') else 0
            
            # Documents par statut
            status_response = self.supabase.table("knowledge_documents").select("status").execute()
            status_counts = {}
            for doc in status_response.data or []:
                status = doc.get("status", "UNKNOWN")
                status_counts[status] = status_counts.get(status, 0) + 1
            
            return {
                "total_documents": total_docs,
                "total_chunks": total_chunks,
                "status_breakdown": status_counts,
                "config": self.config
            }
            
        except Exception as e:
            logger.error(f"Error getting stats: {e}")
            raise
    
    def update_config(self, new_config: Dict[str, Any]):
        """Mettre à jour la configuration"""
        self.config.update(new_config)
        
        # Mettre à jour le text splitter si nécessaire
        if "chunk_size" in new_config or "chunk_overlap" in new_config:
            self._init_text_splitter()
        
        logger.info(f"Configuration updated: {self.config}")
    
    def get_config(self) -> Dict[str, Any]:
        """Récupérer la configuration actuelle"""
        return self.config
