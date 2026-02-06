import os
from typing import List, Dict, Any, Optional
import time

from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_pinecone import PineconeVectorStore
from langchain.chains import RetrievalQA
from langchain.prompts import PromptTemplate
from langchain.schema import Document
from pinecone import Pinecone, ServerlessSpec

from utils.logger import logger

class RAGPipeline:
    def __init__(self):
        self.openai_api_key = os.getenv("OPENAI_API_KEY")
        self.pinecone_api_key = os.getenv("PINECONE_API_KEY")
        self.pinecone_environment = os.getenv("PINECONE_ENVIRONMENT", "gcp-starter")
        self.pinecone_index_name = os.getenv("PINECONE_INDEX", "bgfi-knowledge")
        
        # Configuration par défaut
        self.config = {
            "model": "gpt-4",
            "chunk_size": 1000,
            "chunk_overlap": 200,
            "top_k": 5,
            "similarity_threshold": 0.75
        }
        
        # Initialiser les composants
        self._init_embeddings()
        self._init_vectorstore()
        self._init_llm()
        self._init_prompt()
    
    def _init_embeddings(self):
        """Initialiser le modèle d'embeddings"""
        self.embeddings = OpenAIEmbeddings(
            model="text-embedding-3-large",
            openai_api_key=self.openai_api_key
        )
        logger.info("Embeddings model initialized")
    
    def _init_vectorstore(self):
        """Initialiser Pinecone"""
        try:
            self.pc = Pinecone(api_key=self.pinecone_api_key)
            
            # Vérifier si l'index existe
            existing_indexes = [index.name for index in self.pc.list_indexes()]
            
            if self.pinecone_index_name not in existing_indexes:
                # Créer l'index
                self.pc.create_index(
                    name=self.pinecone_index_name,
                    dimension=3072,  # Dimension pour text-embedding-3-large
                    metric="cosine",
                    spec=ServerlessSpec(
                        cloud="aws",
                        region="us-east-1"
                    )
                )
                logger.info(f"Created Pinecone index: {self.pinecone_index_name}")
            
            self.index = self.pc.Index(self.pinecone_index_name)
            
            # Initialiser le vectorstore LangChain
            self.vectorstore = PineconeVectorStore(
                index=self.index,
                embedding=self.embeddings,
                namespace="bgfi"
            )
            
            logger.info("Pinecone vectorstore initialized")
            
        except Exception as e:
            logger.error(f"Error initializing Pinecone: {str(e)}")
            raise
    
    def _init_llm(self):
        """Initialiser le modèle LLM"""
        self.llm = ChatOpenAI(
            model_name=self.config["model"],
            temperature=0.3,
            max_tokens=1000,
            openai_api_key=self.openai_api_key
        )
        logger.info(f"LLM initialized: {self.config['model']}")
    
    def _init_prompt(self):
        """Initialiser le prompt système"""
        self.system_prompt = """Tu es Cassiopée, l'assistant virtuel intelligent de BGFI Bank.

CONTEXTE:
Tu assistes les clients de BGFI Bank pour leurs questions sur les services bancaires, l'application mobile, les virements, les cartes, et autres produits bancaires.

RÈGLES STRICTES:
1. Réponds UNIQUEMENT en français
2. Base-toi UNIQUEMENT sur le contexte fourni ci-dessous
3. Si l'information n'est pas dans le contexte, dis "Je n'ai pas trouvé cette information dans ma base de connaissances. Je vous invite à contacter le service client au 0770 12 34 56."
4. Sois professionnel, chaleureux et concis
5. Ne partage JAMAIS d'informations sensibles (mots de passe, codes PIN, numéros de compte complets)
6. Pour les problèmes techniques urgents, oriente vers le service client
7. Cite toujours tes sources à la fin de ta réponse

CONTEXTE DOCUMENTAIRE:
{context}

QUESTION DU CLIENT:
{question}

RÉPONSE:"""
        
        self.prompt_template = PromptTemplate(
            template=self.system_prompt,
            input_variables=["context", "question"]
        )
    
    async def query(self, question: str, session_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Interroger la base de connaissances
        """
        start_time = time.time()
        
        try:
            # Recherche sémantique
            docs_with_scores = await self.vectorstore.asimilarity_search_with_score(
                question,
                k=self.config["top_k"]
            )
            
            # Filtrer par seuil de similarité
            filtered_docs = []
            for doc, score in docs_with_scores:
                if score >= self.config["similarity_threshold"]:
                    doc.metadata["score"] = score
                    filtered_docs.append(doc)
            
            if not filtered_docs:
                logger.warning(f"No relevant documents found for query: {question[:50]}...")
                return {
                    "response": "Je n'ai pas trouvé d'information pertinente dans ma base de connaissances. Je vous invite à contacter le service client au 0770 12 34 56.",
                    "sources": [],
                    "confidence": 0
                }
            
            # Construire le contexte
            context = "\n\n---\n\n".join([
                f"[Source: {doc.metadata.get('filename', 'Inconnue')}]\n{doc.page_content}"
                for doc in filtered_docs
            ])
            
            # Générer la réponse avec le LLM
            messages = [
                ("system", self.system_prompt.format(context=context, question=question))
            ]
            
            response = await self.llm.ainvoke(messages)
            
            # Calculer la confiance
            avg_score = sum(doc.metadata.get("score", 0) for doc in filtered_docs) / len(filtered_docs)
            
            # Formater les sources
            sources = [
                {
                    "document": doc.metadata.get("filename", "Inconnue"),
                    "page": doc.metadata.get("page", 1),
                    "score": round(doc.metadata.get("score", 0), 3)
                }
                for doc in filtered_docs
            ]
            
            processing_time = time.time() - start_time
            
            logger.info(f"Query processed", {
                "question": question[:50],
                "confidence": avg_score,
                "sources_count": len(sources),
                "processing_time": processing_time
            })
            
            return {
                "response": response.content,
                "sources": sources,
                "confidence": round(avg_score, 3)
            }
            
        except Exception as e:
            logger.error(f"Error in query: {str(e)}")
            raise
    
    async def index_document(self, chunks: List[Document], metadata: Dict[str, Any]):
        """
        Indexer un document dans Pinecone
        """
        try:
            # Ajouter les métadonnées à chaque chunk
            for chunk in chunks:
                chunk.metadata.update(metadata)
            
            # Indexer dans Pinecone
            await self.vectorstore.aadd_documents(chunks)
            
            logger.info(f"Indexed {len(chunks)} chunks for document {metadata.get('doc_id')}")
            
        except Exception as e:
            logger.error(f"Error indexing document: {str(e)}")
            raise
    
    async def delete_document(self, doc_id: str):
        """
        Supprimer un document et ses vecteurs
        """
        try:
            # Récupérer tous les vecteurs avec ce doc_id
            # Note: Pinecone ne supporte pas directement la suppression par métadonnées
            # Il faut d'abord rechercher puis supprimer
            
            # Pour l'instant, on supprime par namespace
            # Une implémentation plus robuste nécessiterait de stocker les IDs
            
            logger.info(f"Document deletion requested for {doc_id}")
            
        except Exception as e:
            logger.error(f"Error deleting document: {str(e)}")
            raise
    
    async def list_documents(self) -> List[Dict[str, Any]]:
        """
        Lister les documents indexés
        """
        try:
            # Récupérer les statistiques de l'index
            stats = self.index.describe_index_stats()
            
            # Note: Pinecone ne permet pas de lister directement les documents
            # Il faudrait stocker cette information dans une base de données
            
            return []
            
        except Exception as e:
            logger.error(f"Error listing documents: {str(e)}")
            raise
    
    def update_config(self, new_config: Dict[str, Any]):
        """
        Mettre à jour la configuration
        """
        self.config.update(new_config)
        
        # Réinitialiser le LLM si le modèle change
        if "model" in new_config:
            self._init_llm()
        
        logger.info("Configuration updated", self.config)
    
    def get_config(self) -> Dict[str, Any]:
        """
        Récupérer la configuration actuelle
        """
        return self.config
    
    async def get_stats(self) -> Dict[str, Any]:
        """
        Récupérer les statistiques
        """
        try:
            stats = self.index.describe_index_stats()
            
            return {
                "total_vectors": stats.total_vector_count,
                "dimension": stats.dimension,
                "index_fullness": stats.index_fullness,
                "namespaces": {
                    k: {"vector_count": v.vector_count}
                    for k, v in stats.namespaces.items()
                }
            }
            
        except Exception as e:
            logger.error(f"Error getting stats: {str(e)}")
            raise
