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
   * Récupérer l'URL de l'image header d'un template approuvé depuis Meta
   */
  async getTemplateMediaUrl(templateName) {
    try {
      const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
      if (!wabaId) return null;

      const response = await this.client.get(`/${wabaId}/message_templates`, {
        params: { name: templateName, fields: 'components' }
      });

      const template = response.data?.data?.[0];
      if (!template) return null;

      const headerComp = template.components?.find(c => c.type === 'HEADER');
      // header_url works for both IMAGE and VIDEO templates
      return headerComp?.example?.header_url?.[0] || null;
    } catch (error) {
      logger.error('Erreur récupération media URL template', { templateName, error: error.message });
      return null;
    }
  }

  // Backward-compatible alias
  async getTemplateImageUrl(templateName) {
    return this.getTemplateMediaUrl(templateName);
  }

  /**
   * Télécharger une image depuis une URL et l'uploader sur WhatsApp Media API
   * Retourne le media_id utilisable pour envoyer des messages
   */
  async downloadAndUploadMedia(imageUrl, mimeType = 'image/jpeg') {
    try {
      // Step 1: Download the media (image or video)
      logger.info('Downloading media for upload', { url: imageUrl.substring(0, 80) + '...' });

      // Only send Meta auth headers for Meta/Facebook CDN URLs
      const isMetaUrl = imageUrl.includes('whatsapp.net') || imageUrl.includes('facebook.com') || imageUrl.includes('fbcdn.net');
      const downloadHeaders = isMetaUrl
        ? { 'Authorization': `OAuth ${this.accessToken}`, 'User-Agent': 'WhatsApp/2.0' }
        : { 'User-Agent': 'Mozilla/5.0' };

      const mediaResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: downloadHeaders
      });

      const mediaBuffer = Buffer.from(mediaResponse.data);
      const detectedMime = mediaResponse.headers['content-type'] || mimeType;

      // Auto-detect mime type from URL extension if content-type is generic
      let finalMime = detectedMime;
      if (detectedMime === 'application/octet-stream' || detectedMime === 'binary/octet-stream') {
        if (imageUrl.match(/\.mp4/i)) finalMime = 'video/mp4';
        else if (imageUrl.match(/\.jpg|\.jpeg/i)) finalMime = 'image/jpeg';
        else if (imageUrl.match(/\.png/i)) finalMime = 'image/png';
        else if (imageUrl.match(/\.webp/i)) finalMime = 'image/webp';
      }

      // Determine filename based on media type
      const isVideo = finalMime.startsWith('video/');
      const filename = isVideo ? 'header_video.mp4' : 'header_image.jpg';

      // Step 2: Upload to WhatsApp Media API
      const FormData = require('form-data');
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', finalMime);
      form.append('file', mediaBuffer, {
        filename,
        contentType: finalMime
      });

      const uploadResponse = await axios.post(
        `${GRAPH_API_BASE}/${this.phoneNumberId}/media`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            'Authorization': `Bearer ${this.accessToken}`
          },
          timeout: 120000
        }
      );

      const mediaId = uploadResponse.data?.id;
      logger.info('Media uploaded successfully', { mediaId, mime: finalMime, size: mediaBuffer.length });
      return { success: true, mediaId };
    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      logger.error('Erreur download+upload media', { error: errMsg, status: error.response?.status, url: imageUrl?.substring(0, 80) });
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
