const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

const { authenticate, authorize } = require('../middleware/auth');
const campaignService = require('../services/campaign');
const logger = require('../utils/logger');

// ============================================
// GET /api/campaigns - Lister les campagnes
// ============================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      status, 
      type,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Construction du where
    const where = {};
    if (status) where.status = status.toUpperCase();
    if (type) where.type = type.toUpperCase();

    const [campaigns, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        include: {
          template: {
            select: {
              id: true,
              name: true,
              category: true
            }
          },
          user: {
            select: {
              id: true,
              name: true
            }
          },
          segmentRef: {
            select: {
              id: true,
              name: true,
              contactCount: true
            }
          }
        },
        orderBy: {
          [sortBy]: sortOrder
        },
        skip,
        take: parseInt(limit)
      }),
      prisma.campaign.count({ where })
    ]);

    res.json({
      data: campaigns,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching campaigns', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des campagnes' });
  }
});

// ============================================
// GET /api/campaigns/:id - Détail d'une campagne
// ============================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        template: true,
        segmentRef: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        _count: {
          select: {
            messages: true
          }
        }
      }
    });

    if (!campaign) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    // Récupérer les statistiques détaillées
    const stats = await campaignService.getCampaignStats(id);

    res.json({
      ...campaign,
      stats
    });
  } catch (error) {
    logger.error('Error fetching campaign', { error: error.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la récupération de la campagne' });
  }
});

// ============================================
// POST /api/campaigns - Créer une campagne
// ============================================
router.post('/', authenticate, authorize(['campaign:create']), async (req, res) => {
  try {
    const { name, type, templateId, segment, segmentId, inlineCriteria, variables, scheduledAt } = req.body;

    // Validation: need at least one targeting method
    if (!name || !type || !templateId) {
      return res.status(400).json({
        error: 'Données manquantes',
        required: ['name', 'type', 'templateId']
      });
    }

    if (!segmentId && !inlineCriteria && !segment) {
      return res.status(400).json({
        error: 'Ciblage manquant',
        message: 'Fournir segmentId, inlineCriteria ou segment (legacy)'
      });
    }

    // Vérifier que le template existe
    const template = await prisma.template.findUnique({
      where: { id: templateId }
    });

    if (!template) {
      return res.status(404).json({ error: 'Template non trouvé' });
    }

    if (template.status !== 'APPROVED') {
      return res.status(400).json({ 
        error: 'Le template doit être approuvé avant utilisation',
        templateStatus: template.status
      });
    }

    const campaign = await campaignService.createCampaign({
      name,
      type,
      templateId,
      segment,
      segmentId,
      inlineCriteria,
      variables,
      scheduledAt
    }, req.user.id);

    logger.info('Campaign created', { 
      campaignId: campaign.id, 
      userId: req.user.id 
    });

    res.status(201).json(campaign);
  } catch (error) {
    logger.error('Error creating campaign', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la création de la campagne' });
  }
});

// ============================================
// PUT /api/campaigns/:id - Modifier une campagne
// ============================================
router.put('/:id', authenticate, authorize(['campaign:create']), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, templateId, segment, segmentId, inlineCriteria, variables, scheduledAt } = req.body;

    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    if (!['DRAFT', 'SCHEDULED', 'PAUSED'].includes(existing.status)) {
      return res.status(400).json({
        error: 'Modification impossible',
        message: 'Seules les campagnes en brouillon, planifiées ou en pause peuvent être modifiées.'
      });
    }

    // Vérifier le template si changé
    if (templateId && templateId !== existing.templateId) {
      const template = await prisma.template.findUnique({ where: { id: templateId } });
      if (!template) {
        return res.status(404).json({ error: 'Template non trouvé' });
      }
      if (template.status !== 'APPROVED') {
        return res.status(400).json({ error: 'Le template doit être approuvé avant utilisation' });
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (type !== undefined) updateData.type = type.toUpperCase();
    if (templateId !== undefined) updateData.templateId = templateId;
    if (variables !== undefined) updateData.variables = variables;
    if (segmentId !== undefined) updateData.segmentId = segmentId || null;
    if (inlineCriteria !== undefined) updateData.inlineCriteria = inlineCriteria || null;
    if (segment !== undefined) updateData.legacySegment = segment.toUpperCase();
    if (scheduledAt !== undefined) {
      updateData.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
      updateData.status = scheduledAt ? 'SCHEDULED' : 'DRAFT';
    }

    const campaign = await prisma.campaign.update({
      where: { id },
      data: updateData,
      include: { template: true, segmentRef: true }
    });

    logger.info('Campaign updated', { campaignId: id, userId: req.user.id });
    res.json(campaign);
  } catch (error) {
    logger.error('Error updating campaign', { error: error.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la campagne' });
  }
});

// ============================================
// DELETE /api/campaigns/:id - Supprimer une campagne
// ============================================
router.delete('/:id', authenticate, authorize(['campaign:create']), async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.campaign.findUnique({
      where: { id },
      include: { _count: { select: { messages: true } } }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    if (existing.status === 'RUNNING') {
      return res.status(400).json({
        error: 'Suppression impossible',
        message: 'Impossible de supprimer une campagne en cours d\'exécution. Annulez-la d\'abord.'
      });
    }

    // Supprimer les messages associés d'abord
    if (existing._count.messages > 0) {
      await prisma.message.deleteMany({ where: { campaignId: id } });
    }

    await prisma.campaign.delete({ where: { id } });

    logger.info('Campaign deleted', { campaignId: id, userId: req.user.id });
    res.json({ success: true, message: 'Campagne supprimée' });
  } catch (error) {
    logger.error('Error deleting campaign', { error: error.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la suppression de la campagne' });
  }
});

// ============================================
// POST /api/campaigns/:id/send - Lancer une campagne
// ============================================
router.post('/:id/send', authenticate, authorize(['campaign:send']), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await campaignService.launchCampaign(id);

    logger.info('Campaign launched', { 
      campaignId: id, 
      userId: req.user.id,
      totalContacts: result.totalContacts
    });

    res.json(result);
  } catch (error) {
    logger.error('Error launching campaign', { 
      error: error.message, 
      campaignId: req.params.id 
    });
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// POST /api/campaigns/:id/cancel - Annuler une campagne
// ============================================
router.post('/:id/cancel', authenticate, authorize(['campaign:cancel']), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await campaignService.cancelCampaign(id);

    logger.info('Campaign cancelled', { 
      campaignId: id, 
      userId: req.user.id 
    });

    res.json(result);
  } catch (error) {
    logger.error('Error cancelling campaign', { 
      error: error.message, 
      campaignId: req.params.id 
    });
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// POST /api/campaigns/:id/duplicate - Dupliquer une campagne
// ============================================
router.post('/:id/duplicate', authenticate, authorize(['campaign:create']), async (req, res) => {
  try {
    const { id } = req.params;

    const original = await prisma.campaign.findUnique({
      where: { id },
      include: { template: true, segmentRef: true }
    });

    if (!original) {
      return res.status(404).json({ error: 'Campagne non trouvée' });
    }

    const duplicate = await prisma.campaign.create({
      data: {
        name: original.name + ' (copie)',
        type: original.type,
        status: 'DRAFT',
        templateId: original.templateId,
        variables: original.variables || {},
        segmentId: original.segmentId || null,
        inlineCriteria: original.inlineCriteria || null,
        legacySegment: original.legacySegment || null,
        createdBy: req.user.id
      },
      include: { template: true, segmentRef: true }
    });

    logger.info('Campaign duplicated', { originalId: id, duplicateId: duplicate.id, userId: req.user.id });
    res.status(201).json(duplicate);
  } catch (error) {
    logger.error('Error duplicating campaign', { error: error.message, campaignId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la duplication de la campagne' });
  }
});

// ============================================
// GET /api/campaigns/:id/stats - Statistiques
// ============================================
router.get('/:id/stats', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const stats = await campaignService.getCampaignStats(id);

    res.json(stats);
  } catch (error) {
    logger.error('Error fetching campaign stats', { 
      error: error.message, 
      campaignId: req.params.id 
    });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /api/campaigns/:id/messages - Messages
// ============================================
router.get('/:id/messages', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 50, status } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { campaignId: id };
    if (status) where.status = status.toUpperCase();

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        include: {
          contact: {
            select: {
              id: true,
              name: true,
              phone: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.message.count({ where })
    ]);

    res.json({
      data: messages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching campaign messages', { 
      error: error.message, 
      campaignId: req.params.id 
    });
    res.status(500).json({ error: 'Erreur lors de la récupération des messages' });
  }
});

module.exports = router;
