const serverless = require('serverless-http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

// Import routes
const authRoutes = require('../../backend/src/routes/auth');
const campaignRoutes = require('../../backend/src/routes/campaigns');
const contactRoutes = require('../../backend/src/routes/contacts');
const templateRoutes = require('../../backend/src/routes/templates');
const chatbotRoutes = require('../../backend/src/routes/chatbot');
const analyticsRoutes = require('../../backend/src/routes/analytics');
const webhookRoutes = require('../../backend/src/routes/webhooks');
const { errorHandler } = require('../../backend/src/middleware/errorHandler');

const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), environment: 'netlify-functions' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/webhooks', webhookRoutes);

// Error handling
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée', path: req.path });
});

// Export for Netlify Functions
module.exports.handler = serverless(app, {
  basePath: '/.netlify/functions/api'
});
