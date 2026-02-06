const logger = require('../utils/logger');

/**
 * Middleware de gestion des erreurs
 */
const errorHandler = (err, req, res, next) => {
  // Log l'erreur
  logger.error('Error occurred', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id
  });

  // Erreurs Prisma
  if (err.code && err.code.startsWith('P')) {
    switch (err.code) {
      case 'P2002':
        return res.status(409).json({
          error: 'Conflit',
          message: 'Une ressource avec ces données existe déjà',
          field: err.meta?.target?.[0]
        });
      
      case 'P2025':
        return res.status(404).json({
          error: 'Non trouvé',
          message: 'La ressource demandée n\'existe pas'
        });
      
      case 'P2003':
        return res.status(400).json({
          error: 'Contrainte de clé étrangère',
          message: 'La ressource référencée n\'existe pas'
        });
      
      default:
        return res.status(500).json({
          error: 'Erreur de base de données',
          message: process.env.NODE_ENV === 'development' ? err.message : 'Une erreur est survenue'
        });
    }
  }

  // Erreurs de validation
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation échouée',
      message: err.message,
      details: err.errors
    });
  }

  // Erreurs JWT
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Token invalide',
      message: 'Le token d\'authentification est invalide'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token expiré',
      message: 'Veuillez vous reconnecter'
    });
  }

  // Erreur par défaut
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Erreur interne du serveur';

  res.status(statusCode).json({
    error: statusCode === 500 ? 'Erreur interne' : 'Erreur',
    message: process.env.NODE_ENV === 'development' ? message : 'Une erreur est survenue',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = { errorHandler };
