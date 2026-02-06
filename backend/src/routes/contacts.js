const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const csv = require('csv-parse/sync');
const multer = require('multer');

const { authenticate, authorize } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimit');
const logger = require('../utils/logger');
const { contactsTotal } = require('../utils/metrics');

const prisma = new PrismaClient();

// Configuration de multer (memoire pour serverless - pas d'acces disque)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Type de fichier non supporté. Utilisez CSV ou Excel.'));
    }
  }
});

// ============================================
// GET /api/contacts - Lister les contacts
// ============================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      segment,
      status,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Construction du where
    const where = {};
    
    if (segment) where.segment = segment.toUpperCase();
    if (status) where.status = status.toUpperCase();
    
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } }
      ];
    }

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: {
          [sortBy]: sortOrder
        },
        skip,
        take: parseInt(limit)
      }),
      prisma.contact.count({ where })
    ]);

    res.json({
      data: contacts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching contacts', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des contacts' });
  }
});

// ============================================
// GET /api/contacts/:id - Détail d'un contact
// ============================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await prisma.contact.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            messages: true
          }
        }
      }
    });

    if (!contact) {
      return res.status(404).json({ error: 'Contact non trouvé' });
    }

    res.json(contact);
  } catch (error) {
    logger.error('Error fetching contact', { error: error.message, contactId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la récupération du contact' });
  }
});

// ============================================
// POST /api/contacts - Créer un contact
// ============================================
router.post('/', authenticate, authorize(['contact:create']), async (req, res) => {
  try {
    const { phone, email, name, segment = 'ACTIVE', tags = [] } = req.body;

    // Validation
    if (!phone) {
      return res.status(400).json({ error: 'Numéro de téléphone requis' });
    }

    // Normaliser le numéro de téléphone
    const normalizedPhone = phone.replace(/\s/g, '');

    // Vérifier si le contact existe déjà
    const existingContact = await prisma.contact.findUnique({
      where: { phone: normalizedPhone }
    });

    if (existingContact) {
      return res.status(409).json({ 
        error: 'Contact existant',
        message: 'Un contact avec ce numéro existe déjà',
        contact: existingContact
      });
    }

    const contact = await prisma.contact.create({
      data: {
        phone: normalizedPhone,
        email,
        name,
        segment: segment.toUpperCase(),
        tags
      }
    });

    // Métriques
    contactsTotal.inc({ segment: contact.segment, status: contact.status });

    logger.info('Contact created', { contactId: contact.id, phone: normalizedPhone.replace(/\d(?=\d{4})/g, '*') });

    res.status(201).json(contact);
  } catch (error) {
    logger.error('Error creating contact', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la création du contact' });
  }
});

// ============================================
// PUT /api/contacts/:id - Mettre à jour un contact
// ============================================
router.put('/:id', authenticate, authorize(['contact:update']), async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, segment, tags, status } = req.body;

    const contact = await prisma.contact.update({
      where: { id },
      data: {
        email,
        name,
        segment: segment?.toUpperCase(),
        tags,
        status: status?.toUpperCase()
      }
    });

    logger.info('Contact updated', { contactId: id });

    res.json(contact);
  } catch (error) {
    logger.error('Error updating contact', { error: error.message, contactId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la mise à jour du contact' });
  }
});

// ============================================
// DELETE /api/contacts/:id - Supprimer un contact
// ============================================
router.delete('/:id', authenticate, authorize(['contact:delete']), async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.contact.delete({
      where: { id }
    });

    logger.info('Contact deleted', { contactId: id });

    res.json({ success: true, message: 'Contact supprimé' });
  } catch (error) {
    logger.error('Error deleting contact', { error: error.message, contactId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la suppression du contact' });
  }
});

// ============================================
// POST /api/contacts/import - Importer des contacts
// ============================================
router.post('/import', authenticate, authorize(['contact:import']), uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier requis' });
    }

    const fileContent = req.file.buffer.toString('utf-8');

    // Parser le CSV
    const records = csv.parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const results = {
      imported: 0,
      failed: 0,
      errors: []
    };

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      
      try {
        // Validation
        if (!record.phone) {
          throw new Error('Numéro de téléphone manquant');
        }

        const normalizedPhone = record.phone.replace(/\s/g, '');

        // Créer ou mettre à jour le contact
        await prisma.contact.upsert({
          where: { phone: normalizedPhone },
          update: {
            name: record.name,
            email: record.email,
            segment: record.segment?.toUpperCase() || 'ACTIVE',
            tags: record.tags ? record.tags.split(',').map(t => t.trim()) : []
          },
          create: {
            phone: normalizedPhone,
            name: record.name,
            email: record.email,
            segment: record.segment?.toUpperCase() || 'ACTIVE',
            tags: record.tags ? record.tags.split(',').map(t => t.trim()) : []
          }
        });

        results.imported++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          row: i + 2, // +2 car ligne 1 = headers, index commence à 0
          phone: record.phone?.replace(/\d(?=\d{4})/g, '*'),
          error: error.message
        });
      }
    }

    // Supprimer le fichier temporaire
    fs.unlinkSync(req.file.path);

    // Métriques
    contactsTotal.inc({ segment: 'ALL', status: 'ACTIVE' }, results.imported);

    logger.info('Contacts imported', { 
      imported: results.imported, 
      failed: results.failed,
      userId: req.user.id 
    });

    res.json(results);
  } catch (error) {
    logger.error('Error importing contacts', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de l\'importation' });
  }
});

// ============================================
// GET /api/contacts/export - Exporter les contacts
// ============================================
router.get('/export', authenticate, authorize(['contact:export']), async (req, res) => {
  try {
    const { segment, status } = req.query;

    const where = {};
    if (segment) where.segment = segment.toUpperCase();
    if (status) where.status = status.toUpperCase();

    const contacts = await prisma.contact.findMany({
      where,
      select: {
        name: true,
        phone: true,
        email: true,
        segment: true,
        tags: true,
        status: true,
        lastActivity: true
      }
    });

    // Convertir en CSV
    const { stringify } = require('csv-stringify/sync');
    const csv = stringify(contacts, {
      header: true,
      columns: {
        name: 'Nom',
        phone: 'Téléphone',
        email: 'Email',
        segment: 'Segment',
        tags: 'Tags',
        status: 'Statut',
        lastActivity: 'Dernière activité'
      }
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
    res.send(csv);
  } catch (error) {
    logger.error('Error exporting contacts', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de l\'exportation' });
  }
});

// ============================================
// GET /api/contacts/stats - Statistiques
// ============================================
router.get('/stats/overview', authenticate, async (req, res) => {
  try {
    const [total, bySegment, byStatus, recent] = await Promise.all([
      prisma.contact.count(),
      prisma.contact.groupBy({
        by: ['segment'],
        _count: { segment: true }
      }),
      prisma.contact.groupBy({
        by: ['status'],
        _count: { status: true }
      }),
      prisma.contact.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 jours
          }
        }
      })
    ]);

    res.json({
      total,
      bySegment: bySegment.reduce((acc, item) => {
        acc[item.segment] = item._count.segment;
        return acc;
      }, {}),
      byStatus: byStatus.reduce((acc, item) => {
        acc[item.status] = item._count.status;
        return acc;
      }, {}),
      recent
    });
  } catch (error) {
    logger.error('Error fetching contact stats', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
  }
});

module.exports = router;
