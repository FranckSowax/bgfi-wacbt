const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const Redis = require('ioredis');

// Client Redis
const redisClient = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

// ============================================
// Rate limiter général pour l'API
// ============================================
const apiLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rl:api:'
  }),
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000, // 1000 requêtes par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Trop de requêtes',
    message: 'Veuillez réessayer plus tard'
  },
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json(options.message);
  }
});

// ============================================
// Rate limiter pour les campagnes
// ============================================
const campaignLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rl:campaign:'
  }),
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 10, // 10 campagnes par heure
  message: {
    error: 'Limite de campagnes atteinte',
    message: 'Vous ne pouvez créer que 10 campagnes par heure'
  }
});

// ============================================
// Rate limiter pour l'authentification
// ============================================
const authLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rl:auth:'
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 tentatives par 15 minutes
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
  store: new RedisStore({
    client: redisClient,
    prefix: 'rl:chatbot:'
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages par minute
  keyGenerator: (req) => {
    // Utiliser le sessionId ou l'IP comme clé
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
  store: new RedisStore({
    client: redisClient,
    prefix: 'rl:upload:'
  }),
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 10, // 10 uploads par heure
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
