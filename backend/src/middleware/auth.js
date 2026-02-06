const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Middleware d'authentification JWT
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authentification requise',
        message: 'Token JWT manquant'
      });
    }

    const token = authHeader.split(' ')[1];
    
    // Vérifier le token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Récupérer l'utilisateur
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true
      }
    });

    if (!user) {
      return res.status(401).json({ 
        error: 'Utilisateur non trouvé',
        message: 'Le token est valide mais l\'utilisateur n\'existe plus'
      });
    }

    if (!user.isActive) {
      return res.status(401).json({ 
        error: 'Compte désactivé',
        message: 'Votre compte a été désactivé'
      });
    }

    // Ajouter l'utilisateur à la requête
    req.user = user;
    
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Token invalide',
        message: 'Le token JWT est malformé'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Token expiré',
        message: 'Veuillez vous reconnecter'
      });
    }

    console.error('Auth error:', error);
    return res.status(500).json({ 
      error: 'Erreur d\'authentification',
      message: error.message
    });
  }
};

/**
 * Middleware d'autorisation par permissions
 */
const authorize = (permissions) => {
  return (req, res, next) => {
    // Les admins ont toutes les permissions
    if (req.user.role === 'ADMIN') {
      return next();
    }

    // Vérifier les permissions
    const userPermissions = req.user.permissions || [];
    
    const hasPermission = permissions.some(permission => 
      userPermissions.includes(permission)
    );

    if (!hasPermission) {
      return res.status(403).json({ 
        error: 'Accès refusé',
        message: 'Vous n\'avez pas les permissions nécessaires',
        required: permissions
      });
    }

    next();
  };
};

/**
 * Middleware d'autorisation par rôle
 */
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Accès refusé',
        message: `Rôle requis: ${roles.join(' ou ')}`,
        yourRole: req.user.role
      });
    }

    next();
  };
};

module.exports = {
  authenticate,
  authorize,
  requireRole
};
