const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

// ============================================
// Configuration Redis (optionnel)
// Fallback sur in-memory si Redis non disponible
// ============================================

let storeConfig = {};
let redisClient = null;

const redisEnabled = process.env.REDIS_ENABLED !== 'false' && process.env.REDIS_HOST;

if (redisEnabled) {
  try {
    const RedisStore = require('rate-limit-redis');
    const Redis = require('ioredis');

    redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      }
    });

    redisClient.on('error', (err) => {
      logger.warn('Redis error, using in-memory fallback', { error: err.message });
    });

    storeConfig = {
      store: new RedisStore({ client: redisClient, prefix: 'rl:' })
    };

    logger.info('Rate limiting: using Redis store');
  } catch (error) {
    logger.warn('Redis not available, using in-memory rate limiting');
  }
} else {
  logger.info('Rate limiting: using in-memory store (Redis disabled)');
}

// ============================================
// Rate limiter général pour l'API
// ============================================
const apiLimiter = rateLimit({
  ...storeConfig,
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Trop de requêtes',
    message: 'Veuillez réessayer plus tard'
  }
});

// ============================================
// Rate limiter pour les campagnes
// ============================================
const campaignLimiter = rateLimit({
  ...storeConfig,
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: {
    error: 'Limite de campagnes atteinte',
    message: 'Vous ne pouvez créer que 10 campagnes par heure'
  }
});

// ============================================
// Rate limiter pour l'authentification
// ============================================
const authLimiter = rateLimit({
  ...storeConfig,
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  message: {
    error: 'Trop de tentatives',
    message: 'Veuillez réessayer dans 15 minutes'
  }
});

// ============================================
// Rate limiter pour le chatbot
// ============================================
const chatbotLimiter = rateLimit({
  ...storeConfig,
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => {
    return req.body.sessionId || req.ip;
  },
  message: {
    error: 'Trop de messages',
    message: 'Veuillez ralentir le rythme des messages'
  }
});

// ============================================
// Rate limiter pour les uploads
// ============================================
const uploadLimiter = rateLimit({
  ...storeConfig,
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: {
    error: 'Limite d\'upload atteinte',
    message: 'Vous ne pouvez uploader que 10 fichiers par heure'
  }
});

module.exports = {
  apiLimiter,
  campaignLimiter,
  authLimiter,
  chatbotLimiter,
  uploadLimiter,
  redisClient
};
