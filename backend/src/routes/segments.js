const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const { authenticate, authorize } = require('../middleware/auth');
const { evaluateCount, evaluateContacts, buildWhereClause, ALLOWED_FIELDS } = require('../services/segmentEvaluator');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// GET /api/segments - Lister les segments
// ============================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, type, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (type) where.type = type.toUpperCase();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [segments, total] = await Promise.all([
      prisma.segment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.segment.count({ where })
    ]);

    res.json({
      data: segments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching segments', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des segments' });
  }
});

// ============================================
// GET /api/segments/fields - Champs disponibles pour le builder
// ============================================
router.get('/fields', authenticate, (req, res) => {
  const fields = [
    { name: 'category', label: 'Catégorie', type: 'select', group: 'PROFIL', options: ['ALL', 'ACTIVE', 'INACTIVE', 'NEW', 'PREMIUM', 'VIP'] },
    { name: 'city', label: 'Ville', type: 'text', group: 'PROFIL' },
    { name: 'country', label: 'Pays', type: 'text', group: 'PROFIL' },
    { name: 'ageRange', label: "Tranche d'âge", type: 'select', group: 'PROFIL', options: ['18-25', '26-35', '36-45', '46-55', '56+'] },
    { name: 'gender', label: 'Genre', type: 'select', group: 'PROFIL', options: ['M', 'F', 'AUTRE'] },
    { name: 'language', label: 'Langue', type: 'select', group: 'PROFIL', options: ['fr', 'en', 'es'] },
    { name: 'status', label: 'Statut', type: 'select', group: 'PROFIL', options: ['ACTIVE', 'UNSUBSCRIBED', 'BLOCKED'] },
    { name: 'accountType', label: 'Type de compte', type: 'select', group: 'BANQUE', options: ['EPARGNE', 'COURANT', 'PROFESSIONNEL', 'JEUNE'] },
    { name: 'registrationDate', label: "Date d'inscription", type: 'date', group: 'BANQUE' },
    { name: 'engagementScore', label: "Score d'engagement", type: 'number', group: 'COMPORTEMENT' },
    { name: 'lastActivity', label: 'Dernière activité', type: 'date', group: 'COMPORTEMENT' },
    { name: 'lastCampaignInteraction', label: 'Dernière interaction campagne', type: 'date', group: 'COMPORTEMENT' },
    { name: 'tags', label: 'Tags', type: 'text', group: 'PROFIL' },
    { name: 'optedIn', label: 'Opt-in WhatsApp', type: 'boolean', group: 'PROFIL' }
  ];
  res.json({ fields });
});

// ============================================
// GET /api/segments/:id - Détail d'un segment
// ============================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const segment = await prisma.segment.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { campaigns: true } }
      }
    });

    if (!segment) {
      return res.status(404).json({ error: 'Segment non trouvé' });
    }

    res.json(segment);
  } catch (error) {
    logger.error('Error fetching segment', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération du segment' });
  }
});

// ============================================
// POST /api/segments - Créer un segment
// ============================================
router.post('/', authenticate, authorize(['campaign:create']), async (req, res) => {
  try {
    const { name, description, type, criteria } = req.body;

    if (!name || !criteria) {
      return res.status(400).json({ error: 'Données manquantes', required: ['name', 'criteria'] });
    }

    // Validate criteria by building where clause
    buildWhereClause(criteria);

    // Evaluate contact count
    const contactCount = await evaluateCount(prisma, criteria);

    const segment = await prisma.segment.create({
      data: {
        name: name.toLowerCase().replace(/\s+/g, '_'),
        description,
        type: (type || 'DYNAMIC').toUpperCase(),
        criteria,
        contactCount,
        lastEvaluatedAt: new Date(),
        createdBy: req.user.id
      }
    });

    logger.info('Segment created', { segmentId: segment.id, userId: req.user.id, contactCount });
    res.status(201).json(segment);
  } catch (error) {
    logger.error('Error creating segment', { error: error.message });
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Un segment avec ce nom existe déjà' });
    }
    res.status(500).json({ error: error.message || 'Erreur lors de la création du segment' });
  }
});

// ============================================
// PUT /api/segments/:id - Modifier un segment
// ============================================
router.put('/:id', authenticate, authorize(['campaign:create']), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, type, criteria } = req.body;

    const existing = await prisma.segment.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Segment non trouvé' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name.toLowerCase().replace(/\s+/g, '_');
    if (description !== undefined) updateData.description = description;
    if (type !== undefined) updateData.type = type.toUpperCase();
    if (criteria !== undefined) {
      buildWhereClause(criteria);
      updateData.criteria = criteria;
      updateData.contactCount = await evaluateCount(prisma, criteria);
      updateData.lastEvaluatedAt = new Date();
    }

    const segment = await prisma.segment.update({ where: { id }, data: updateData });

    logger.info('Segment updated', { segmentId: id, userId: req.user.id });
    res.json(segment);
  } catch (error) {
    logger.error('Error updating segment', { error: error.message });
    res.status(500).json({ error: error.message || 'Erreur lors de la mise à jour du segment' });
  }
});

// ============================================
// DELETE /api/segments/:id - Supprimer un segment
// ============================================
router.delete('/:id', authenticate, authorize(['campaign:create']), async (req, res) => {
  try {
    const { id } = req.params;

    const segment = await prisma.segment.findUnique({
      where: { id },
      include: { _count: { select: { campaigns: true } } }
    });

    if (!segment) {
      return res.status(404).json({ error: 'Segment non trouvé' });
    }

    if (segment._count.campaigns > 0) {
      return res.status(400).json({
        error: 'Segment utilisé',
        message: `Ce segment est utilisé dans ${segment._count.campaigns} campagne(s) et ne peut pas être supprimé.`
      });
    }

    await prisma.segment.delete({ where: { id } });

    logger.info('Segment deleted', { segmentId: id, userId: req.user.id });
    res.json({ success: true, message: 'Segment supprimé' });
  } catch (error) {
    logger.error('Error deleting segment', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la suppression du segment' });
  }
});

// ============================================
// POST /api/segments/:id/evaluate - Réévaluer un segment
// ============================================
router.post('/:id/evaluate', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const segment = await prisma.segment.findUnique({ where: { id } });
    if (!segment) {
      return res.status(404).json({ error: 'Segment non trouvé' });
    }

    const contactCount = await evaluateCount(prisma, segment.criteria);

    await prisma.segment.update({
      where: { id },
      data: { contactCount, lastEvaluatedAt: new Date() }
    });

    res.json({ success: true, contactCount });
  } catch (error) {
    logger.error('Error evaluating segment', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /api/segments/:id/contacts - Contacts d'un segment (pagines)
// ============================================
router.get('/:id/contacts', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const segment = await prisma.segment.findUnique({ where: { id } });
    if (!segment) {
      return res.status(404).json({ error: 'Segment non trouvé' });
    }

    const criteriaWhere = buildWhereClause(segment.criteria);
    const baseWhere = { AND: [{ status: 'ACTIVE' }, criteriaWhere] };

    // Optional search filter
    const where = search
      ? { AND: [baseWhere, { OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } }
        ]}]}
      : baseWhere;

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { engagementScore: 'desc' },
        skip,
        take: parseInt(limit),
        select: {
          id: true, name: true, phone: true, email: true, city: true,
          accountType: true, category: true, engagementScore: true,
          ageRange: true, gender: true, lastActivity: true, tags: true
        }
      }),
      prisma.contact.count({ where })
    ]);

    res.json({
      data: contacts,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    logger.error('Error fetching segment contacts', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des contacts du segment' });
  }
});

// ============================================
// GET /api/segments/:id/insights - Distribution stats d'un segment
// ============================================
router.get('/:id/insights', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const segment = await prisma.segment.findUnique({ where: { id } });
    if (!segment) {
      return res.status(404).json({ error: 'Segment non trouvé' });
    }

    const criteriaWhere = buildWhereClause(segment.criteria);
    const baseWhere = { AND: [{ status: 'ACTIVE' }, criteriaWhere] };

    const [byCity, byAccountType, byAgeRange, byGender, engagementAvg, total] = await Promise.all([
      prisma.contact.groupBy({ by: ['city'], where: { ...baseWhere, city: { not: null } }, _count: { city: true }, orderBy: { _count: { city: 'desc' } }, take: 8 }),
      prisma.contact.groupBy({ by: ['accountType'], where: { ...baseWhere, accountType: { not: null } }, _count: { accountType: true } }),
      prisma.contact.groupBy({ by: ['ageRange'], where: { ...baseWhere, ageRange: { not: null } }, _count: { ageRange: true } }),
      prisma.contact.groupBy({ by: ['gender'], where: { ...baseWhere, gender: { not: null } }, _count: { gender: true } }),
      prisma.contact.aggregate({ _avg: { engagementScore: true }, where: baseWhere }),
      prisma.contact.count({ where: baseWhere })
    ]);

    res.json({
      total,
      averageEngagement: Math.round(engagementAvg._avg.engagementScore || 0),
      byCity: byCity.map(i => ({ name: i.city, count: i._count.city })),
      byAccountType: byAccountType.map(i => ({ name: i.accountType, count: i._count.accountType })),
      byAgeRange: byAgeRange.map(i => ({ name: i.ageRange, count: i._count.ageRange })),
      byGender: byGender.map(i => ({ name: i.gender, count: i._count.gender }))
    });
  } catch (error) {
    logger.error('Error fetching segment insights', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des insights' });
  }
});

// ============================================
// POST /api/segments/ai-suggest - IA: langage naturel → criteres segment
// ============================================
router.post('/ai-suggest', authenticate, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt requis' });
    }

    // Get available field definitions for context
    const fieldDefs = ALLOWED_FIELDS.join(', ');

    const systemPrompt = `Tu es un assistant IA pour BGFI Bank. Tu convertis des descriptions en langage naturel en critères de segmentation JSON.

Champs disponibles: ${fieldDefs}
Types de valeurs:
- category: ALL, ACTIVE, INACTIVE, NEW, PREMIUM, VIP
- city: texte libre (ex: Libreville, Port-Gentil, Franceville, Oyem)
- accountType: EPARGNE, COURANT, PROFESSIONNEL, JEUNE
- ageRange: 18-25, 26-35, 36-45, 46-55, 56+
- gender: M, F, AUTRE
- engagementScore: nombre 0-100
- status: ACTIVE, UNSUBSCRIBED, BLOCKED
- optedIn: true/false
- language: fr, en, es

Opérateurs: eq, neq, gt, gte, lt, lte, in, nin, contains, isNull, isNotNull

Réponds UNIQUEMENT avec un JSON valide au format:
{
  "name": "nom_court_du_segment",
  "description": "Description lisible du segment",
  "criteria": {
    "operator": "AND",
    "rules": [
      { "field": "...", "op": "...", "value": "..." }
    ]
  }
}`;

    // Use OpenAI if available
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Service IA non configuré (OPENAI_API_KEY manquant)' });
    }

    const fetch = require('node-fetch');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 500
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Erreur OpenAI');
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Pas de réponse IA');
    }

    // Parse JSON from response (handle markdown code blocks)
    const jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const suggestion = JSON.parse(jsonStr);

    // Validate the criteria
    buildWhereClause(suggestion.criteria);

    // Evaluate count
    const contactCount = await evaluateCount(prisma, suggestion.criteria);

    res.json({ ...suggestion, contactCount });
  } catch (error) {
    logger.error('Error AI suggest segment', { error: error.message });
    res.status(500).json({ error: error.message || 'Erreur lors de la suggestion IA' });
  }
});

// ============================================
// POST /api/segments/preview - Preview inline criteria (without saving)
// ============================================
router.post('/preview', authenticate, async (req, res) => {
  try {
    const { criteria } = req.body;

    if (!criteria) {
      return res.status(400).json({ error: 'Critères requis' });
    }

    const contactCount = await evaluateCount(prisma, criteria);
    const contacts = await evaluateContacts(prisma, criteria);

    // Return count + sample of first 5 contacts
    res.json({
      contactCount,
      sample: contacts.slice(0, 5).map(c => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        city: c.city,
        accountType: c.accountType,
        engagementScore: c.engagementScore
      }))
    });
  } catch (error) {
    logger.error('Error previewing segment', { error: error.message });
    res.status(500).json({ error: error.message || 'Erreur lors de la prévisualisation' });
  }
});

// ============================================
// POST /api/segments/:id/add-contacts - Ajouter des contacts directement
// ============================================
router.post('/:id/add-contacts', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { contactIds } = req.body;

    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'contactIds requis (tableau non vide)' });
    }

    const segment = await prisma.segment.findUnique({ where: { id } });
    if (!segment) {
      return res.status(404).json({ error: 'Segment non trouvé' });
    }

    // Determine the tag for this segment
    const tagName = 'seg_' + segment.name.replace(/\s+/g, '_').toLowerCase();

    // Check if segment already has non-tag criteria (DYNAMIC segment)
    const criteria = segment.criteria || { operator: 'AND', rules: [] };
    const hasTagRule = (criteria.rules || []).some(r => r.field === 'tags' && r.op === 'has' && r.value === tagName);
    const hasNonTagRules = (criteria.rules || []).some(r => !(r.field === 'tags' && r.op === 'has'));

    // If segment has existing non-tag criteria, tag ALL existing matching contacts first
    // so they don't lose membership when we switch to tag-based criteria
    if (!hasTagRule && hasNonTagRules) {
      const existingContacts = await evaluateContacts(prisma, criteria);
      for (const existing of existingContacts) {
        if (!(existing.tags || []).includes(tagName)) {
          await prisma.contact.update({
            where: { id: existing.id },
            data: { tags: { push: tagName } }
          });
        }
      }
      logger.info('Tagged existing segment contacts', { segmentId: id, count: existingContacts.length });
    }

    // Tag each new contact if not already tagged
    let tagged = 0;
    for (const contactId of contactIds) {
      const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, tags: true } });
      if (contact && !(contact.tags || []).includes(tagName)) {
        await prisma.contact.update({
          where: { id: contactId },
          data: { tags: { push: tagName } }
        });
        tagged++;
      }
    }

    // Replace criteria with tag-only rule (all members are now tagged)
    const newCriteria = { operator: 'AND', rules: [{ field: 'tags', op: 'has', value: tagName }] };
    await prisma.segment.update({
      where: { id },
      data: { criteria: newCriteria, type: 'STATIC' }
    });

    // Re-evaluate count
    const contactCount = await evaluateCount(prisma, newCriteria);
    await prisma.segment.update({
      where: { id },
      data: { contactCount, lastEvaluatedAt: new Date() }
    });

    logger.info('Contacts added to segment', { segmentId: id, tagged, total: contactIds.length });
    res.json({ success: true, tagged, newCount: contactCount });
  } catch (error) {
    logger.error('Error adding contacts to segment', { error: error.message });
    res.status(500).json({ error: error.message || 'Erreur lors de l\'ajout des contacts' });
  }
});

// ============================================
// GET /api/segments/:id/search-contacts - Recherche contacts hors segment
// ============================================
router.get('/:id/search-contacts', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ data: [] });
    }

    const segment = await prisma.segment.findUnique({ where: { id } });
    if (!segment) {
      return res.status(404).json({ error: 'Segment non trouvé' });
    }

    // Find contacts matching search
    // For tag-based (STATIC) segments, exclude contacts already tagged
    const tagName = 'seg_' + segment.name.replace(/\s+/g, '_').toLowerCase();
    const hasTagRule = ((segment.criteria || {}).rules || []).some(r => r.field === 'tags' && r.op === 'has' && r.value === tagName);

    // Build search filter
    const searchFilter = {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } }
      ]
    };

    // For tag-based segments, exclude already-tagged contacts
    // For dynamic segments, exclude contacts matching the criteria
    let where;
    if (hasTagRule) {
      where = {
        AND: [
          searchFilter,
          { NOT: { tags: { has: tagName } } }
        ]
      };
    } else {
      // Dynamic segment: just search all contacts (can't easily exclude criteria matches client-side)
      where = searchFilter;
    }

    const contacts = await prisma.contact.findMany({
      where,
      take: 10,
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, phone: true, email: true,
        city: true, category: true, accountType: true
      }
    });

    res.json({ data: contacts });
  } catch (error) {
    logger.error('Error searching contacts for segment', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});

module.exports = router;
