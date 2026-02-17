const express = require('express');
const router = express.Router();
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const { authenticate, authorize } = require('../middleware/auth');
const whatsappService = require('../services/whatsapp');
const logger = require('../utils/logger');
const { templatesTotal } = require('../utils/metrics');

const prisma = new PrismaClient();

// ============================================
// GET /api/templates - Lister les templates
// ============================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      category,
      status,
      search
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {};
    if (category) where.category = category.toUpperCase();
    if (status) where.status = status.toUpperCase();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [templates, total] = await Promise.all([
      prisma.template.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.template.count({ where })
    ]);

    res.json({
      data: templates,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching templates', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la récupération des templates' });
  }
});

// ============================================
// GET /api/templates/meta/app-info - Retrouver le App ID Meta
// ============================================
router.get('/meta/app-info', authenticate, async (req, res) => {
  try {
    const axios = require('axios');
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'WHATSAPP_ACCESS_TOKEN non configure' });

    const response = await axios.get('https://graph.facebook.com/v21.0/app', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    res.json({
      appId: response.data.id,
      appName: response.data.name,
      configuredAppId: process.env.WHATSAPP_APP_ID || null,
      hint: 'Ajoutez WHATSAPP_APP_ID=' + response.data.id + ' dans vos variables Railway'
    });
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    logger.error('Error fetching Meta app info', { error: errMsg });
    res.status(500).json({ error: errMsg });
  }
});

// ============================================
// POST /api/templates/meta/test-upload - Tester l'upload media vers Meta
// ============================================
router.post('/meta/test-upload', authenticate, async (req, res) => {
  try {
    const { imagePath } = req.body;
    const fs = require('fs');
    const testPath = imagePath || 'templates/bgfi-welcome.jpeg';
    const localPath = path.resolve(__dirname, '../../../public', testPath.replace(/^\//, ''));

    const diagnostics = {
      appId: process.env.WHATSAPP_APP_ID || null,
      resolvedPath: localPath,
      fileExists: fs.existsSync(localPath),
      fileSize: null,
      uploadResult: null
    };

    if (diagnostics.fileExists) {
      const stats = fs.statSync(localPath);
      diagnostics.fileSize = stats.size;

      // Try the actual upload
      const uploadResult = await whatsappService.uploadMediaForTemplate(localPath, 'image/jpeg');
      diagnostics.uploadResult = uploadResult;
    }

    res.json(diagnostics);
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    logger.error('Error testing media upload', { error: errMsg });
    res.status(500).json({ error: errMsg });
  }
});

// ============================================
// GET /api/templates/:id - Détail d'un template
// ============================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const template = await prisma.template.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            campaigns: true
          }
        }
      }
    });

    if (!template) {
      return res.status(404).json({ error: 'Template non trouvé' });
    }

    res.json(template);
  } catch (error) {
    logger.error('Error fetching template', { error: error.message, templateId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la récupération du template' });
  }
});

// ============================================
// POST /api/templates - Créer un template
// Supporte HEADER (IMAGE/VIDEO/TEXT), BODY, FOOTER, BUTTONS
// ============================================
router.post('/', authenticate, authorize(['template:create']), async (req, res) => {
  try {
    const { name, displayName, category, content, language = 'fr', headerType, headerContent, buttons, footer } = req.body;

    // Validation
    if (!name || !displayName || !category || !content) {
      return res.status(400).json({
        error: 'Données manquantes',
        required: ['name', 'displayName', 'category', 'content']
      });
    }

    // Extraire les variables du contenu
    const variableMatches = content.match(/\{\{(\d+)\}\}/g) || [];
    const variables = variableMatches.map((_, index) => `var${index + 1}`);

    // Si header IMAGE/VIDEO et fichier local, uploader vers Meta pour obtenir le header_handle
    let headerHandle = null;
    if (['IMAGE', 'VIDEO'].includes(headerType) && headerContent) {
      const localPath = path.resolve(__dirname, '../../../public', headerContent.replace(/^\//, ''));
      const fs = require('fs');
      if (fs.existsSync(localPath)) {
        const mimeType = headerType === 'VIDEO' ? 'video/mp4' : 'image/jpeg';
        const uploadResult = await whatsappService.uploadMediaForTemplate(localPath, mimeType);
        if (uploadResult.success) {
          headerHandle = uploadResult.headerHandle;
        } else {
          logger.warn('Media upload failed, template will be created without sample media', { error: uploadResult.error });
        }
      }
    }

    // Créer le template dans la base de données
    const template = await prisma.template.create({
      data: {
        name: name.toLowerCase().replace(/\s+/g, '_'),
        displayName,
        category: category.toUpperCase(),
        content,
        variables,
        language,
        headerType: headerType || 'NONE',
        headerContent: headerContent || null,
        buttons: buttons || null,
        footer: footer || null,
        status: 'PENDING'
      }
    });

    // Soumettre à Meta pour approbation via WhatsApp Cloud API
    const metaResult = await whatsappService.createTemplate({
      name: template.name,
      category: template.category.toLowerCase(),
      content,
      language,
      headerType: headerType || 'NONE',
      headerContent,
      headerHandle,
      buttons: buttons || null,
      footer: footer || null
    });

    if (metaResult.success) {
      await prisma.template.update({
        where: { id: template.id },
        data: { metaId: metaResult.templateId }
      });
    }

    // Métriques
    templatesTotal.inc({ category: template.category, status: template.status });

    logger.info('Template created', {
      templateId: template.id,
      name: template.name,
      headerType: headerType || 'NONE',
      userId: req.user.id
    });

    res.status(201).json({
      ...template,
      message: 'Template créé et soumis pour approbation Meta. Délai: 24-48h.',
      metaStatus: metaResult.success ? 'submitted' : metaResult.error
    });
  } catch (error) {
    logger.error('Error creating template', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la création du template' });
  }
});

// ============================================
// PUT /api/templates/:id - Mettre à jour un template
// ============================================
router.put('/:id', authenticate, authorize(['template:update']), async (req, res) => {
  try {
    const { id } = req.params;
    const { displayName, content, language } = req.body;

    // Récupérer le template existant
    const existingTemplate = await prisma.template.findUnique({
      where: { id }
    });

    if (!existingTemplate) {
      return res.status(404).json({ error: 'Template non trouvé' });
    }

    // Si le template est déjà approuvé, on ne peut pas le modifier
    if (existingTemplate.status === 'APPROVED') {
      return res.status(400).json({
        error: 'Template approuvé',
        message: 'Les templates approuvés ne peuvent pas être modifiés. Créez un nouveau template.'
      });
    }

    // Extraire les nouvelles variables si le contenu change
    let variables = existingTemplate.variables;
    if (content) {
      const variableMatches = content.match(/\{\{(\d+)\}\}/g) || [];
      variables = variableMatches.map((_, index) => `var${index + 1}`);
    }

    const template = await prisma.template.update({
      where: { id },
      data: {
        displayName,
        content,
        language,
        variables
      }
    });

    logger.info('Template updated', { templateId: id, userId: req.user.id });

    res.json(template);
  } catch (error) {
    logger.error('Error updating template', { error: error.message, templateId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la mise à jour du template' });
  }
});

// ============================================
// POST /api/templates/:id/duplicate - Dupliquer un template
// ============================================
router.post('/:id/duplicate', authenticate, authorize(['template:create']), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, displayName, content, category, headerType, headerContent, buttons, footer } = req.body;

    const source = await prisma.template.findUnique({ where: { id } });
    if (!source) {
      return res.status(404).json({ error: 'Template source non trouvé' });
    }

    const newName = (name || source.name + '_v2').toLowerCase().replace(/\s+/g, '_');
    const newContent = content || source.content;
    const variableMatches = newContent.match(/\{\{(\d+)\}\}/g) || [];
    const variables = variableMatches.map((_, index) => `var${index + 1}`);
    const newHeaderType = headerType !== undefined ? headerType : (source.headerType || 'NONE');
    const newHeaderContent = headerContent !== undefined ? headerContent : source.headerContent;
    const newButtons = buttons !== undefined ? buttons : source.buttons;
    const newFooter = footer !== undefined ? footer : source.footer;

    // Upload media header if needed
    let headerHandle = null;
    if (['IMAGE', 'VIDEO'].includes(newHeaderType) && newHeaderContent) {
      const localPath = path.resolve(__dirname, '../../../public', newHeaderContent.replace(/^\//, ''));
      const fs = require('fs');
      if (fs.existsSync(localPath)) {
        const mimeType = newHeaderType === 'VIDEO' ? 'video/mp4' : 'image/jpeg';
        const uploadResult = await whatsappService.uploadMediaForTemplate(localPath, mimeType);
        if (uploadResult.success) {
          headerHandle = uploadResult.headerHandle;
        } else {
          logger.warn('Media upload failed for duplicate', { error: uploadResult.error });
        }
      }
    }

    const template = await prisma.template.create({
      data: {
        name: newName,
        displayName: displayName || source.displayName + ' (copie)',
        category: (category || source.category).toUpperCase(),
        content: newContent,
        variables,
        language: source.language,
        headerType: newHeaderType,
        headerContent: newHeaderContent,
        buttons: newButtons,
        footer: newFooter,
        status: 'PENDING'
      }
    });

    // Soumettre à Meta pour approbation
    const metaResult = await whatsappService.createTemplate({
      name: template.name,
      category: template.category.toLowerCase(),
      content: newContent,
      language: template.language,
      headerType: newHeaderType,
      headerContent: newHeaderContent,
      headerHandle,
      buttons: newButtons,
      footer: newFooter
    });

    if (metaResult.success) {
      await prisma.template.update({
        where: { id: template.id },
        data: { metaId: metaResult.templateId }
      });
    }

    logger.info('Template duplicated', { sourceId: id, newId: template.id, headerType: newHeaderType, userId: req.user.id });

    res.status(201).json({
      ...template,
      message: 'Template dupliqué et soumis pour approbation Meta.',
      metaStatus: metaResult.success ? 'submitted' : metaResult.error
    });
  } catch (error) {
    logger.error('Error duplicating template', { error: error.message, templateId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la duplication du template' });
  }
});

// ============================================
// DELETE /api/templates/:id - Supprimer un template
// ============================================
router.delete('/:id', authenticate, authorize(['template:delete']), async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier si le template est utilisé dans des campagnes
    const template = await prisma.template.findUnique({
      where: { id },
      include: {
        _count: {
          select: { campaigns: true }
        }
      }
    });

    if (template._count.campaigns > 0) {
      return res.status(400).json({
        error: 'Template utilisé',
        message: `Ce template est utilisé dans ${template._count.campaigns} campagnes et ne peut pas être supprimé.`
      });
    }

    await prisma.template.delete({
      where: { id }
    });

    logger.info('Template deleted', { templateId: id, userId: req.user.id });

    res.json({ success: true, message: 'Template supprimé' });
  } catch (error) {
    logger.error('Error deleting template', { error: error.message, templateId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la suppression du template' });
  }
});

// ============================================
// POST /api/templates/:id/sync - Synchroniser avec Meta WhatsApp
// ============================================
router.post('/:id/sync', authenticate, authorize(['template:sync']), async (req, res) => {
  try {
    const { id } = req.params;

    const template = await prisma.template.findUnique({
      where: { id }
    });

    if (!template) {
      return res.status(404).json({ error: 'Template non trouvé' });
    }

    // Récupérer le statut depuis Meta WhatsApp Cloud API
    const templatesResult = await whatsappService.getTemplates();
    
    if (!templatesResult.success) {
      return res.status(500).json({
        error: 'Synchronisation échouée',
        message: templatesResult.error
      });
    }

    // Trouver le template correspondant
    const metaTemplate = templatesResult.templates.find(t => t.name === template.name);

    if (metaTemplate) {
      // Mettre à jour le statut
      const updatedTemplate = await prisma.template.update({
        where: { id },
        data: {
          status: metaTemplate.status.toUpperCase(),
          approvedAt: metaTemplate.status === 'APPROVED' ? new Date() : null,
          rejectedAt: metaTemplate.status === 'REJECTED' ? new Date() : null,
          rejectionReason: metaTemplate.rejectionReason
        }
      });

      logger.info('Template synced', { templateId: id, status: metaTemplate.status });

      res.json({
        success: true,
        template: updatedTemplate,
        metaStatus: metaTemplate.status
      });
    } else {
      res.status(404).json({
        error: 'Template non trouvé',
        message: 'Ce template n\'existe pas sur Meta WhatsApp'
      });
    }
  } catch (error) {
    logger.error('Error syncing template', { error: error.message, templateId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

// ============================================
// POST /api/templates/sync-all - Synchroniser tous les templates avec Meta
// ============================================
router.post('/sync-all', authenticate, async (req, res) => {
  try {
    const templatesResult = await whatsappService.getTemplates();
    if (!templatesResult.success) {
      return res.status(500).json({ error: 'Synchronisation échouée', message: templatesResult.error });
    }

    const metaTemplates = templatesResult.templates;
    let synced = 0;
    let created = 0;

    for (const mt of metaTemplates) {
      // Extract component info
      const headerComp = mt.components?.find(c => c.type === 'HEADER');
      const bodyComp = mt.components?.find(c => c.type === 'BODY');
      const footerComp = mt.components?.find(c => c.type === 'FOOTER');
      const buttonsComp = mt.components?.find(c => c.type === 'BUTTONS');

      const headerType = headerComp?.format || 'NONE';
      // Prefer header_url (actual accessible URL) over header_handle (opaque token for template creation only)
      const headerContent = headerComp?.format === 'TEXT' ? headerComp.text : (headerComp?.example?.header_url?.[0] || headerComp?.example?.header_handle?.[0] || null);
      const footer = footerComp?.text || null;
      const buttons = buttonsComp?.buttons?.map(b => ({
        type: b.type, text: b.text,
        url: b.url || null, phone: b.phone_number || null
      })) || null;

      const existing = await prisma.template.findFirst({ where: { name: mt.name } });
      if (existing) {
        await prisma.template.update({
          where: { id: existing.id },
          data: {
            status: mt.status.toUpperCase(),
            metaId: mt.id,
            headerType,
            headerContent,
            buttons,
            footer,
            approvedAt: mt.status === 'APPROVED' ? (existing.approvedAt || new Date()) : null,
            rejectedAt: mt.status === 'REJECTED' ? new Date() : null,
            rejectionReason: mt.rejectionReason
          }
        });
        synced++;
      } else {
        await prisma.template.create({
          data: {
            name: mt.name,
            displayName: mt.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            category: mt.category || 'MARKETING',
            content: bodyComp?.text || '',
            language: mt.language || 'fr',
            status: mt.status.toUpperCase(),
            metaId: mt.id,
            variables: (bodyComp?.text?.match(/\{\{(\d+)\}\}/g) || []).map((_, i) => `var${i + 1}`),
            headerType,
            headerContent,
            buttons,
            footer,
            approvedAt: mt.status === 'APPROVED' ? new Date() : null
          }
        });
        created++;
      }
    }

    res.json({ success: true, synced, created, total: metaTemplates.length });
  } catch (error) {
    logger.error('Error syncing all templates', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

// ============================================
// GET /api/templates/variables/preview - Prévisualiser les variables
// ============================================
router.post('/variables/preview', authenticate, async (req, res) => {
  try {
    const { template, variables, contact } = req.body;

    if (!template) {
      return res.status(400).json({ error: 'Template requis' });
    }

    // Remplacer les variables
    let preview = template;
    const varMatches = template.match(/\{\{(\d+)\}\}/g) || [];

    varMatches.forEach((match, index) => {
      const varName = variables?.[`var${index + 1}`];
      let value = '';

      if (varName) {
        switch (varName) {
          case 'nom':
          case 'name':
            value = contact?.name || 'Jean Dupont';
            break;
          case 'prenom':
            value = contact?.name?.split(' ')[0] || 'Jean';
            break;
          case 'email':
            value = contact?.email || 'jean.dupont@email.com';
            break;
          default:
            value = variables?.[varName] || `[Variable ${index + 1}]`;
        }
      }

      preview = preview.replace(match, value);
    });

    res.json({ preview });
  } catch (error) {
    logger.error('Error previewing template', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la prévisualisation' });
  }
});

module.exports = router;
