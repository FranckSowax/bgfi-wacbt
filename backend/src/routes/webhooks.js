const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const respondIOService = require('../services/respondio');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// POST /webhooks/respondio/incoming
// Webhook pour les messages entrants de Respond.io
// ============================================
router.post('/respondio/incoming', async (req, res) => {
  try {
    const signature = req.headers['x-respondio-signature'];
    
    // Vérifier la signature
    if (!respondIOService.verifyWebhookSignature(req.body, signature)) {
      logger.warn('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { event, data } = req.body;

    logger.info('Received webhook from Respond.io', { event, messageId: data?.messageId });

    switch (event) {
      case 'message.received':
        await handleIncomingMessage(data);
        break;
        
      case 'message.delivered':
        await updateMessageStatus(data.messageId, 'DELIVERED', { deliveredAt: new Date() });
        break;
        
      case 'message.read':
        await updateMessageStatus(data.messageId, 'READ', { readAt: new Date() });
        break;
        
      case 'message.failed':
        await handleFailedMessage(data);
        break;
        
      case 'contact.created':
        await handleContactCreated(data);
        break;
        
      case 'contact.updated':
        await handleContactUpdated(data);
        break;
        
      default:
        logger.info('Unhandled webhook event', { event });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Error processing webhook', { error: error.message });
    // Toujours retourner 200 pour éviter les retries infinis
    res.status(200).json({ received: true, error: error.message });
  }
});

// ============================================
// Gestionnaire: Message entrant
// ============================================
async function handleIncomingMessage(data) {
  try {
    const { contact, message } = data;
    
    logger.info('Incoming message', { 
      from: contact.phone.replace(/\d(?=\d{4})/g, '*'),
      type: message.type 
    });

    // Rechercher ou créer le contact
    let dbContact = await prisma.contact.findUnique({
      where: { phone: contact.phone }
    });

    if (!dbContact) {
      dbContact = await prisma.contact.create({
        data: {
          phone: contact.phone,
          name: contact.name,
          whatsappId: contact.id,
          optedIn: true,
          optedInAt: new Date()
        }
      });
      logger.info('New contact created from webhook', { contactId: dbContact.id });
    } else {
      // Mettre à jour la dernière activité
      await prisma.contact.update({
        where: { id: dbContact.id },
        data: { lastActivity: new Date() }
      });
    }

    // Si c'est un message texte, potentiellement l'envoyer au chatbot RAG
    if (message.type === 'text') {
      // Vérifier si le contact a initié une conversation avec le chatbot
      const recentSession = await prisma.chatSession.findFirst({
        where: {
          contactId: dbContact.id,
          updatedAt: {
            gte: new Date(Date.now() - 30 * 60 * 1000) // 30 minutes
          }
        },
        orderBy: { updatedAt: 'desc' }
      });

      // Si le message contient des mots-clés du chatbot ou s'il y a une session active
      const chatbotKeywords = ['aide', 'help', 'assistant', 'bot', 'cassiopee', 'question'];
      const isChatbotRequest = chatbotKeywords.some(kw => 
        message.text.toLowerCase().includes(kw)
      );

      if (isChatbotRequest || recentSession) {
        // Appeler le service RAG
        const axios = require('axios');
        const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || 'http://localhost:8000';
        
        try {
          const ragResponse = await axios.post(`${RAG_SERVICE_URL}/chat`, {
            message: message.text,
            contact_id: dbContact.id
          });

          // Envoyer la réponse via Respond.io
          await respondIOService.sendMessage(
            contact.phone,
            ragResponse.data.response
          );

          logger.info('Chatbot response sent', { 
            contactId: dbContact.id,
            confidence: ragResponse.data.confidence 
          });
        } catch (ragError) {
          logger.error('Error getting RAG response', { error: ragError.message });
          
          // Message de secours
          await respondIOService.sendMessage(
            contact.phone,
            'Désolé, je ne peux pas traiter votre demande pour le moment. Veuillez contacter le service client au 0770 12 34 56.'
          );
        }
      }
    }
  } catch (error) {
    logger.error('Error handling incoming message', { error: error.message });
  }
}

// ============================================
// Gestionnaire: Mise à jour du statut d'un message
// ============================================
async function updateMessageStatus(externalId, status, additionalData = {}) {
  try {
    const message = await prisma.message.findFirst({
      where: { externalId }
    });

    if (!message) {
      logger.warn('Message not found for status update', { externalId });
      return;
    }

    await prisma.message.update({
      where: { id: message.id },
      data: {
        status,
        ...additionalData
      }
    });

    // Mettre à jour les statistiques de la campagne si applicable
    if (message.campaignId) {
      const updateData = {};
      
      if (status === 'DELIVERED') {
        updateData.delivered = { increment: 1 };
      } else if (status === 'READ') {
        updateData.read = { increment: 1 };
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.campaign.update({
          where: { id: message.campaignId },
          data: updateData
        });
      }
    }

    logger.info('Message status updated', { externalId, status });
  } catch (error) {
    logger.error('Error updating message status', { error: error.message, externalId });
  }
}

// ============================================
// Gestionnaire: Message échoué
// ============================================
async function handleFailedMessage(data) {
  try {
    const { messageId, error } = data;

    await updateMessageStatus(messageId, 'FAILED', {
      failedAt: new Date(),
      error: error?.message || 'Unknown error'
    });

    // Incrémenter le compteur d'échecs de la campagne
    const message = await prisma.message.findFirst({
      where: { externalId: messageId }
    });

    if (message?.campaignId) {
      await prisma.campaign.update({
        where: { id: message.campaignId },
        data: { failed: { increment: 1 } }
      });
    }

    logger.warn('Message failed', { messageId, error: error?.message });
  } catch (err) {
    logger.error('Error handling failed message', { error: err.message });
  }
}

// ============================================
// Gestionnaire: Contact créé
// ============================================
async function handleContactCreated(data) {
  try {
    const { id, phone, name } = data;

    // Vérifier si le contact existe déjà
    const existingContact = await prisma.contact.findUnique({
      where: { phone }
    });

    if (!existingContact) {
      await prisma.contact.create({
        data: {
          phone,
          name,
          whatsappId: id,
          optedIn: true,
          optedInAt: new Date()
        }
      });

      logger.info('Contact created from webhook', { phone: phone.replace(/\d(?=\d{4})/g, '*') });
    }
  } catch (error) {
    logger.error('Error handling contact created', { error: error.message });
  }
}

// ============================================
// Gestionnaire: Contact mis à jour
// ============================================
async function handleContactUpdated(data) {
  try {
    const { id, phone, name } = data;

    await prisma.contact.updateMany({
      where: { whatsappId: id },
      data: {
        phone,
        name,
        lastActivity: new Date()
      }
    });

    logger.info('Contact updated from webhook', { whatsappId: id });
  } catch (error) {
    logger.error('Error handling contact updated', { error: error.message });
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
