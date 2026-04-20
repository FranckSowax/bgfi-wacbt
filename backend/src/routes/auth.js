const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

const { authLimiter } = require('../middleware/rateLimit');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const logger = require('../utils/logger');

// ============================================
// POST /api/auth/login - Connexion
// ============================================
router.post('/login', authLimiter, validate({ body: schemas.auth.login }), async (req, res) => {
  try {
    const { email, password } = req.body;

    // Rechercher l'utilisateur
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(401).json({
        error: 'Authentification échouée',
        message: 'Email ou mot de passe incorrect'
      });
    }

    // Vérifier le mot de passe
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Authentification échouée',
        message: 'Email ou mot de passe incorrect'
      });
    }

    // Vérifier si le compte est actif
    if (!user.isActive) {
      return res.status(401).json({
        error: 'Compte désactivé',
        message: 'Votre compte a été désactivé. Contactez un administrateur.'
      });
    }

    // Générer le token JWT
    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Mettre à jour la dernière connexion
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() }
    });

    logger.info('User logged in', { userId: user.id, email: user.email });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    logger.error('Login error: ' + error.message);
    res.status(500).json({
      error: 'Erreur de connexion',
      message: 'Une erreur interne est survenue'
    });
  }
});

// ============================================
// POST /api/auth/register - Inscription (admin uniquement)
// ============================================
router.post('/register', authenticate, requireRole('ADMIN'), validate({ body: schemas.auth.register }), async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // Vérifier si l'email existe déjà
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(409).json({
        error: 'Conflit',
        message: 'Un utilisateur avec cet email existe déjà'
      });
    }

    // Hasher le mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);

    // Créer l'utilisateur
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role
      }
    });

    logger.info('User registered', { userId: user.id, email: user.email });

    res.status(201).json({
      message: 'Utilisateur créé avec succès',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    logger.error('Registration error', { error: error.message });
    res.status(500).json({
      error: 'Erreur d\'inscription',
      message: 'Une erreur est survenue lors de la création du compte'
    });
  }
});

// ============================================
// POST /api/auth/refresh - Rafraîchir le token
// ============================================
router.post('/refresh', validate({ body: schemas.auth.refresh }), async (req, res) => {
  try {
    const { token } = req.body;

    // Vérifier le token
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });

    // Vérifier que l'utilisateur existe toujours
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: 'Token invalide',
        message: 'L\'utilisateur n\'existe plus ou est désactivé'
      });
    }

    // Générer un nouveau token
    const newToken = jwt.sign(
      { 
        userId: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token: newToken });
  } catch (error) {
    logger.error('Token refresh error', { error: error.message });
    res.status(401).json({
      error: 'Token invalide',
      message: 'Le token ne peut pas être rafraîchi'
    });
  }
});

// ============================================
// POST /api/auth/logout - Déconnexion
// ============================================
router.post('/logout', async (req, res) => {
  // En l'absence de blacklist de tokens, le logout est géré côté client
  // En production, ajouter le token à une blacklist Redis
  res.json({ message: 'Déconnexion réussie' });
});

// ============================================
// POST /api/auth/change-password - Changer le mot de passe
// ============================================
router.post('/change-password', authenticate, validate({ body: schemas.auth.changePassword }), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    // Vérifier le mot de passe actuel
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);

    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Mot de passe incorrect',
        message: 'Le mot de passe actuel est incorrect'
      });
    }

    // Hasher le nouveau mot de passe
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Mettre à jour le mot de passe
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword }
    });

    logger.info('Password changed', { userId });

    res.json({ message: 'Mot de passe changé avec succès' });
  } catch (error) {
    logger.error('Password change error', { error: error.message });
    res.status(500).json({
      error: 'Erreur',
      message: 'Une erreur est survenue lors du changement de mot de passe'
    });
  }
});

module.exports = router;
