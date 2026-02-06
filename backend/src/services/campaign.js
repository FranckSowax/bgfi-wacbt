const Queue = require('bull');
const { PrismaClient } = require('@prisma/client');
const respondIOService = require('./respondio');
const logger = require('../utils/logger');
const { campaignMessagesSent, campaignDuration, activeCampaigns } = require('../utils/metrics');

const prisma = new PrismaClient();

// Configuration de la queue
const campaignQueue = new Queue('campaigns', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: 100,
    removeOnFail: 50
  }
});

class CampaignService {
  constructor() {
    this.setupWorkers();
  }

  /**
   * Configurer les workers de traitement
   */
  setupWorkers() {
    // Worker pour l'envoi des messages
    campaignQueue.process('send-messages', 5, async (job) => {
      const { campaignId, batch, template, variables } = job.data;
      
      logger.info(`Traitement batch pour campagne ${campaignId}`, {
        batchSize: batch.length
      });

      const messages = batch.map(contact => ({
        phone: contact.phone,
        message: this.formatMessage(template.content, contact, variables),
        type: 'template',
        template: {
          name: template.name,
          language: 'fr',
          components: [
            {
              type: 'body',
              parameters: this.extractVariables(template.content, contact, variables)
            }
          ]
        }
      }));

      const results = await respondIOService.sendBatch(messages, {
        batchSize: 80,
        delay: 1000
      });

      // Mettre à jour les statistiques
      await this.updateCampaignStats(campaignId, results);

      // Mettre à jour les statuts des messages
      for (let i = 0; i < batch.length; i++) {
        const contact = batch[i];
        const success = i < results.sent;
        
        await prisma.message.updateMany({
          where: {
            campaignId,
            contactId: contact.id
          },
          data: {
            status: success ? 'SENT' : 'FAILED',
            sentAt: success ? new Date() : null,
            error: success ? null : results.errors.find(e => e.phone.includes(contact.phone.slice(-4)))?.error
          }
        });
      }

      // Métriques Prometheus
      campaignMessagesSent.inc({
        campaign_type: template.category,
        status: 'sent'
      }, results.sent);

      campaignMessagesSent.inc({
        campaign_type: template.category,
        status: 'failed'
      }, results.failed);

      return results;
    });

    // Événements de la queue
    campaignQueue.on('completed', (job, result) => {
      logger.info(`Job complété`, {
        jobId: job.id,
        campaignId: job.data.campaignId,
        result
      });
    });

    campaignQueue.on('failed', (job, err) => {
      logger.error(`Job échoué`, {
        jobId: job.id,
        campaignId: job.data.campaignId,
        error: err.message
      });
    });
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
      include: {
        template: true
      }
    });

    logger.info(`Campagne créée: ${campaign.name}`, {
      campaignId: campaign.id,
      userId
    });

    return campaign;
  }

  /**
   * Lancer une campagne
   */
  async launchCampaign(campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        template: true
      }
    });

    if (!campaign) {
      throw new Error('Campagne non trouvée');
    }

    if (campaign.status === 'RUNNING') {
      throw new Error('La campagne est déjà en cours');
    }

    // Récupérer les contacts du segment
    const contacts = await prisma.contact.findMany({
      where: {
        segment: campaign.segment,
        status: 'ACTIVE',
        optedIn: true
      }
    });

    if (contacts.length === 0) {
      throw new Error('Aucun contact trouvé pour ce segment');
    }

    // Créer les messages
    const messagesData = contacts.map(contact => ({
      campaignId: campaign.id,
      contactId: contact.id,
      content: this.formatMessage(campaign.template.content, contact, campaign.variables),
      type: 'TEMPLATE',
      status: 'PENDING'
    }));

    await prisma.message.createMany({
      data: messagesData
    });

    // Mettre à jour le statut de la campagne
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'RUNNING',
        startedAt: new Date()
      }
    });

    // Découper en batches et ajouter à la queue
    const batchSize = 100;
    const batches = [];
    
    for (let i = 0; i < contacts.length; i += batchSize) {
      batches.push(contacts.slice(i, i + batchSize));
    }

    // Ajouter les jobs à la queue
    const jobs = batches.map((batch, index) => ({
      name: 'send-messages',
      data: {
        campaignId: campaign.id,
        batch,
        template: campaign.template,
        variables: campaign.variables,
        batchIndex: index,
        totalBatches: batches.length
      },
      opts: {
        delay: index * 1000 // Délai progressif entre les batches
      }
    }));

    await campaignQueue.addBulk(jobs);

    // Métriques
    activeCampaigns.inc();
    campaignDuration.observe(0);

    logger.info(`Campagne lancée: ${campaign.name}`, {
      campaignId: campaign.id,
      totalContacts: contacts.length,
      totalBatches: batches.length
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
   * Mettre à jour les statistiques d'une campagne
   */
  async updateCampaignStats(campaignId, results) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId }
    });

    if (!campaign) return;

    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        sent: { increment: results.sent + results.failed },
        delivered: { increment: results.sent },
        failed: { increment: results.failed }
      }
    });

    // Vérifier si la campagne est terminée
    const totalMessages = await prisma.message.count({
      where: { campaignId }
    });

    const processedMessages = await prisma.message.count({
      where: {
        campaignId,
        status: {
          in: ['SENT', 'DELIVERED', 'READ', 'FAILED']
        }
      }
    });

    if (processedMessages >= totalMessages) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date()
        }
      });

      activeCampaigns.dec();

      logger.info(`Campagne terminée: ${campaignId}`, {
        campaignId,
        totalSent: campaign.sent + results.sent,
        totalFailed: campaign.failed + results.failed
      });
    }
  }

  /**
   * Formater un message avec les variables
   */
  formatMessage(template, contact, variables) {
    let message = template;

    // Remplacer les variables du template
    const varMatches = template.match(/\{\{(\d+)\}\}/g) || [];
    
    varMatches.forEach((match, index) => {
      const varName = variables[`var${index + 1}`];
      if (varName) {
        let value = '';
        
        switch (varName) {
          case 'nom':
          case 'name':
            value = contact.name || 'Cher client';
            break;
          case 'prenom':
            value = contact.name?.split(' ')[0] || 'Cher client';
            break;
          case 'email':
            value = contact.email || '';
            break;
          case 'phone':
            value = contact.phone || '';
            break;
          default:
            value = variables[varName] || '';
        }

        message = message.replace(match, value);
      }
    });

    return message;
  }

  /**
   * Extraire les variables pour le template
   */
  extractVariables(template, contact, variables) {
    const varMatches = template.match(/\{\{(\d+)\}\}/g) || [];
    
    return varMatches.map((match, index) => {
      const varName = variables[`var${index + 1}`];
      let value = '';

      switch (varName) {
        case 'nom':
        case 'name':
          value = contact.name || 'Cher client';
          break;
        case 'prenom':
          value = contact.name?.split(' ')[0] || 'Cher client';
          break;
        default:
          value = variables[varName] || '';
      }

      return {
        type: 'text',
        text: value
      };
    });
  }

  /**
   * Récupérer les statistiques d'une campagne
   */
  async getCampaignStats(campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId }
    });

    if (!campaign) {
      throw new Error('Campagne non trouvée');
    }

    const messages = await prisma.message.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: {
        status: true
      }
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
      if (m.status === 'PENDING' || m.status === 'QUEUED') {
        stats.pending += m._count.status;
      }
    });

    return stats;
  }

  /**
   * Annuler une campagne
   */
  async cancelCampaign(campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId }
    });

    if (!campaign) {
      throw new Error('Campagne non trouvée');
    }

    if (campaign.status === 'COMPLETED') {
      throw new Error('Impossible d\'annuler une campagne terminée');
    }

    // Annuler les jobs en attente
    const jobs = await campaignQueue.getJobs(['waiting', 'delayed']);
    const campaignJobs = jobs.filter(job => job.data.campaignId === campaignId);
    
    for (const job of campaignJobs) {
      await job.remove();
    }

    // Mettre à jour le statut
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'PAUSED'
      }
    });

    activeCampaigns.dec();

    logger.info(`Campagne annulée: ${campaignId}`);

    return { success: true, message: 'Campagne annulée' };
  }
}

module.exports = new CampaignService();
