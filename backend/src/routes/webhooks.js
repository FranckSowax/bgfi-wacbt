const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

const whatsappService = require('../services/whatsapp');
const ragService = require('../services/rag');
const enrichmentService = require('../services/enrichment');
const logger = require('../utils/logger');

// ============================================
// GET /webhooks/whatsapp - Vérification webhook Meta
// Meta envoie un GET avec hub.mode, hub.verify_token, hub.challenge
// ============================================
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const result = whatsappService.verifyWebhook(mode, token, challenge);

  if (result.valid) {
    logger.info('Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  logger.warn('Webhook verification failed', { mode, token });
  return res.sendStatus(403);
});

// ============================================
// POST /webhooks/whatsapp - Messages entrants WhatsApp Cloud API
// Format Meta: { object, entry: [{ changes: [{ value: { messages, statuses, contacts } }] }] }
// ============================================
router.post('/whatsapp', async (req, res) => {
  try {
    // Toujours répondre 200 immédiatement pour éviter les retries Meta
    res.status(200).json({ received: true });

    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        // Traiter les messages entrants
        if (value.messages) {
          for (const message of value.messages) {
            await handleIncomingMessage(message, value.contacts);
          }
        }

        // Traiter les mises à jour de statut
        if (value.statuses) {
          for (const status of value.statuses) {
            await handleStatusUpdate(status);
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error processing WhatsApp webhook', { error: error.message });
  }
});

// ============================================
// Gestionnaire: Message entrant
// ============================================
async function handleIncomingMessage(message, contacts) {
  try {
    const from = message.from; // numéro sans +
    const phone = '+' + from;
    const contactInfo = contacts?.find(c => c.wa_id === from);
    const contactName = contactInfo?.profile?.name;

    logger.info('Incoming WhatsApp message', {
      from: phone.replace(/\d(?=\d{4})/g, '*'),
      type: message.type
    });

    // Rechercher ou créer le contact
    let dbContact = await prisma.contact.findUnique({
      where: { phone }
    });

    if (!dbContact) {
      dbContact = await prisma.contact.create({
        data: {
          phone,
          name: contactName,
          whatsappId: from,
          optedIn: true,
          optedInAt: new Date()
        }
      });
      logger.info('New contact created from webhook', { contactId: dbContact.id });
    } else {
      await prisma.contact.update({
        where: { id: dbContact.id },
        data: { lastActivity: new Date() }
      });
    }

    // Gestion opt-out : STOP / ARRET / DESINSCRIRE
    if (message.type === 'text' && message.text?.body) {
      const textLower = message.text.body.trim().toLowerCase();
      if (['stop', 'arret', 'arreter', 'desinscrire', 'unsubscribe'].includes(textLower)) {
        await prisma.contact.update({
          where: { id: dbContact.id },
          data: { status: 'UNSUBSCRIBED', optedIn: false }
        });
        await whatsappService.sendMessage(phone, 'Vous avez ete desinscrit de nos communications. Pour vous reinscrire, envoyez START.').catch(() => {});
        logger.info('Contact opted out', { contactId: dbContact.id, phone: phone.replace(/\d(?=\d{4})/g, '*') });
        return;
      }
      // Gestion opt-in : START
      if (['start', 'ok', 'inscrire'].includes(textLower) && dbContact.status === 'UNSUBSCRIBED') {
        await prisma.contact.update({
          where: { id: dbContact.id },
          data: { status: 'ACTIVE', optedIn: true, optedInAt: new Date() }
        });
        await whatsappService.sendMessage(phone, 'Vous etes de nouveau inscrit a nos communications BGFI Bank. Bienvenue !').catch(() => {});
        logger.info('Contact opted back in', { contactId: dbContact.id });
        return;
      }
    }

    // Note: Le tracking des clics est géré par le redirect /t/:trackingId (server.js)
    // Les clics sur les boutons URL des templates passent par notre serveur de redirection

    // === Clic sur QUICK_REPLY d'un template -> declenche le menu interactif si configure ===
    if (message.type === 'button' && message.button) {
      const handled = await handleQuickReplyClick(message, dbContact, phone);
      if (handled) return; // menu envoye, on s'arrete la
    }

    // === Choix dans un INTERACTIVE LIST -> envoyer la reponse configuree ===
    if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
      const handled = await handleListReply(message.interactive.list_reply, dbContact, phone);
      if (handled) return;
    }

    // === Clic sur INTERACTIVE BUTTON REPLY (3 boutons reply) ===
    if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
      const handled = await handleListReply(message.interactive.button_reply, dbContact, phone);
      if (handled) return;
    }

    // Chatbot automatique : repond a tous les messages texte entrants via RAG
    if (message.type === 'text' && message.text?.body) {
      const text = message.text.body;
      const autoReply = process.env.CHATBOT_AUTO_REPLY !== 'false'; // ON par defaut

      if (autoReply) {
        try {
          // Utiliser le service RAG interne (pgvector + OpenAI)
          const result = await ragService.chat(text, dbContact.id);
          const botReply = result.response;

          if (botReply) {
            await whatsappService.sendMessage(phone, botReply);
            logger.info('Auto-reply sent via RAG', {
              contactId: dbContact.id,
              chunks_used: result.chunks_used,
              sources: result.sources
            });

            // Sauvegarder la session de chat + enrichissement async
            try {
              const session = await prisma.chatSession.create({
                data: {
                  contactId: dbContact.id,
                  source: 'whatsapp',
                  messages: [
                    { role: 'user', content: text, timestamp: new Date() },
                    { role: 'bot', content: botReply, timestamp: new Date() }
                  ]
                }
              });

              // Enrichissement IA async (fire-and-forget)
              enrichmentService.enrichConversation(session.id).catch(err => {
                logger.warn('Enrichment failed for session', { sessionId: session.id, error: err.message });
              });
            } catch (saveErr) {
              logger.warn('Failed to save chat session', { error: saveErr.message });
            }
          } else {
            logger.warn('No AI response available (check OPENAI_API_KEY)');
          }
        } catch (chatErr) {
          logger.error('Error in auto-reply', { error: chatErr.message });
          // Message de fallback en cas d'erreur
          const fallbackMsg = process.env.CHATBOT_FALLBACK_MESSAGE ||
            'Merci pour votre message. Un conseiller BGFI Bank vous repondra dans les plus brefs delais. Service client : 011 76 32 29';
          await whatsappService.sendMessage(phone, fallbackMsg).catch(() => {});
        }
      }
    }
  } catch (error) {
    logger.error('Error handling incoming message', { error: error.message });
  }
}

// ============================================
// Gestionnaire: Clic sur quick_reply d'un template -> envoyer le menu interactif
// ============================================
// Encode la cle de row pour qu'on puisse retrouver le template au list_reply
// Format: "tpl_<8 premiers chars de templateId>__<rowId original>"
function encodeRowId(templateId, originalId) {
  return `tpl_${String(templateId).slice(0, 8)}__${String(originalId).slice(0, 180)}`;
}
function decodeRowId(encoded) {
  if (!encoded || !encoded.startsWith('tpl_')) return null;
  const parts = encoded.slice(4).split('__');
  if (parts.length < 2) return null;
  return { templatePrefix: parts[0], originalId: parts.slice(1).join('__') };
}

async function handleQuickReplyClick(message, dbContact, phone) {
  try {
    const buttonText = message.button.text || message.button.payload;
    const originalMsgId = message.context?.id; // wamid du template envoye

    // Retrouver le template via le message original
    let template = null;
    if (originalMsgId) {
      const dbMsg = await prisma.message.findFirst({
        where: { externalId: originalMsgId },
        include: { campaign: { include: { template: true } } }
      });
      template = dbMsg?.campaign?.template || null;
    }

    // Fallback: chercher la campagne la plus recente avec template ayant un menu et matchant le bouton
    if (!template) {
      const recentMsg = await prisma.message.findFirst({
        where: { contactId: dbContact.id, status: { in: ['SENT', 'DELIVERED', 'READ'] } },
        orderBy: { sentAt: 'desc' },
        include: { campaign: { include: { template: true } } }
      });
      template = recentMsg?.campaign?.template || null;
    }

    if (!template?.interactiveMenu) return false;
    const menu = template.interactiveMenu;
    if (!menu.enabled) return false;

    // Si triggerButtonText configure, ne se declenche que pour ce texte
    if (menu.triggerButtonText && menu.triggerButtonText.trim() && menu.triggerButtonText.trim().toLowerCase() !== String(buttonText || '').trim().toLowerCase()) {
      return false;
    }

    // Encoder les ids des rows pour pouvoir retrouver le template au list_reply
    const sectionsEncoded = (menu.sections || []).map(sec => ({
      title: sec.title,
      rows: (sec.rows || []).map(r => ({
        id: encodeRowId(template.id, r.id || r.title),
        title: r.title,
        description: r.description
      }))
    }));

    const result = await whatsappService.sendInteractiveList(phone, {
      header: menu.header,
      body: menu.body,
      footer: menu.footer,
      buttonText: menu.buttonText,
      sections: sectionsEncoded
    });

    logger.info('Interactive menu sent after quick_reply', {
      contactId: dbContact.id,
      templateId: template.id,
      buttonText,
      success: result.success
    });
    return result.success;
  } catch (error) {
    logger.error('Error handling quick_reply click', { error: error.message });
    return false;
  }
}

// ============================================
// Gestionnaire: Choix d'une row de list / button_reply -> envoyer la reponse
// ============================================
async function handleListReply(reply, dbContact, phone) {
  try {
    const decoded = decodeRowId(reply.id);
    if (!decoded) return false;

    // Retrouver le template par prefix d'id (8 premiers chars)
    const templates = await prisma.template.findMany({
      where: { interactiveMenu: { not: null } }
    });
    const template = templates.find(t => t.id.startsWith(decoded.templatePrefix));
    if (!template?.interactiveMenu) return false;

    // Trouver la row correspondante par originalId
    const menu = template.interactiveMenu;
    let matchedRow = null;
    for (const sec of (menu.sections || [])) {
      for (const row of (sec.rows || [])) {
        if (String(row.id || row.title) === decoded.originalId) {
          matchedRow = row;
          break;
        }
      }
      if (matchedRow) break;
    }

    if (!matchedRow) return false;

    // Reponse statique configuree, ou fallback sur le RAG avec le titre comme query
    if (matchedRow.response && matchedRow.response.trim()) {
      await whatsappService.sendMessage(phone, matchedRow.response);
      logger.info('Static response sent for list_reply', { contactId: dbContact.id, templateId: template.id, rowTitle: matchedRow.title });
    } else {
      // Fallback RAG
      try {
        const result = await ragService.chat(matchedRow.title || reply.title, dbContact.id);
        if (result.response) {
          await whatsappService.sendMessage(phone, result.response);
          logger.info('RAG response sent for list_reply', { contactId: dbContact.id, rowTitle: matchedRow.title });
        }
      } catch (e) {
        logger.warn('RAG fallback failed for list_reply', { error: e.message });
        await whatsappService.sendMessage(phone, 'Merci pour votre choix. Un conseiller BGFI Bank vous repondra dans les plus brefs delais.').catch(() => {});
      }
    }
    return true;
  } catch (error) {
    logger.error('Error handling list_reply', { error: error.message });
    return false;
  }
}

// ============================================
// Gestionnaire: Mise à jour de statut WhatsApp
// statuses: sent, delivered, read, failed
// ============================================
async function handleStatusUpdate(status) {
  try {
    const externalId = status.id;
    const waStatus = status.status;

    // Log complet du statut recu de Meta (essentiel pour debug)
    logger.info('WhatsApp status webhook received', {
      externalId,
      status: waStatus,
      recipientId: status.recipient_id,
      timestamp: status.timestamp,
      errors: status.errors || null
    });

    const statusMap = {
      'sent': 'SENT',
      'delivered': 'DELIVERED',
      'read': 'READ',
      'failed': 'FAILED'
    };

    const dbStatus = statusMap[waStatus];
    if (!dbStatus) return;

    const dbMessage = await prisma.message.findFirst({
      where: { externalId }
    });

    if (!dbMessage) {
      logger.warn('Message not found for status update', { externalId, status: waStatus });
      return;
    }

    // Protection progression de statut : ne pas regresser (ex: DELIVERED → SENT)
    const statusOrder = { PENDING: 0, QUEUED: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 5 };
    if (statusOrder[dbStatus] <= statusOrder[dbMessage.status] && dbStatus !== 'FAILED') {
      logger.info('Status update skipped (not a progression)', { externalId, current: dbMessage.status, received: dbStatus });
      return;
    }

    const updateData = { status: dbStatus };
    if (dbStatus === 'DELIVERED') updateData.deliveredAt = new Date();
    if (dbStatus === 'READ') updateData.readAt = new Date();
    if (dbStatus === 'FAILED') {
      updateData.failedAt = new Date();
      // Capture complete des erreurs Meta (message, title, error_data.details)
      const errorInfo = status.errors?.[0];
      const errorMsg = errorInfo?.message || errorInfo?.title || 'Unknown error';
      const errorDetails = errorInfo?.error_data?.details;
      const errorCode = errorInfo?.code;
      updateData.error = errorDetails ? `[${errorCode}] ${errorMsg}: ${errorDetails}` : errorCode ? `[${errorCode}] ${errorMsg}` : errorMsg;
      logger.warn('Message delivery FAILED', { externalId, error: updateData.error, errorFull: errorInfo });
    }

    await prisma.message.update({
      where: { id: dbMessage.id },
      data: updateData
    });

    // Mettre a jour les statistiques de la campagne (increments uniquement)
    if (dbMessage.campaignId) {
      const campaignUpdate = {};
      if (dbStatus === 'DELIVERED') campaignUpdate.delivered = { increment: 1 };
      if (dbStatus === 'READ') campaignUpdate.read = { increment: 1 };
      if (dbStatus === 'FAILED') campaignUpdate.failed = { increment: 1 };

      if (Object.keys(campaignUpdate).length > 0) {
        await prisma.campaign.update({
          where: { id: dbMessage.campaignId },
          data: campaignUpdate
        });
      }
    }

    logger.info('Message status updated', { externalId, status: dbStatus, messageId: dbMessage.id });
  } catch (error) {
    logger.error('Error updating message status', { error: error.message, stack: error.stack });
  }
}

// ============================================
// GET /webhooks/health - Health check
// ============================================
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'webhooks',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
