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
      category,
      status,
      search,
      city,
      accountType,
      ageRange,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Construction du where
    const where = {};

    if (category) where.category = category.toUpperCase();
    if (status) where.status = status.toUpperCase();
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (accountType) where.accountType = accountType.toUpperCase();
    if (ageRange) where.ageRange = ageRange;

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
    const {
      phone, email, name, category = 'ACTIVE', tags = [],
      city, country, ageRange, gender, language, accountType, registrationDate
    } = req.body;

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
        category: category.toUpperCase(),
        tags,
        city,
        country,
        ageRange,
        gender,
        language,
        accountType,
        registrationDate: registrationDate ? new Date(registrationDate) : null
      }
    });

    // Métriques
    contactsTotal.inc({ segment: contact.category, status: contact.status });

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
    const {
      email, name, category, tags, status,
      city, country, ageRange, gender, language, accountType, registrationDate
    } = req.body;

    const updateData = {};
    if (email !== undefined) updateData.email = email;
    if (name !== undefined) updateData.name = name;
    if (category !== undefined) updateData.category = category.toUpperCase();
    if (tags !== undefined) updateData.tags = tags;
    if (status !== undefined) updateData.status = status.toUpperCase();
    if (city !== undefined) updateData.city = city;
    if (country !== undefined) updateData.country = country;
    if (ageRange !== undefined) updateData.ageRange = ageRange;
    if (gender !== undefined) updateData.gender = gender;
    if (language !== undefined) updateData.language = language;
    if (accountType !== undefined) updateData.accountType = accountType;
    if (registrationDate !== undefined) updateData.registrationDate = registrationDate ? new Date(registrationDate) : null;

    const contact = await prisma.contact.update({
      where: { id },
      data: updateData
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

    // Supprimer dans une transaction pour gérer les foreign keys
    await prisma.$transaction([
      // Supprimer les messages liés au contact
      prisma.message.deleteMany({ where: { contactId: id } }),
      // Détacher les sessions de chat (contactId est optionnel)
      prisma.chatSession.updateMany({ where: { contactId: id }, data: { contactId: null } }),
      // Supprimer le contact
      prisma.contact.delete({ where: { id } })
    ]);

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
            category: record.category?.toUpperCase() || record.segment?.toUpperCase() || 'ACTIVE',
            tags: record.tags ? record.tags.split(',').map(t => t.trim()) : [],
            city: record.city || undefined,
            accountType: record.accountType || undefined,
            ageRange: record.ageRange || undefined,
            gender: record.gender || undefined
          },
          create: {
            phone: normalizedPhone,
            name: record.name,
            email: record.email,
            category: record.category?.toUpperCase() || record.segment?.toUpperCase() || 'ACTIVE',
            tags: record.tags ? record.tags.split(',').map(t => t.trim()) : [],
            city: record.city || undefined,
            accountType: record.accountType || undefined,
            ageRange: record.ageRange || undefined,
            gender: record.gender || undefined
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

    // Métriques (memoryStorage: no file to unlink)
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
    const { category, status } = req.query;

    const where = {};
    if (category) where.category = category.toUpperCase();
    if (status) where.status = status.toUpperCase();

    const contacts = await prisma.contact.findMany({
      where,
      select: {
        name: true,
        phone: true,
        email: true,
        category: true,
        city: true,
        accountType: true,
        tags: true,
        status: true,
        engagementScore: true,
        lastActivity: true
      }
    });

    // Convertir en CSV
    const { stringify } = require('csv-stringify/sync');
    const csvData = stringify(contacts, {
      header: true,
      columns: {
        name: 'Nom',
        phone: 'Téléphone',
        email: 'Email',
        category: 'Catégorie',
        city: 'Ville',
        accountType: 'Type Compte',
        tags: 'Tags',
        status: 'Statut',
        engagementScore: 'Score Engagement',
        lastActivity: 'Dernière activité'
      }
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
    res.send(csvData);
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
    const [total, byCategory, byStatus, byCity, byAccountType, recent] = await Promise.all([
      prisma.contact.count(),
      prisma.contact.groupBy({
        by: ['category'],
        _count: { category: true }
      }),
      prisma.contact.groupBy({
        by: ['status'],
        _count: { status: true }
      }),
      prisma.contact.groupBy({
        by: ['city'],
        where: { city: { not: null } },
        _count: { city: true },
        orderBy: { _count: { city: 'desc' } },
        take: 10
      }),
      prisma.contact.groupBy({
        by: ['accountType'],
        where: { accountType: { not: null } },
        _count: { accountType: true }
      }),
      prisma.contact.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          }
        }
      })
    ]);

    res.json({
      total,
      byCategory: byCategory.reduce((acc, item) => {
        acc[item.category] = item._count.category;
        return acc;
      }, {}),
      byStatus: byStatus.reduce((acc, item) => {
        acc[item.status] = item._count.status;
        return acc;
      }, {}),
      byCity: byCity.reduce((acc, item) => {
        if (item.city) acc[item.city] = item._count.city;
        return acc;
      }, {}),
      byAccountType: byAccountType.reduce((acc, item) => {
        if (item.accountType) acc[item.accountType] = item._count.accountType;
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
