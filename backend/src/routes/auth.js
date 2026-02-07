const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const { authLimiter } = require('../middleware/rateLimit');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// POST /api/auth/login - Connexion
// ============================================
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        error: 'Données manquantes',
        message: 'Email et mot de passe requis'
      });
    }

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
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role = 'OPERATOR' } = req.body;

    // Validation
    if (!email || !password || !name) {
      return res.status(400).json({
        error: 'Données manquantes',
        message: 'Email, mot de passe et nom requis'
      });
    }

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
router.post('/refresh', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: 'Token manquant',
        message: 'Le token à rafraîchir est requis'
      });
    }

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
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Données manquantes',
        message: 'Mot de passe actuel et nouveau mot de passe requis'
      });
    }

    // Récupérer l'utilisateur depuis le token (middleware auth requis)
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'Non authentifié',
        message: 'Vous devez être connecté pour changer votre mot de passe'
      });
    }

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
