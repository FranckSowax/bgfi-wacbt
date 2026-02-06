import os
import uuid
from typing import List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from services.supabase_rag import SupabaseRAGService
from services.document_processor import DocumentProcessor
from utils.logger import logger

load_dotenv()

# Lifespan context manager for startup/shutdown events
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("🚀 Démarrage du service RAG avec Supabase...")
    try:
        app.state.rag_service = SupabaseRAGService()
        app.state.doc_processor = DocumentProcessor()
        logger.info("✅ Services initialisés avec succès")
    except Exception as e:
        logger.error(f"❌ Erreur lors du démarrage: {e}")
        raise
    yield
    # Shutdown
    logger.info("🛑 Arrêt du service RAG...")

app = FastAPI(
    title="BGFI RAG Service - Supabase",
    description="Service RAG pour le chatbot BGFI WhatsApp utilisant Supabase pgvector",
    version="2.0.0",
    lifespan=lifespan
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Modèles Pydantic
class ChatMessage(BaseModel):
    message: str
    session_id: Optional[str] = None
    contact_id: Optional[str] = None

class ChatResponse(BaseModel):
    response: str
    sources: List[dict]
    confidence: float
    session_id: str
    processing_time: float

class DocumentStatus(BaseModel):
    id: str
    name: str
    status: str
    chunks: int
    indexed_at: Optional[str] = None

class RAGConfig(BaseModel):
    model: str = "gpt-4"
    chunk_size: int = 1000
    chunk_overlap: int = 200
    top_k: int = 5
    similarity_threshold: float = 0.75

# Routes
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    try:
        # Vérifier la connexion Supabase
        stats = await app.state.rag_service.get_stats()
        return {
            "status": "healthy",
            "service": "rag-service-supabase",
            "version": "2.0.0",
            "stats": stats
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(status_code=503, detail=f"Service unhealthy: {str(e)}")

@app.post("/chat", response_model=ChatResponse)
async def chat(message: ChatMessage):
    """
    Envoyer un message au chatbot RAG
    """
    import time
    start_time = time.time()
    
    try:
        # Générer un session_id si non fourni
        session_id = message.session_id or str(uuid.uuid4())
        
        # Interroger le service RAG
        result = await app.state.rag_service.query(
            question=message.message,
            session_id=session_id
        )
        
        processing_time = time.time() - start_time
        
        logger.info(f"Chat query processed", {
            "session_id": session_id,
            "confidence": result["confidence"],
            "processing_time": processing_time
        })
        
        return ChatResponse(
            response=result["response"],
            sources=result["sources"],
            confidence=result["confidence"],
            session_id=session_id,
            processing_time=round(processing_time, 3)
        )
        
    except Exception as e:
        logger.error(f"Error processing chat query: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/documents/upload")
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...)
):
    """
    Uploader et indexer un document
    """
    try:
        # Vérifier l'extension
        allowed_extensions = ['.pdf', '.docx', '.doc', '.txt', '.csv', '.xlsx', '.xls']
        file_ext = os.path.splitext(file.filename)[1].lower()
        
        if file_ext not in allowed_extensions:
            raise HTTPException(
                status_code=400,
                detail=f"Type de fichier non supporté. Types autorisés: {', '.join(allowed_extensions)}"
            )
        
        # Générer un ID unique
        doc_id = str(uuid.uuid4())
        
        # Sauvegarder le fichier temporairement
        temp_path = f"/tmp/{doc_id}_{file.filename}"
        with open(temp_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        
        # Lire le contenu pour la taille
        file_content = content.decode('utf-8', errors='ignore')
        
        # Traiter le document en arrière-plan
        background_tasks.add_task(
            process_document_task,
            app.state.doc_processor,
            app.state.rag_service,
            temp_path,
            doc_id,
            file.filename,
            file_ext,
            file_content
        )
        
        logger.info(f"Document upload started", {
            "doc_id": doc_id,
            "filename": file.filename
        })
        
        return {
            "id": doc_id,
            "name": file.filename,
            "status": "processing",
            "message": "Document en cours d'indexation. Cela peut prendre quelques minutes."
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading document: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

async def process_document_task(doc_processor, rag_service, file_path, doc_id, filename, file_ext, file_content):
    """
    Tâche de traitement du document en arrière-plan
    """
    try:
        logger.info(f"Processing document {doc_id}")
        
        # Traiter le document (extraire les chunks)
        result = await doc_processor.process(file_path, file_ext)
        
        # Indexer dans Supabase
        await rag_service.index_document(
            doc_id=doc_id,
            filename=filename,
            content=file_content,
            doc_type=file_ext,
            chunks=result["chunks"]
        )
        
        # Nettoyer le fichier temporaire
        import os
        if os.path.exists(file_path):
            os.remove(file_path)
        
        logger.info(f"Document {doc_id} indexed successfully with {len(result['chunks'])} chunks")
        
    except Exception as e:
        logger.error(f"Error processing document {doc_id}: {str(e)}")
        # Nettoyer en cas d'erreur
        import os
        if os.path.exists(file_path):
            os.remove(file_path)

@app.get("/documents")
async def list_documents():
    """
    Lister tous les documents indexés
    """
    try:
        documents = await app.state.rag_service.list_documents()
        return {"documents": documents}
    except Exception as e:
        logger.error(f"Error listing documents: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/documents/{doc_id}")
async def get_document(doc_id: str):
    """
    Récupérer un document par son ID
    """
    try:
        document = await app.state.rag_service.get_document(doc_id)
        if not document:
            raise HTTPException(status_code=404, detail="Document non trouvé")
        return document
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting document {doc_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/documents/{doc_id}")
async def delete_document(doc_id: str):
    """
    Supprimer un document et ses vecteurs
    """
    try:
        await app.state.rag_service.delete_document(doc_id)
        
        logger.info(f"Document deleted", {"doc_id": doc_id})
        
        return {"success": True, "message": "Document supprimé avec succès"}
        
    except Exception as e:
        logger.error(f"Error deleting document {doc_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/config")
async def update_config(config: RAGConfig):
    """
    Mettre à jour la configuration RAG
    """
    try:
        app.state.rag_service.update_config({
            "model": config.model,
            "chunk_size": config.chunk_size,
            "chunk_overlap": config.chunk_overlap,
            "top_k": config.top_k,
            "similarity_threshold": config.similarity_threshold
        })
        
        logger.info("RAG configuration updated", config.dict())
        
        return {"success": True, "message": "Configuration mise à jour"}
        
    except Exception as e:
        logger.error(f"Error updating config: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/config")
async def get_config():
    """
    Récupérer la configuration actuelle
    """
    try:
        config = app.state.rag_service.get_config()
        return config
    except Exception as e:
        logger.error(f"Error getting config: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/stats")
async def get_stats():
    """
    Récupérer les statistiques du service RAG
    """
    try:
        stats = await app.state.rag_service.get_stats()
        return stats
    except Exception as e:
        logger.error(f"Error getting stats: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/search")
async def search(query: str, top_k: int = 5):
    """
    Recherche sémantique directe (pour debug)
    """
    try:
        results = await app.state.rag_service.search_similar(query, top_k)
        return {"results": results}
    except Exception as e:
        logger.error(f"Error in search: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        reload=os.getenv("ENV", "production") == "development"
    )
