const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// GET /api/analytics/dashboard - Dashboard overview
// ============================================
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const [
      campaignStats,
      messageStats,
      contactStats,
      templateStats,
      recentCampaigns,
      hourlyActivity
    ] = await Promise.all([
      // Statistiques des campagnes
      prisma.campaign.aggregate({
        where: {
          createdAt: { gte: start, lte: end }
        },
        _sum: {
          sent: true,
          delivered: true,
          read: true,
          clicked: true,
          failed: true
        },
        _count: {
          id: true
        }
      }),

      // Statistiques des messages
      prisma.message.groupBy({
        by: ['status'],
        where: {
          createdAt: { gte: start, lte: end }
        },
        _count: {
          status: true
        }
      }),

      // Statistiques des contacts
      prisma.contact.aggregate({
        _count: { id: true }
      }),

      // Statistiques des templates
      prisma.template.groupBy({
        by: ['status'],
        _count: {
          status: true
        }
      }),

      // Campagnes récentes
      prisma.campaign.findMany({
        where: {
          createdAt: { gte: start, lte: end }
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          template: {
            select: { name: true, category: true }
          }
        }
      }),

      // Activité horaire
      prisma.message.groupBy({
        by: ['status'],
        where: {
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        },
        _count: {
          status: true
        }
      })
    ]);

    // Calculer les taux
    const totalSent = campaignStats._sum.sent || 0;
    const totalDelivered = campaignStats._sum.delivered || 0;
    const totalRead = campaignStats._sum.read || 0;
    const totalClicked = campaignStats._sum.clicked || 0;

    const deliveryRate = totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(2) : 0;
    const openRate = totalDelivered > 0 ? ((totalRead / totalDelivered) * 100).toFixed(2) : 0;
    const clickRate = totalRead > 0 ? ((totalClicked / totalRead) * 100).toFixed(2) : 0;

    res.json({
      overview: {
        totalMessages: totalSent,
        deliveryRate: parseFloat(deliveryRate),
        openRate: parseFloat(openRate),
        clickRate: parseFloat(clickRate),
        conversionRate: parseFloat(clickRate) // Simplifié
      },
      campaigns: {
        total: campaignStats._count.id,
        active: await prisma.campaign.count({ where: { status: 'RUNNING' } }),
        completed: await prisma.campaign.count({ where: { status: 'COMPLETED' } }),
        scheduled: await prisma.campaign.count({ where: { status: 'SCHEDULED' } })
      },
      contacts: {
        total: contactStats._count.id,
        active: await prisma.contact.count({ where: { status: 'ACTIVE' } }),
        inactive: await prisma.contact.count({ where: { status: 'INACTIVE' } }),
        unsubscribed: await prisma.contact.count({ where: { status: 'UNSUBSCRIBED' } })
      },
      templates: {
        total: await prisma.template.count(),
        approved: await prisma.template.count({ where: { status: 'APPROVED' } }),
        pending: await prisma.template.count({ where: { status: 'PENDING' } })
      },
      recentCampaigns,
      messageStats: messageStats.reduce((acc, item) => {
        acc[item.status] = item._count.status;
        return acc;
      }, {})
    });
  } catch (error) {
    logger.error('Error fetching dashboard analytics', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des analytics' });
  }
});

// ============================================
// GET /api/analytics/campaigns - Analytics des campagnes
// ============================================
router.get('/campaigns', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    // Récupérer les campagnes dans la période
    const campaigns = await prisma.campaign.findMany({
      where: {
        createdAt: { gte: start, lte: end }
      },
      select: {
        createdAt: true,
        sent: true,
        delivered: true,
        read: true,
        clicked: true,
        failed: true,
        type: true
      }
    });

    // Grouper par période
    const grouped = {};
    
    campaigns.forEach(campaign => {
      let key;
      const date = new Date(campaign.createdAt);
      
      if (groupBy === 'day') {
        key = date.toISOString().split('T')[0];
      } else if (groupBy === 'week') {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split('T')[0];
      } else if (groupBy === 'month') {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }

      if (!grouped[key]) {
        grouped[key] = {
          date: key,
          sent: 0,
          delivered: 0,
          read: 0,
          clicked: 0,
          failed: 0
        };
      }

      grouped[key].sent += campaign.sent;
      grouped[key].delivered += campaign.delivered;
      grouped[key].read += campaign.read;
      grouped[key].clicked += campaign.clicked;
      grouped[key].failed += campaign.failed;
    });

    res.json({
      data: Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date)),
      period: { start, end }
    });
  } catch (error) {
    logger.error('Error fetching campaign analytics', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des analytics' });
  }
});

// ============================================
// GET /api/analytics/engagement - Taux d'engagement
// ============================================
router.get('/engagement', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const campaigns = await prisma.campaign.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        status: 'COMPLETED'
      },
      select: {
        name: true,
        sent: true,
        delivered: true,
        read: true,
        clicked: true,
        type: true
      }
    });

    // Calculer les taux pour chaque campagne
    const engagementData = campaigns.map(c => ({
      name: c.name,
      type: c.type,
      sent: c.sent,
      deliveryRate: c.sent > 0 ? ((c.delivered / c.sent) * 100).toFixed(2) : 0,
      openRate: c.delivered > 0 ? ((c.read / c.delivered) * 100).toFixed(2) : 0,
      clickRate: c.read > 0 ? ((c.clicked / c.read) * 100).toFixed(2) : 0
    }));

    // Moyennes globales
    const totalSent = campaigns.reduce((sum, c) => sum + c.sent, 0);
    const totalDelivered = campaigns.reduce((sum, c) => sum + c.delivered, 0);
    const totalRead = campaigns.reduce((sum, c) => sum + c.read, 0);
    const totalClicked = campaigns.reduce((sum, c) => sum + c.clicked, 0);

    res.json({
      campaigns: engagementData,
      averages: {
        deliveryRate: totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(2) : 0,
        openRate: totalDelivered > 0 ? ((totalRead / totalDelivered) * 100).toFixed(2) : 0,
        clickRate: totalRead > 0 ? ((totalClicked / totalRead) * 100).toFixed(2) : 0
      }
    });
  } catch (error) {
    logger.error('Error fetching engagement analytics', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des analytics' });
  }
});

// ============================================
// GET /api/analytics/contacts - Analytics des contacts
// ============================================
router.get('/contacts', authenticate, async (req, res) => {
  try {
    // Évolution des contacts par segment
    const bySegment = await prisma.contact.groupBy({
      by: ['segment'],
      _count: { segment: true }
    });

    // Évolution des contacts par statut
    const byStatus = await prisma.contact.groupBy({
      by: ['status'],
      _count: { status: true }
    });

    // Nouveaux contacts par jour (30 derniers jours)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const newContacts = await prisma.contact.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo }
      },
      select: {
        createdAt: true
      }
    });

    // Grouper par jour
    const dailyNewContacts = {};
    newContacts.forEach(contact => {
      const date = new Date(contact.createdAt).toISOString().split('T')[0];
      dailyNewContacts[date] = (dailyNewContacts[date] || 0) + 1;
    });

    res.json({
      bySegment: bySegment.reduce((acc, item) => {
        acc[item.segment] = item._count.segment;
        return acc;
      }, {}),
      byStatus: byStatus.reduce((acc, item) => {
        acc[item.status] = item._count.status;
        return acc;
      }, {}),
      newContactsDaily: dailyNewContacts,
      total: await prisma.contact.count()
    });
  } catch (error) {
    logger.error('Error fetching contact analytics', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des analytics' });
  }
});

// ============================================
// GET /api/analytics/export - Exporter les analytics
// ============================================
router.get('/export', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, format = 'json' } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    // Récupérer toutes les données
    const campaigns = await prisma.campaign.findMany({
      where: {
        createdAt: { gte: start, lte: end }
      },
      include: {
        template: {
          select: { name: true }
        },
        _count: {
          select: { messages: true }
        }
      }
    });

    if (format === 'csv') {
      const { stringify } = require('csv-stringify/sync');
      
      const data = campaigns.map(c => ({
        name: c.name,
        type: c.type,
        template: c.template?.name,
        sent: c.sent,
        delivered: c.delivered,
        read: c.read,
        clicked: c.clicked,
        failed: c.failed,
        deliveryRate: c.sent > 0 ? ((c.delivered / c.sent) * 100).toFixed(2) : 0,
        openRate: c.delivered > 0 ? ((c.read / c.delivered) * 100).toFixed(2) : 0,
        clickRate: c.read > 0 ? ((c.clicked / c.read) * 100).toFixed(2) : 0,
        createdAt: c.createdAt,
        status: c.status
      }));

      const csv = stringify(data, { header: true });
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=analytics.csv');
      res.send(csv);
    } else {
      res.json({
        period: { start, end },
        campaigns
      });
    }
  } catch (error) {
    logger.error('Error exporting analytics', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de l\'exportation' });
  }
});

module.exports = router;
