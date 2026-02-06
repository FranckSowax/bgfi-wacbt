const axios = require('axios');
const logger = require('../utils/logger');

const RESPOND_IO_BASE_URL = 'https://api.respond.io/v1';

class RespondIOService {
  constructor() {
    this.apiKey = process.env.RESPOND_IO_API_KEY;
    this.client = axios.create({
      baseURL: RESPOND_IO_BASE_URL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  /**
   * Envoyer un message WhatsApp
   */
  async sendMessage(phone, message, options = {}) {
    try {
      const payload = {
        channelId: options.channelId || process.env.RESPOND_IO_CHANNEL_ID,
        recipient: {
          type: 'whatsapp',
          id: phone
        },
        message: {
          type: options.type || 'text',
          text: message
        }
      };

      if (options.template) {
        payload.message = {
          type: 'template',
          template: {
            name: options.template.name,
            language: { code: options.template.language || 'fr' },
            components: options.template.components || []
          }
        };
      }

      const response = await this.client.post('/messages', payload);
      
      logger.info(`Message envoyé à ${phone}`, {
        messageId: response.data.id,
        phone: phone.replace(/\d(?=\d{4})/g, '*')
      });

      return {
        success: true,
        messageId: response.data.id,
        status: response.data.status
      };
    } catch (error) {
      logger.error(`Erreur envoi message à ${phone}`, {
        error: error.message,
        phone: phone.replace(/\d(?=\d{4})/g, '*')
      });

      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Envoyer des messages en batch
   */
  async sendBatch(messages, options = {}) {
    const results = {
      sent: 0,
      failed: 0,
      errors: []
    };

    // Rate limiting: 80 messages/second
    const batchSize = options.batchSize || 80;
    const delay = options.delay || 1000;

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (msg) => {
        const result = await this.sendMessage(msg.phone, msg.message, {
          type: msg.type,
          template: msg.template
        });

        if (result.success) {
          results.sent++;
        } else {
          results.failed++;
          results.errors.push({
            phone: msg.phone.replace(/\d(?=\d{4})/g, '*'),
            error: result.error
          });
        }

        return result;
      });

      await Promise.all(batchPromises);

      // Délai entre les batches
      if (i + batchSize < messages.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return results;
  }

  /**
   * Récupérer les statuts des messages
   */
  async getMessageStatus(messageId) {
    try {
      const response = await this.client.get(`/messages/${messageId}`);
      return {
        success: true,
        status: response.data.status,
        deliveredAt: response.data.deliveredAt,
        readAt: response.data.readAt
      };
    } catch (error) {
      logger.error(`Erreur récupération statut message ${messageId}`, {
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Vérifier le numéro WhatsApp
   */
  async checkPhoneNumber(phone) {
    try {
      const response = await this.client.post('/contacts/validate', {
        phone
      });

      return {
        valid: response.data.valid,
        whatsappId: response.data.whatsappId,
        exists: response.data.exists
      };
    } catch (error) {
      logger.error(`Erreur validation numéro ${phone}`, {
        error: error.message
      });

      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Créer un template
   */
  async createTemplate(template) {
    try {
      const response = await this.client.post('/templates', {
        name: template.name,
        category: template.category,
        language: template.language || 'fr',
        components: [
          {
            type: 'BODY',
            text: template.content
          }
        ]
      });

      logger.info(`Template créé: ${template.name}`, {
        templateId: response.data.id
      });

      return {
        success: true,
        templateId: response.data.id,
        status: response.data.status
      };
    } catch (error) {
      logger.error(`Erreur création template ${template.name}`, {
        error: error.message
      });

      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Récupérer les templates
   */
  async getTemplates() {
    try {
      const response = await this.client.get('/templates');
      return {
        success: true,
        templates: response.data.templates
      };
    } catch (error) {
      logger.error('Erreur récupération templates', {
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Vérifier la signature du webhook
   */
  verifyWebhookSignature(body, signature) {
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RESPOND_IO_WEBHOOK_SECRET)
      .update(JSON.stringify(body))
      .digest('hex');

    return signature === expectedSignature;
  }
}

module.exports = new RespondIOService();
