const { PrismaClient } = require('@prisma/client');
const respondIOService = require('./respondio');
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
   * Envoyer un batch de messages (texte simple via Respond.io v2)
   */
  async sendBatch(batch, template, variables) {
    const messages = batch.map(contact => ({
      phone: contact.phone,
      message: this.formatMessage(template.content, contact, variables)
    }));

    const results = await respondIOService.sendBatch(messages, {
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
    const campaign = await prisma.campaign.create({
      data: {
        name: data.name,
        type: data.type.toUpperCase(),
        status: data.scheduledAt ? 'SCHEDULED' : 'DRAFT',
        templateId: data.templateId,
        segment: data.segment.toUpperCase(),
        variables: data.variables || {},
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        createdBy: userId
      },
      include: { template: true }
    });

    logger.info(`Campagne créée: ${campaign.name}`, { campaignId: campaign.id, userId });
    return campaign;
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

    const contacts = await prisma.contact.findMany({
      where: { segment: campaign.segment, status: 'ACTIVE', optedIn: true }
    });

    if (contacts.length === 0) throw new Error('Aucun contact trouvé pour ce segment');

    // Créer les messages
    await prisma.message.createMany({
      data: contacts.map(contact => ({
        campaignId: campaign.id,
        contactId: contact.id,
        content: this.formatMessage(campaign.template.content, contact, campaign.variables),
        type: 'TEMPLATE',
        status: 'PENDING'
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
    for (const batch of batches) {
      try {
        // Send each message individually to track per-contact results
        for (const contact of batch) {
          const text = this.formatMessage(campaign.template.content, contact, campaign.variables);
          const result = await respondIOService.sendMessage(contact.phone, text);

          const newStatus = result.success ? 'SENT' : 'FAILED';
          await prisma.message.updateMany({
            where: { campaignId: campaign.id, contactId: contact.id },
            data: {
              status: newStatus,
              externalId: result.messageId ? String(result.messageId) : null,
              sentAt: result.success ? new Date() : null,
              error: result.error || null
            }
          });
        }

        // Update aggregate campaign stats
        const msgStats = await prisma.message.groupBy({
          by: ['status'],
          where: { campaignId: campaign.id },
          _count: { status: true }
        });
        const sent = msgStats.find(s => s.status === 'SENT')?._count.status || 0;
        const failed = msgStats.find(s => s.status === 'FAILED')?._count.status || 0;
        const delivered = sent;

        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { sent: sent + failed, delivered, failed }
        });

        campaignMessagesSent.inc({ campaign_type: campaign.template.category || 'MARKETING', status: 'sent' }, sent);
        campaignMessagesSent.inc({ campaign_type: campaign.template.category || 'MARKETING', status: 'failed' }, failed);
      } catch (error) {
        logger.error('Erreur batch direct', { campaignId: campaign.id, error: error.message });
      }
    }

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
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new Error('Campagne non trouvée');

    const messages = await prisma.message.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { status: true }
    });

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
      }
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
}

module.exports = new CampaignService();
