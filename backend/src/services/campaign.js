const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');
const whatsappService = require('./whatsapp');
const { evaluateContacts } = require('./segmentEvaluator');
const logger = require('../utils/logger');
const { campaignMessagesSent, campaignDuration, activeCampaigns } = require('../utils/metrics');

const prisma = new PrismaClient();

// ============================================
// Queue configuration (optionnelle)
// En mode serverless/test, l'envoi est direct
// ============================================

let campaignQueue = null;
const redisEnabled = process.env.REDIS_ENABLED !== 'false' && process.env.REDIS_HOST;

if (redisEnabled) {
  try {
    const Queue = require('bull');
    campaignQueue = new Queue('campaigns', {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 50
      }
    });
    logger.info('Campaign queue: using Bull/Redis');
  } catch (error) {
    logger.warn('Bull/Redis not available, using direct send mode');
  }
}

if (!campaignQueue) {
  logger.info('Campaign queue: using direct send mode (serverless)');
}

class CampaignService {
  constructor() {
    if (campaignQueue) {
      this.setupWorkers();
    }
  }

  /**
   * Configurer les workers (mode Redis uniquement)
   */
  setupWorkers() {
    campaignQueue.process('send-messages', 5, async (job) => {
      const { campaignId, batch, template, variables } = job.data;
      const results = await this.sendBatch(batch, template, variables);
      await this.updateCampaignStats(campaignId, results);
      return results;
    });

    campaignQueue.on('completed', (job) => {
      logger.info('Job complété', { jobId: job.id, campaignId: job.data.campaignId });
    });

    campaignQueue.on('failed', (job, err) => {
      logger.error('Job échoué', { jobId: job.id, error: err.message });
    });
  }

  /**
   * Envoyer un batch de messages via WhatsApp Cloud API
   */
  async sendBatch(batch, template, variables) {
    const messages = batch.map(contact => ({
      phone: contact.phone,
      template: {
        name: template.name,
        language: template.language || 'fr',
        components: this.extractVariables(template.content, contact, variables).length > 0
          ? [{ type: 'body', parameters: this.extractVariables(template.content, contact, variables) }]
          : []
      }
    }));

    const results = await whatsappService.sendBatch(messages, {
      batchSize: parseInt(process.env.CAMPAIGN_RATE_LIMIT) || 80,
      delay: 1000
    });

    campaignMessagesSent.inc({ campaign_type: template.category || 'MARKETING', status: 'sent' }, results.sent);
    campaignMessagesSent.inc({ campaign_type: template.category || 'MARKETING', status: 'failed' }, results.failed);

    return results;
  }

  /**
   * Créer une nouvelle campagne
   */
  async createCampaign(data, userId) {
    const campaignData = {
      name: data.name,
      type: data.type.toUpperCase(),
      status: data.scheduledAt ? 'SCHEDULED' : 'DRAFT',
      templateId: data.templateId,
      variables: data.variables || {},
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
      createdBy: userId
    };

    // New segment system
    if (data.segmentId) {
      campaignData.segmentId = data.segmentId;
    } else if (data.inlineCriteria) {
      campaignData.inlineCriteria = data.inlineCriteria;
    }

    // Legacy fallback
    if (data.segment) {
      campaignData.legacySegment = data.segment.toUpperCase();
    }

    const campaign = await prisma.campaign.create({
      data: campaignData,
      include: { template: true, segmentRef: true }
    });

    logger.info(`Campagne créée: ${campaign.name}`, { campaignId: campaign.id, userId });
    return campaign;
  }

  /**
   * Resolve target contacts using segment evaluator or legacy fallback
   */
  async resolveTargetContacts(campaign) {
    if (campaign.segmentId) {
      const segment = await prisma.segment.findUnique({ where: { id: campaign.segmentId } });
      if (!segment) throw new Error('Segment non trouvé');
      return evaluateContacts(prisma, segment.criteria);
    }
    if (campaign.inlineCriteria) {
      return evaluateContacts(prisma, campaign.inlineCriteria);
    }
    // Legacy fallback
    const where = { status: 'ACTIVE', optedIn: true };
    if (campaign.legacySegment && campaign.legacySegment !== 'ALL') {
      where.category = campaign.legacySegment;
    }
    return prisma.contact.findMany({ where });
  }

  /**
   * Lancer une campagne
   */
  async launchCampaign(campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { template: true }
    });

    if (!campaign) throw new Error('Campagne non trouvée');
    if (campaign.status === 'RUNNING') throw new Error('La campagne est déjà en cours');

    const contacts = await this.resolveTargetContacts(campaign);

    if (contacts.length === 0) throw new Error('Aucun contact trouvé pour ce segment');

    // Créer les messages avec un trackingId unique pour le suivi des clics
    await prisma.message.createMany({
      data: contacts.map(contact => ({
        campaignId: campaign.id,
        contactId: contact.id,
        content: this.formatMessage(campaign.template.content, contact, campaign.variables),
        type: 'TEMPLATE',
        status: 'PENDING',
        trackingId: randomUUID()
      }))
    });

    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'RUNNING', startedAt: new Date() }
    });

    activeCampaigns.inc();

    // Découper en batches
    const batchSize = parseInt(process.env.CAMPAIGN_BATCH_SIZE) || 100;
    const batches = [];
    for (let i = 0; i < contacts.length; i += batchSize) {
      batches.push(contacts.slice(i, i + batchSize));
    }

    if (campaignQueue) {
      // Mode Redis: queue
      await campaignQueue.addBulk(batches.map((batch, index) => ({
        name: 'send-messages',
        data: { campaignId: campaign.id, batch, template: campaign.template, variables: campaign.variables },
        opts: { delay: index * 1000 }
      })));
    } else {
      // Mode serverless: envoi direct asynchrone
      this.processDirectSend(campaign, batches).catch(err => {
        logger.error('Erreur envoi direct', { campaignId, error: err.message });
      });
    }

    logger.info(`Campagne lancée: ${campaign.name}`, {
      campaignId: campaign.id,
      totalContacts: contacts.length,
      mode: campaignQueue ? 'queue' : 'direct'
    });

    return {
      success: true,
      campaignId: campaign.id,
      totalContacts: contacts.length,
      queued: contacts.length,
      estimatedTime: `${Math.ceil(contacts.length / 80 / 60)} minutes`
    };
  }

  /**
   * Envoi direct sans queue (mode serverless)
   */
  async processDirectSend(campaign, batches) {
    let totalSent = 0;
    let totalFailed = 0;

    // Resolve media for image/video/document header - upload once, reuse media_id for all contacts
    let resolvedMediaId = null;
    if (campaign.template.headerType && !['NONE', 'TEXT'].includes(campaign.template.headerType)) {
      let imageUrl = campaign.template.headerContent;

      // If headerContent is not a URL (e.g. header_handle), fetch the real URL from Meta
      if (imageUrl && !imageUrl.startsWith('http')) {
        logger.info('headerContent is not a URL, fetching from Meta API', { template: campaign.template.name });
        try {
          imageUrl = await whatsappService.getTemplateImageUrl(campaign.template.name);
        } catch (e) {
          logger.warn('Error fetching template image URL', { error: e.message });
          imageUrl = null;
        }
      }

      // Download the media and upload to WhatsApp Media API to get a reusable media_id
      if (imageUrl) {
        const mediaMime = campaign.template.headerType === 'VIDEO' ? 'video/mp4' : 'image/jpeg';
        logger.info('Uploading template header media to WhatsApp', { template: campaign.template.name, headerType: campaign.template.headerType, mime: mediaMime });
        try {
          const uploadResult = await whatsappService.downloadAndUploadMedia(imageUrl, mediaMime);
          if (uploadResult.success) {
            resolvedMediaId = uploadResult.mediaId;
            logger.info('Media ready for campaign', { template: campaign.template.name, mediaId: resolvedMediaId });
          } else {
            logger.warn('Media upload failed, sending without header', { error: uploadResult.error });
          }
        } catch (e) {
          logger.warn('Error uploading media for campaign', { error: e.message });
        }
      }
    }

    for (const batch of batches) {
      try {
        // Send each message individually to track per-contact results
        for (const contact of batch) {
          // Récupérer le trackingId du message pré-créé
          const dbMsg = await prisma.message.findFirst({
            where: { campaignId: campaign.id, contactId: contact.id },
            select: { id: true, trackingId: true }
          });

          const templateName = campaign.template.name;
          const language = campaign.template.language || 'fr';
          const sendComponents = this.buildSendComponents(campaign.template, contact, campaign.variables, resolvedMediaId, dbMsg?.trackingId);

          logger.info('Sending template', {
            campaignId: campaign.id,
            template: templateName,
            language,
            components: sendComponents.map(c => c.type),
            contactPhone: contact.phone.replace(/\d(?=\d{4})/g, '*'),
            trackingId: dbMsg?.trackingId
          });

          const result = await whatsappService.sendTemplate(contact.phone, templateName, language, sendComponents);

          const newStatus = result.success ? 'SENT' : 'FAILED';
          if (result.success) totalSent++;
          else totalFailed++;

          await prisma.message.updateMany({
            where: { campaignId: campaign.id, contactId: contact.id },
            data: {
              status: newStatus,
              externalId: result.messageId ? String(result.messageId) : null,
              sentAt: result.success ? new Date() : null,
              error: result.error || null
            }
          });

          if (!result.success) {
            logger.warn('Template send failed at API level', {
              campaignId: campaign.id,
              contactPhone: contact.phone.replace(/\d(?=\d{4})/g, '*'),
              error: result.error
            });
          }
        }

        campaignMessagesSent.inc({ campaign_type: campaign.template.category || 'MARKETING', status: 'sent' }, totalSent);
        campaignMessagesSent.inc({ campaign_type: campaign.template.category || 'MARKETING', status: 'failed' }, totalFailed);
      } catch (error) {
        logger.error('Erreur batch direct', { campaignId: campaign.id, error: error.message });
      }
    }

    // Update campaign sent count (only API-level sent count, not delivery)
    // Delivery/failure stats are updated by webhook handler to avoid race conditions
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { sent: totalSent + totalFailed }
    });

    logger.info('Campaign direct send completed', {
      campaignId: campaign.id,
      sent: totalSent,
      failed: totalFailed
    });

    // Mark campaign as completed
    const total = await prisma.message.count({ where: { campaignId: campaign.id } });
    const processed = await prisma.message.count({
      where: { campaignId: campaign.id, status: { in: ['SENT', 'DELIVERED', 'READ', 'FAILED'] } }
    });
    if (processed >= total) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'COMPLETED', completedAt: new Date() }
      });
      activeCampaigns.dec();
    }
  }

  async updateCampaignStats(campaignId, results) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        sent: { increment: results.sent + results.failed },
        delivered: { increment: results.sent },
        failed: { increment: results.failed }
      }
    });

    const [total, processed] = await Promise.all([
      prisma.message.count({ where: { campaignId } }),
      prisma.message.count({
        where: { campaignId, status: { in: ['SENT', 'DELIVERED', 'READ', 'FAILED'] } }
      })
    ]);

    if (processed >= total) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED', completedAt: new Date() }
      });
      activeCampaigns.dec();
    }
  }

  async getCampaignStats(campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { template: { select: { buttons: true } } }
    });
    if (!campaign) throw new Error('Campagne non trouvée');

    const messages = await prisma.message.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { status: true }
    });

    // Calculer les clics par bouton
    const clickedMessages = await prisma.message.findMany({
      where: { campaignId, clickedButtons: { not: null } },
      select: { clickedButtons: true }
    });

    const buttonClicks = {};
    clickedMessages.forEach(msg => {
      const clicks = Array.isArray(msg.clickedButtons) ? msg.clickedButtons : [];
      clicks.forEach(c => {
        const idx = c.index ?? 0;
        buttonClicks[idx] = (buttonClicks[idx] || 0) + 1;
      });
    });

    // Nommer les boutons à partir du template
    const buttons = Array.isArray(campaign.template?.buttons) ? campaign.template.buttons : [];
    const buttonStats = buttons.map((btn, index) => ({
      index,
      text: btn.text || `Bouton ${index + 1}`,
      type: btn.type,
      redirectUrl: btn.redirectUrl || btn.url || null,
      clicks: buttonClicks[index] || 0
    }));

    const stats = {
      total: campaign.sent,
      delivered: campaign.delivered,
      read: campaign.read,
      clicked: campaign.clicked,
      failed: campaign.failed,
      pending: 0,
      rates: {
        delivery: campaign.sent > 0 ? ((campaign.delivered / campaign.sent) * 100).toFixed(2) : 0,
        open: campaign.delivered > 0 ? ((campaign.read / campaign.delivered) * 100).toFixed(2) : 0,
        click: campaign.read > 0 ? ((campaign.clicked / campaign.read) * 100).toFixed(2) : 0
      },
      buttonStats
    };

    messages.forEach(m => {
      if (m.status === 'PENDING' || m.status === 'QUEUED') stats.pending += m._count.status;
    });

    return stats;
  }

  async cancelCampaign(campaignId) {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new Error('Campagne non trouvée');
    if (campaign.status === 'COMPLETED') throw new Error('Impossible d\'annuler une campagne terminée');

    if (campaignQueue) {
      const jobs = await campaignQueue.getJobs(['waiting', 'delayed']);
      for (const job of jobs.filter(j => j.data.campaignId === campaignId)) {
        await job.remove();
      }
    }

    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'PAUSED' }
    });

    activeCampaigns.dec();
    return { success: true, message: 'Campagne annulée' };
  }

  formatMessage(template, contact, variables) {
    let message = template;
    const varMatches = template.match(/\{\{(\d+)\}\}/g) || [];

    varMatches.forEach((match, index) => {
      const varName = variables?.[`var${index + 1}`];
      let value = '';
      if (varName) {
        switch (varName) {
          case 'nom': case 'name': value = contact.name || 'Cher client'; break;
          case 'prenom': value = contact.name?.split(' ')[0] || 'Cher client'; break;
          case 'email': value = contact.email || ''; break;
          case 'phone': value = contact.phone || ''; break;
          default: value = variables[varName] || '';
        }
      }
      message = message.replace(match, value);
    });

    return message;
  }

  extractVariables(template, contact, variables) {
    const varMatches = template.match(/\{\{(\d+)\}\}/g) || [];
    return varMatches.map((match, index) => {
      const varName = variables?.[`var${index + 1}`];
      let value = '';
      switch (varName) {
        case 'nom': case 'name': value = contact.name || 'Cher client'; break;
        case 'prenom': value = contact.name?.split(' ')[0] || 'Cher client'; break;
        default: value = variables?.[varName] || '';
      }
      return { type: 'text', text: value };
    });
  }

  /**
   * Build the full components array for sending a template (HEADER + BODY + BUTTONS)
   * @param {Object} template - Template object from DB
   * @param {Object} contact - Contact object
   * @param {Object} variables - Campaign variables
   * @param {string|null} mediaId - Pre-uploaded WhatsApp media ID for header
   * @param {string|null} trackingId - Unique tracking ID for click redirect
   */
  buildSendComponents(template, contact, variables, mediaId = null, trackingId = null) {
    const components = [];

    // HEADER component (image/video/document) - use uploaded media ID
    if (template.headerType && template.headerType !== 'NONE' && template.headerType !== 'TEXT' && mediaId) {
      const mediaType = template.headerType.toLowerCase(); // image, video, document
      components.push({
        type: 'header',
        parameters: [{
          type: mediaType,
          [mediaType]: { id: mediaId }
        }]
      });
    }

    // BODY component (text variables)
    const bodyParams = this.extractVariables(template.content, contact, variables);
    if (bodyParams.length > 0) {
      components.push({ type: 'body', parameters: bodyParams });
    }

    // BUTTON components (dynamic URL suffix → tracking redirect per bouton)
    if (template.buttons && Array.isArray(template.buttons)) {
      template.buttons.forEach((btn, index) => {
        if (btn.type === 'URL' && btn.url && btn.url.includes('{{1}}')) {
          // trackingId/buttonIndex pour identifier quel bouton est cliqué
          const suffix = trackingId ? `${trackingId}/${index}` : (variables?.buttonUrl || '');
          components.push({
            type: 'button',
            sub_type: 'url',
            index: index,
            parameters: [{ type: 'text', text: suffix }]
          });
        }
      });
    }

    return components;
  }
}

module.exports = new CampaignService();
