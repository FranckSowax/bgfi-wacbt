import os
from typing import List, Dict, Any

from langchain.schema import Document
from langchain.text_splitter import RecursiveCharacterTextSplitter

# Loaders
from langchain_community.document_loaders import (
    PyPDFLoader,
    TextLoader,
    CSVLoader,
    UnstructuredWordDocumentLoader,
    UnstructuredExcelLoader
)

from utils.logger import logger

class DocumentProcessor:
    """
    Processeur de documents pour le RAG.
    Extrait le texte des différents formats de fichiers.
    """
    
    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""]
        )
    
    async def process(self, file_path: str, file_ext: str) -> Dict[str, Any]:
        """
        Traiter un document et le découper en chunks.
        
        Args:
            file_path: Chemin vers le fichier
            file_ext: Extension du fichier (.pdf, .docx, etc.)
        
        Returns:
            Dict avec les chunks et les métadonnées
        """
        try:
            # Charger le document
            loader = self._get_loader(file_path, file_ext)
            documents = loader.load()
            
            logger.info(f"Loaded document with {len(documents)} pages/sections")
            
            # Découper en chunks
            chunks = self.text_splitter.split_documents(documents)
            
            logger.info(f"Split into {len(chunks)} chunks")
            
            return {
                "chunks": chunks,
                "total_pages": len(documents),
                "total_chunks": len(chunks)
            }
            
        except Exception as e:
            logger.error(f"Error processing document: {str(e)}")
            raise
    
    def _get_loader(self, file_path: str, file_ext: str):
        """
        Récupérer le loader approprié selon le type de fichier.
        
        Args:
            file_path: Chemin vers le fichier
            file_ext: Extension du fichier
        
        Returns:
            Instance du loader
        """
        loaders = {
            '.pdf': PyPDFLoader,
            '.txt': TextLoader,
            '.csv': CSVLoader,
            '.docx': UnstructuredWordDocumentLoader,
            '.doc': UnstructuredWordDocumentLoader,
            '.xlsx': UnstructuredExcelLoader,
            '.xls': UnstructuredExcelLoader
        }
        
        loader_class = loaders.get(file_ext.lower())
        
        if not loader_class:
            raise ValueError(f"Type de fichier non supporté: {file_ext}")
        
        # Configuration spécifique pour certains loaders
        if file_ext.lower() == '.csv':
            return loader_class(file_path, encoding='utf-8')
        
        return loader_class(file_path)
    
    def update_config(self, chunk_size: int = None, chunk_overlap: int = None):
        """
        Mettre à jour la configuration de découpage.
        
        Args:
            chunk_size: Nouvelle taille de chunk
            chunk_overlap: Nouveau chevauchement
        """
        if chunk_size:
            self.chunk_size = chunk_size
        if chunk_overlap:
            self.chunk_overlap = chunk_overlap
        
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""]
        )
        
        logger.info(f"Updated chunk config: size={self.chunk_size}, overlap={self.chunk_overlap}")
