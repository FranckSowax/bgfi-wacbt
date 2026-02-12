const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const logger = require('../utils/logger');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

class WhatsAppCloudService {
  constructor() {
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    this.verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    this.appSecret = process.env.WHATSAPP_APP_SECRET;
    this.client = axios.create({
      baseURL: GRAPH_API_BASE,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  /**
   * Envoyer un message texte WhatsApp
   */
  async sendMessage(phone, text) {
    try {
      const to = phone.replace(/[^0-9]/g, '');
      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      });

      const messageId = response.data?.messages?.[0]?.id;
      logger.info(`Message envoyé à ${phone.replace(/\d(?=\d{4})/g, '*')}`, { messageId });

      return {
        success: true,
        messageId,
        contactId: response.data?.contacts?.[0]?.wa_id
      };
    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      logger.error(`Erreur envoi message à ${phone.replace(/\d(?=\d{4})/g, '*')}`, { error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  /**
   * Envoyer un message template WhatsApp (pour les broadcasts hors fenêtre 24h)
   */
  async sendTemplate(phone, templateName, language = 'fr', components = []) {
    try {
      const to = phone.replace(/[^0-9]/g, '');
      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
          components
        }
      };

      const response = await this.client.post(`/${this.phoneNumberId}/messages`, payload);
      const messageId = response.data?.messages?.[0]?.id;
      logger.info(`Template envoyé à ${phone.replace(/\d(?=\d{4})/g, '*')}`, { messageId, template: templateName });

      return {
        success: true,
        messageId,
        contactId: response.data?.contacts?.[0]?.wa_id
      };
    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      logger.error(`Erreur envoi template à ${phone.replace(/\d(?=\d{4})/g, '*')}`, { error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  /**
   * Envoyer des messages en batch avec rate limiting
   */
  async sendBatch(messages, options = {}) {
    const results = { sent: 0, failed: 0, errors: [] };
    const batchSize = options.batchSize || 80;
    const delay = options.delay || 1000;

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);

      const batchPromises = batch.map(async (msg) => {
        let result;
        if (msg.template) {
          result = await this.sendTemplate(msg.phone, msg.template.name, msg.template.language, msg.template.components);
        } else {
          result = await this.sendMessage(msg.phone, msg.message);
        }

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
   * Uploader un media sur Meta (Resumable Upload API) pour obtenir un header_handle
   * Requis pour creer des templates avec image/video/document en header
   */
  async uploadMediaForTemplate(filePath, mimeType = 'image/jpeg') {
    try {
      const appId = process.env.WHATSAPP_APP_ID;
      if (!appId) {
        return { success: false, error: 'WHATSAPP_APP_ID non configuré' };
      }

      const fileData = fs.readFileSync(filePath);
      const fileLength = fileData.length;

      // Step 1: Create upload session
      const sessionRes = await this.client.post(`/${appId}/uploads`, null, {
        params: {
          file_length: fileLength,
          file_type: mimeType,
          access_token: this.accessToken
        }
      });
      const uploadSessionId = sessionRes.data.id;

      // Step 2: Upload file data
      const uploadRes = await axios.post(
        `${GRAPH_API_BASE}/${uploadSessionId}`,
        fileData,
        {
          headers: {
            'Authorization': `OAuth ${this.accessToken}`,
            'Content-Type': 'application/octet-stream',
            'file_offset': '0'
          },
          timeout: 60000
        }
      );

      const headerHandle = uploadRes.data.h;
      logger.info('Media uploaded for template', { headerHandle: headerHandle?.substring(0, 20) + '...' });

      return { success: true, headerHandle };
    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      logger.error('Erreur upload media pour template', { error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  /**
   * Créer un template WhatsApp via l'API Graph
   * Supporte HEADER (TEXT/IMAGE/VIDEO/DOCUMENT), BODY, FOOTER, BUTTONS
   */
  async createTemplate(data) {
    try {
      const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
      if (!wabaId) {
        return { success: false, error: 'WHATSAPP_BUSINESS_ACCOUNT_ID non configuré' };
      }

      // Build components array
      const components = [];

      // HEADER component
      if (data.headerType && data.headerType !== 'NONE') {
        const header = { type: 'HEADER', format: data.headerType };
        if (data.headerType === 'TEXT') {
          header.text = data.headerContent || '';
        } else if (data.headerHandle) {
          // IMAGE/VIDEO/DOCUMENT: use uploaded media handle
          header.example = { header_handle: [data.headerHandle] };
        }
        components.push(header);
      }

      // BODY component (required)
      const body = { type: 'BODY', text: data.content };
      const bodyVars = data.content.match(/\{\{(\d+)\}\}/g);
      if (bodyVars) {
        body.example = { body_text: [bodyVars.map(() => 'exemple')] };
      }
      components.push(body);

      // FOOTER component
      if (data.footer) {
        components.push({ type: 'FOOTER', text: data.footer });
      }

      // BUTTONS component
      if (data.buttons && data.buttons.length > 0) {
        components.push({
          type: 'BUTTONS',
          buttons: data.buttons.map(btn => {
            if (btn.type === 'URL') {
              const buttonDef = { type: 'URL', text: btn.text, url: btn.url };
              // Dynamic URL suffix
              if (btn.url.includes('{{1}}')) {
                buttonDef.example = [btn.url.replace('{{1}}', 'example')];
              }
              return buttonDef;
            }
            if (btn.type === 'PHONE_NUMBER') {
              return { type: 'PHONE_NUMBER', text: btn.text, phone_number: btn.phone };
            }
            return { type: 'QUICK_REPLY', text: btn.text };
          })
        });
      }

      const payload = {
        name: data.name,
        language: data.language || 'fr',
        category: (data.category || 'MARKETING').toUpperCase(),
        components
      };

      logger.info('Creating template on Meta', { name: data.name, components: components.map(c => c.type) });

      const response = await this.client.post(`/${wabaId}/message_templates`, payload);

      return {
        success: true,
        templateId: response.data.id,
        status: response.data.status
      };
    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      logger.error('Erreur création template', { error: errMsg, details: error.response?.data });
      return { success: false, error: errMsg };
    }
  }

  /**
   * Récupérer la liste des templates depuis Meta
   */
  async getTemplates() {
    try {
      const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
      if (!wabaId) {
        return { success: false, error: 'WHATSAPP_BUSINESS_ACCOUNT_ID non configuré' };
      }

      const response = await this.client.get(`/${wabaId}/message_templates`, {
        params: { limit: 100 }
      });

      const templates = response.data.data.map(t => ({
        name: t.name,
        status: t.status,
        category: t.category,
        language: t.language,
        id: t.id,
        rejectionReason: t.rejected_reason,
        components: t.components
      }));

      return { success: true, templates };
    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      logger.error('Erreur récupération templates', { error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  /**
   * Vérification du webhook Meta (challenge handshake)
   */
  verifyWebhook(mode, token, challenge) {
    if (mode === 'subscribe' && token === this.verifyToken) {
      return { valid: true, challenge };
    }
    return { valid: false };
  }

  /**
   * Vérifier la signature du webhook Meta (X-Hub-Signature-256)
   */
  verifyWebhookSignature(rawBody, signature) {
    if (!this.appSecret || !signature) return false;
    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}

module.exports = new WhatsAppCloudService();
