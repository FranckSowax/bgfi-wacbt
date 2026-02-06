const promClient = require('prom-client');

// Créer un registre
const register = new promClient.Registry();

// Ajouter les métriques par défaut
promClient.collectDefaultMetrics({ register });

// ============================================
// Métriques personnalisées
// ============================================

// Compteur de messages envoyés
const campaignMessagesSent = new promClient.Counter({
  name: 'bgfi_campaign_messages_sent_total',
  help: 'Total de messages envoyés par campagne',
  labelNames: ['campaign_type', 'status'],
  registers: [register]
});

// Histogramme de durée des campagnes
const campaignDuration = new promClient.Histogram({
  name: 'bgfi_campaign_duration_seconds',
  help: 'Durée des campagnes en secondes',
  buckets: [60, 300, 600, 1800, 3600, 7200],
  registers: [register]
});

// Gauge des campagnes actives
const activeCampaigns = new promClient.Gauge({
  name: 'bgfi_active_campaigns',
  help: 'Nombre de campagnes actuellement actives',
  registers: [register]
});

// Compteur de contacts
const contactsTotal = new promClient.Counter({
  name: 'bgfi_contacts_total',
  help: 'Total de contacts',
  labelNames: ['segment', 'status'],
  registers: [register]
});

// Compteur de templates
const templatesTotal = new promClient.Counter({
  name: 'bgfi_templates_total',
  help: 'Total de templates',
  labelNames: ['category', 'status'],
  registers: [register]
});

// Histogramme de temps de réponse du chatbot
const chatbotResponseTime = new promClient.Histogram({
  name: 'bgfi_chatbot_response_time_seconds',
  help: 'Temps de réponse du chatbot',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register]
});

// Gauge de confiance du RAG
const ragConfidence = new promClient.Gauge({
  name: 'bgfi_rag_confidence',
  help: 'Score de confiance moyen du RAG',
  registers: [register]
});

// Compteur de documents indexés
const documentsIndexed = new promClient.Counter({
  name: 'bgfi_documents_indexed_total',
  help: 'Total de documents indexés',
  registers: [register]
});

// Compteur d'erreurs API
const apiErrors = new promClient.Counter({
  name: 'bgfi_api_errors_total',
  help: 'Total d\'erreurs API',
  labelNames: ['endpoint', 'status_code'],
  registers: [register]
});

// Histogramme de temps de réponse API
const apiResponseTime = new promClient.Histogram({
  name: 'bgfi_api_response_time_seconds',
  help: 'Temps de réponse des endpoints API',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
});

module.exports = {
  register,
  campaignMessagesSent,
  campaignDuration,
  activeCampaigns,
  contactsTotal,
  templatesTotal,
  chatbotResponseTime,
  ragConfidence,
  documentsIndexed,
  apiErrors,
  apiResponseTime
};
