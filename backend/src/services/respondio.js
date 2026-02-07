const axios = require('axios');
const logger = require('../utils/logger');

const RESPOND_IO_BASE_URL = 'https://api.respond.io/v2';

class RespondIOService {
  constructor() {
    this.apiKey = process.env.RESPOND_IO_API_KEY;
    this.channelId = parseInt(process.env.RESPOND_IO_CHANNEL_ID) || 0;
    this.client = axios.create({
      baseURL: RESPOND_IO_BASE_URL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000
    });
  }

  /**
   * Envoyer un message WhatsApp via API v2
   * Endpoint: POST /v2/contact/phone:{phone}/message
   */
  async sendMessage(phone, message, options = {}) {
    try {
      const payload = {
        channelId: options.channelId || this.channelId,
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

      const identifier = 'phone:' + encodeURIComponent(phone);
      const response = await this.client.post(`/contact/${identifier}/message`, payload);

      logger.info(`Message envoyé à ${phone.replace(/\d(?=\d{4})/g, '*')}`, {
        messageId: response.data.messageId,
        contactId: response.data.contactId
      });

      return {
        success: true,
        messageId: response.data.messageId,
        contactId: response.data.contactId
      };
    } catch (error) {
      logger.error(`Erreur envoi message à ${phone.replace(/\d(?=\d{4})/g, '*')}`, {
        error: error.response?.data?.message || error.message
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

      if (i + batchSize < messages.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return results;
  }

  /**
   * Récupérer un contact par téléphone
   */
  async getContact(phone) {
    try {
      const identifier = 'phone:' + encodeURIComponent(phone);
      const response = await this.client.get(`/contact/${identifier}`);
      return { success: true, contact: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Créer ou mettre à jour un contact
   */
  async createOrUpdateContact(phone, data = {}) {
    try {
      const identifier = 'phone:' + encodeURIComponent(phone);
      const response = await this.client.post(`/contact/create_or_update/${identifier}`, data);
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Récupérer les statuts des messages
   */
  async getMessageStatus(messageId) {
    try {
      const response = await this.client.get(`/message/${messageId}`);
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
      return { success: false, error: error.message };
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
