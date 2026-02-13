// ============================================
// Service d'enrichissement IA des conversations
// Analyse automatique des conversations chatbot
// pour extraire des indicateurs bancaires
// ============================================

const { PrismaClient } = require('@prisma/client');
const fetch = require('node-fetch');
const logger = require('../utils/logger');
const ragService = require('./rag');
const { logTokenUsage } = ragService;

const prisma = new PrismaClient();

// Valeurs valides pour validation
const VALID_INTENTS = ['ACCOUNT_INQUIRY', 'LOAN_REQUEST', 'CARD_ISSUE', 'TRANSFER_HELP', 'COMPLAINT', 'PRODUCT_INFO', 'ACCOUNT_OPENING', 'FEES_CHARGES', 'MOBILE_BANKING', 'GENERAL'];
const VALID_PRODUCTS = ['SAVINGS_ACCOUNT', 'CURRENT_ACCOUNT', 'CREDIT_CARD', 'PERSONAL_LOAN', 'MORTGAGE', 'INSURANCE', 'MOBILE_BANKING', 'VISA_CARD', 'NONE'];
const VALID_SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'FRUSTRATED'];
const VALID_URGENCY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const VALID_RESOLUTION = ['RESOLVED', 'UNRESOLVED', 'ESCALATION_NEEDED', 'FOLLOW_UP_REQUIRED'];

const ENRICHMENT_PROMPT = `Tu es un analyste specialise dans les services bancaires de BGFI Bank Gabon.
Analyse la conversation suivante entre un client WhatsApp et Stella (le chatbot IA de BGFI Bank).

Retourne UNIQUEMENT un objet JSON valide avec les champs suivants:
- "intentCategory": une valeur parmi [ACCOUNT_INQUIRY, LOAN_REQUEST, CARD_ISSUE, TRANSFER_HELP, COMPLAINT, PRODUCT_INFO, ACCOUNT_OPENING, FEES_CHARGES, MOBILE_BANKING, GENERAL]
- "productMentioned": une valeur parmi [SAVINGS_ACCOUNT, CURRENT_ACCOUNT, CREDIT_CARD, PERSONAL_LOAN, MORTGAGE, INSURANCE, MOBILE_BANKING, VISA_CARD, NONE]
- "sentiment": une valeur parmi [POSITIVE, NEUTRAL, NEGATIVE, FRUSTRATED]
- "urgencyLevel": une valeur parmi [LOW, MEDIUM, HIGH, CRITICAL]
- "resolutionStatus": une valeur parmi [RESOLVED, UNRESOLVED, ESCALATION_NEEDED, FOLLOW_UP_REQUIRED]
- "satisfactionScore": un nombre entre 1.0 et 5.0 (1=tres insatisfait, 5=tres satisfait)
- "customerNeedSummary": resume en 1-2 phrases le besoin reel du client (en francais)
- "actionRequired": true si le client a besoin d'un suivi humain, false sinon
- "actionDescription": si actionRequired est true, decris l'action necessaire (en francais)
- "topicTags": tableau de 1-5 tags pertinents en francais (ex: ["solde", "virement", "carte"])
- "language": "FR" ou "EN" selon la langue detectee

Conversation:
`;

/**
 * Enrichir une session de chat avec l'analyse IA
 */
async function enrichConversation(sessionId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('Enrichment skipped: OPENAI_API_KEY not configured');
    return null;
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId }
  });

  if (!session) {
    logger.warn('Enrichment: session not found', { sessionId });
    return null;
  }

  if (session.enriched) {
    logger.info('Enrichment: session already enriched', { sessionId });
    return session;
  }

  // Formater les messages en dialogue lisible
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (messages.length === 0) {
    logger.warn('Enrichment: no messages in session', { sessionId });
    return null;
  }

  const dialogue = messages.map(m => {
    const role = m.role === 'user' ? 'Client' : 'Stella (Bot)';
    return `${role}: ${m.content}`;
  }).join('\n');

  // response_format json_object requires gpt-4-turbo, gpt-4o, gpt-4.1 or later (NOT base gpt-4)
  const baseModel = process.env.ENRICHMENT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';
  const model = baseModel === 'gpt-4' ? 'gpt-4.1' : baseModel;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: ENRICHMENT_PROMPT },
          { role: 'user', content: dialogue }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Erreur OpenAI enrichissement');
    }

    // Track token usage
    if (data.usage) {
      logTokenUsage('enrichment', model, data.usage);
    }

    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Reponse vide de OpenAI');
    }

    const result = JSON.parse(content);

    // Valider et nettoyer les valeurs
    const enrichment = {
      enriched: true,
      intentCategory: VALID_INTENTS.includes(result.intentCategory) ? result.intentCategory : 'GENERAL',
      productMentioned: VALID_PRODUCTS.includes(result.productMentioned) ? result.productMentioned : 'NONE',
      sentiment: VALID_SENTIMENTS.includes(result.sentiment) ? result.sentiment : 'NEUTRAL',
      urgencyLevel: VALID_URGENCY.includes(result.urgencyLevel) ? result.urgencyLevel : 'LOW',
      resolutionStatus: VALID_RESOLUTION.includes(result.resolutionStatus) ? result.resolutionStatus : 'UNRESOLVED',
      satisfactionScore: typeof result.satisfactionScore === 'number'
        ? Math.min(5, Math.max(1, result.satisfactionScore))
        : null,
      customerNeedSummary: typeof result.customerNeedSummary === 'string'
        ? result.customerNeedSummary.substring(0, 500)
        : null,
      actionRequired: result.actionRequired === true,
      actionDescription: result.actionRequired && typeof result.actionDescription === 'string'
        ? result.actionDescription.substring(0, 500)
        : null,
      topicTags: Array.isArray(result.topicTags)
        ? result.topicTags.filter(t => typeof t === 'string').slice(0, 5)
        : [],
      language: result.language === 'EN' ? 'EN' : 'FR'
    };

    // Sauvegarder l'enrichissement
    const updated = await prisma.chatSession.update({
      where: { id: sessionId },
      data: enrichment
    });

    logger.info('Conversation enriched', {
      sessionId,
      intent: enrichment.intentCategory,
      sentiment: enrichment.sentiment,
      satisfaction: enrichment.satisfactionScore,
      actionRequired: enrichment.actionRequired
    });

    return updated;
  } catch (error) {
    logger.error('Enrichment failed', { sessionId, error: error.message, stack: error.stack });
    return { error: error.message };
  }
}

/**
 * Enrichir un batch de sessions non-enrichies
 */
async function enrichBatch(limit = 50) {
  const sessions = await prisma.chatSession.findMany({
    where: { enriched: false },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true }
  });

  logger.info(`Enrichment batch: ${sessions.length} sessions to process`);

  let enriched = 0;
  let failed = 0;
  let lastError = null;

  for (const session of sessions) {
    const result = await enrichConversation(session.id);
    if (result && !result.error) {
      enriched++;
    } else {
      failed++;
      lastError = result?.error || 'Unknown error';
    }

    // Rate limiting: 500ms entre chaque appel
    if (sessions.indexOf(session) < sessions.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  logger.info('Enrichment batch completed', { enriched, failed, total: sessions.length, lastError });
  return { enriched, failed, total: sessions.length, lastError };
}

/**
 * Generer un rapport quotidien
 */
async function generateDailyReport(dateStr) {
  const apiKey = process.env.OPENAI_API_KEY;
  const date = dateStr ? new Date(dateStr) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  date.setUTCHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setUTCHours(23, 59, 59, 999);

  // Requeter les sessions enrichies du jour
  const sessions = await prisma.chatSession.findMany({
    where: {
      createdAt: { gte: date, lte: endOfDay },
      enriched: true
    }
  });

  const allSessions = await prisma.chatSession.count({
    where: {
      createdAt: { gte: date, lte: endOfDay }
    }
  });

  // Aggreger les stats
  const stats = {
    totalConversations: allSessions,
    whatsappConversations: sessions.filter(s => s.source === 'whatsapp').length,
    webConversations: sessions.filter(s => s.source === 'web').length,
    sentimentPositive: sessions.filter(s => s.sentiment === 'POSITIVE').length,
    sentimentNeutral: sessions.filter(s => s.sentiment === 'NEUTRAL').length,
    sentimentNegative: sessions.filter(s => s.sentiment === 'NEGATIVE').length,
    sentimentFrustrated: sessions.filter(s => s.sentiment === 'FRUSTRATED').length,
    resolvedCount: sessions.filter(s => s.resolutionStatus === 'RESOLVED').length,
    unresolvedCount: sessions.filter(s => s.resolutionStatus === 'UNRESOLVED').length,
    escalationCount: sessions.filter(s => s.resolutionStatus === 'ESCALATION_NEEDED').length,
    followUpCount: sessions.filter(s => s.resolutionStatus === 'FOLLOW_UP_REQUIRED').length
  };

  // Intent breakdown
  const intentBreakdown = {};
  sessions.forEach(s => {
    if (s.intentCategory) {
      intentBreakdown[s.intentCategory] = (intentBreakdown[s.intentCategory] || 0) + 1;
    }
  });

  // Product breakdown
  const productBreakdown = {};
  sessions.forEach(s => {
    if (s.productMentioned && s.productMentioned !== 'NONE') {
      productBreakdown[s.productMentioned] = (productBreakdown[s.productMentioned] || 0) + 1;
    }
  });

  // Average satisfaction
  const scores = sessions.filter(s => s.satisfactionScore != null).map(s => s.satisfactionScore);
  const avgSatisfactionScore = scores.length > 0
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : null;

  // Top customer needs
  const needs = sessions
    .filter(s => s.customerNeedSummary)
    .map(s => s.customerNeedSummary);

  let keyInsights = null;
  let recommendations = null;
  let topCustomerNeeds = needs.slice(0, 10);

  // Generer insights IA si des donnees existent et API key disponible
  if (sessions.length > 0 && apiKey) {
    try {
      const reportPrompt = `Tu es un analyste bancaire de BGFI Bank Gabon. Voici les statistiques des conversations chatbot du ${date.toLocaleDateString('fr-FR')}:

- Total conversations: ${stats.totalConversations} (${stats.whatsappConversations} WhatsApp, ${stats.webConversations} web)
- Sentiments: ${stats.sentimentPositive} positif, ${stats.sentimentNeutral} neutre, ${stats.sentimentNegative} negatif, ${stats.sentimentFrustrated} frustre
- Intentions: ${JSON.stringify(intentBreakdown)}
- Produits: ${JSON.stringify(productBreakdown)}
- Resolution: ${stats.resolvedCount} resolues, ${stats.unresolvedCount} non resolues, ${stats.escalationCount} escaladees, ${stats.followUpCount} suivi requis
- Satisfaction moyenne: ${avgSatisfactionScore || 'N/A'}/5
- Besoins exprimes: ${needs.slice(0, 15).join(' | ')}

Retourne un JSON avec:
- "topCustomerNeeds": tableau des 5 besoins clients les plus importants (resumes, en francais)
- "keyInsights": paragraphe d'analyse des tendances (3-5 phrases, en francais)
- "recommendations": paragraphe de recommandations pour ameliorer le service (3-5 phrases, en francais)`;

      const reportBaseModel = process.env.ENRICHMENT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';
      const reportModel = reportBaseModel === 'gpt-4' ? 'gpt-4.1' : reportBaseModel;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: reportModel,
          temperature: 0.3,
          max_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: reportPrompt },
            { role: 'user', content: 'Genere le rapport JSON.' }
          ]
        })
      });

      const data = await response.json();
      // Track token usage
      if (data.usage) {
        logTokenUsage('report', reportModel, data.usage);
      }
      if (response.ok && data.choices[0]?.message?.content) {
        const result = JSON.parse(data.choices[0].message.content);
        topCustomerNeeds = Array.isArray(result.topCustomerNeeds) ? result.topCustomerNeeds.slice(0, 5) : topCustomerNeeds;
        keyInsights = result.keyInsights || null;
        recommendations = result.recommendations || null;
      }
    } catch (err) {
      logger.warn('Failed to generate AI insights for report', { error: err.message });
    }
  }

  // Upsert le rapport (un seul par jour)
  const report = await prisma.dailyReport.upsert({
    where: { date },
    create: {
      date,
      ...stats,
      intentBreakdown,
      productBreakdown,
      avgSatisfactionScore,
      topCustomerNeeds,
      keyInsights,
      recommendations
    },
    update: {
      ...stats,
      intentBreakdown,
      productBreakdown,
      avgSatisfactionScore,
      topCustomerNeeds,
      keyInsights,
      recommendations,
      generatedAt: new Date()
    }
  });

  logger.info('Daily report generated', {
    date: date.toISOString().split('T')[0],
    totalConversations: stats.totalConversations,
    enrichedSessions: sessions.length
  });

  return report;
}

/**
 * Alimenter la base RAG avec un rapport
 */
async function feedReportToRag(reportId) {
  const report = await prisma.dailyReport.findUnique({ where: { id: reportId } });
  if (!report) throw new Error('Rapport non trouve');

  const dateStr = report.date.toLocaleDateString('fr-FR');

  const content = `Rapport quotidien des conversations BGFI Bank - ${dateStr}

Statistiques:
- ${report.totalConversations} conversations (${report.whatsappConversations} WhatsApp, ${report.webConversations} web)
- Score satisfaction moyen: ${report.avgSatisfactionScore?.toFixed(1) || 'N/A'}/5
- ${report.resolvedCount} resolues, ${report.unresolvedCount} non resolues, ${report.escalationCount} escaladees

Sentiments: ${report.sentimentPositive} positif, ${report.sentimentNeutral} neutre, ${report.sentimentNegative} negatif, ${report.sentimentFrustrated} frustre

Besoins clients principaux:
${(report.topCustomerNeeds || []).map((need, i) => `${i + 1}. ${need}`).join('\n')}

Analyse:
${report.keyInsights || 'Aucune analyse disponible'}

Recommandations:
${report.recommendations || 'Aucune recommandation disponible'}`;

  const title = `Rapport conversations du ${dateStr}`;
  const doc = await ragService.addDocument(title, content, 'report', {
    type: 'daily_report',
    date: report.date.toISOString()
  });

  logger.info('Report fed to RAG', { reportId, docId: doc.id });
  return doc;
}

module.exports = {
  enrichConversation,
  enrichBatch,
  generateDailyReport,
  feedReportToRag
};
