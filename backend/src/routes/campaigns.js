const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const { authenticate, authorize } = require('../middleware/auth');
const campaignService = require('../services/campaign');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

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
    const { name, type, templateId, segment, variables, scheduledAt } = req.body;

    // Validation
    if (!name || !type || !templateId || !segment) {
      return res.status(400).json({ 
        error: 'Données manquantes',
        required: ['name', 'type', 'templateId', 'segment']
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
