const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// Tarification WhatsApp - Region "Rest of Africa" (Gabon)
// Prix fixes en FCFA (regle: USD x 2 x 600, arrondi)
// ============================================
const PRICING_FCFA = {
  MARKETING: 40,
  UTILITY: 20,
  AUTHENTICATION: 20,
  SERVICE: 0
};

const PRICING_USD = {
  MARKETING: 0.0259,
  UTILITY: 0.0046,
  AUTHENTICATION: 0.0046,
  SERVICE: 0
};

// ============================================
// GET /api/billing/pricing - Grille tarifaire
// ============================================
router.get('/pricing', authenticate, (req, res) => {
  res.json({
    region: 'Rest of Africa (Gabon)',
    currency: 'FCFA',
    conversionRule: 'USD x 2 x 600',
    conversionFactor: USD_TO_FCFA,
    rates: Object.entries(PRICING_FCFA).map(([category, priceFCFA]) => ({
      category,
      priceUSD: PRICING_USD[category],
      priceFCFA
    }))
  });
});

// ============================================
// GET /api/billing/overview - Vue d'ensemble des couts
// ============================================
router.get('/overview', authenticate, async (req, res) => {
  try {
    const { from, to } = req.query;

    // Build date filter
    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    // Fetch all campaigns with their template category
    const campaigns = await prisma.campaign.findMany({
      where: hasDateFilter ? { createdAt: dateFilter } : undefined,
      include: {
        template: {
          select: { category: true, name: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Aggregate costs
    let totalSent = 0;
    let totalDelivered = 0;
    let totalRead = 0;
    let totalFailed = 0;
    let totalCostFCFA = 0;

    const costByCategory = {
      MARKETING: { sent: 0, delivered: 0, failed: 0, costFCFA: 0 },
      UTILITY: { sent: 0, delivered: 0, failed: 0, costFCFA: 0 },
      AUTHENTICATION: { sent: 0, delivered: 0, failed: 0, costFCFA: 0 }
    };

    const campaignCosts = [];

    for (const campaign of campaigns) {
      const category = campaign.template?.category || 'MARKETING';
      const rate = PRICING_FCFA[category] || PRICING_FCFA.MARKETING;
      const cost = campaign.sent * rate;

      totalSent += campaign.sent;
      totalDelivered += campaign.delivered;
      totalRead += campaign.read;
      totalFailed += campaign.failed;
      totalCostFCFA += cost;

      if (costByCategory[category]) {
        costByCategory[category].sent += campaign.sent;
        costByCategory[category].delivered += campaign.delivered;
        costByCategory[category].failed += campaign.failed;
        costByCategory[category].costFCFA += cost;
      }

      if (campaign.sent > 0) {
        campaignCosts.push({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          templateCategory: category,
          sent: campaign.sent,
          delivered: campaign.delivered,
          read: campaign.read,
          failed: campaign.failed,
          costFCFA: Math.round(cost * 100) / 100,
          rateFCFA: rate,
          createdAt: campaign.createdAt
        });
      }
    }

    // Round totals
    Object.keys(costByCategory).forEach(cat => {
      costByCategory[cat].costFCFA = Math.round(costByCategory[cat].costFCFA * 100) / 100;
    });

    res.json({
      currency: 'FCFA',
      totals: {
        campaigns: campaigns.length,
        sent: totalSent,
        delivered: totalDelivered,
        read: totalRead,
        failed: totalFailed,
        costFCFA: Math.round(totalCostFCFA * 100) / 100
      },
      costByCategory,
      campaigns: campaignCosts,
      pricing: PRICING_FCFA
    });
  } catch (error) {
    logger.error('Error fetching billing overview', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation des couts' });
  }
});

module.exports = router;
