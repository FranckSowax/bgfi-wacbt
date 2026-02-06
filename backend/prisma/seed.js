const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ============================================
  // 1. Utilisateur Admin
  // ============================================
  const adminPassword = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@bgfi.ga' },
    update: {},
    create: {
      email: 'admin@bgfi.ga',
      password: adminPassword,
      name: 'Admin BGFI',
      role: 'ADMIN',
      isActive: true
    }
  });
  console.log(`Admin créé: ${admin.email}`);

  // Utilisateur opérateur
  const operatorPassword = await bcrypt.hash('operator123', 10);
  const operator = await prisma.user.upsert({
    where: { email: 'operator@bgfi.ga' },
    update: {},
    create: {
      email: 'operator@bgfi.ga',
      password: operatorPassword,
      name: 'Opérateur Test',
      role: 'OPERATOR',
      isActive: true
    }
  });
  console.log(`Opérateur créé: ${operator.email}`);

  // ============================================
  // 2. Templates WhatsApp
  // ============================================
  const templates = await Promise.all([
    prisma.template.upsert({
      where: { id: '00000000-0000-0000-0000-000000000001' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'welcome_message',
        displayName: 'Message de Bienvenue',
        category: 'UTILITY',
        content: 'Bonjour {{1}} ! Bienvenue chez BGFI Bank. Votre compte est actif.',
        variables: ['nom'],
        language: 'fr',
        status: 'APPROVED',
        approvedAt: new Date()
      }
    }),
    prisma.template.upsert({
      where: { id: '00000000-0000-0000-0000-000000000002' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000002',
        name: 'reactivation_app',
        displayName: 'Relance Application Mobile',
        category: 'MARKETING',
        content: 'Bonjour {{1}}, votre application BGFI vous attend ! Reconnectez-vous : {{2}}',
        variables: ['nom', 'lien'],
        language: 'fr',
        status: 'APPROVED',
        approvedAt: new Date()
      }
    }),
    prisma.template.upsert({
      where: { id: '00000000-0000-0000-0000-000000000003' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000003',
        name: 'otp_verification',
        displayName: 'Code OTP',
        category: 'AUTHENTICATION',
        content: 'Votre code de vérification BGFI est : {{1}}. Valable 5 minutes.',
        variables: ['code'],
        language: 'fr',
        status: 'APPROVED',
        approvedAt: new Date()
      }
    })
  ]);
  console.log(`${templates.length} templates créés`);

  // ============================================
  // 3. Contacts de test
  // ============================================
  const contacts = [
    { phone: '+24174000001', name: 'Jean Dupont', email: 'jean.dupont@email.com', segment: 'ACTIVE', tags: ['app-mobile', 'premium'], optedIn: true },
    { phone: '+24174000002', name: 'Marie Ndong', email: 'marie.ndong@email.com', segment: 'ACTIVE', tags: ['app-mobile'], optedIn: true },
    { phone: '+24174000003', name: 'Paul Mba', email: 'paul.mba@email.com', segment: 'INACTIVE', tags: ['ancien-client'], optedIn: true },
    { phone: '+24174000004', name: 'Aline Obame', email: 'aline.obame@email.com', segment: 'PREMIUM', tags: ['vip', 'app-mobile'], optedIn: true },
    { phone: '+24174000005', name: 'Marc Essono', email: 'marc.essono@email.com', segment: 'NEW', tags: ['nouveau'], optedIn: true },
    { phone: '+24174000006', name: 'Sophie Nguema', email: 'sophie.nguema@email.com', segment: 'ACTIVE', tags: ['app-mobile'], optedIn: false },
    { phone: '+24174000007', name: 'David Ondo', email: 'david.ondo@email.com', segment: 'INACTIVE', tags: [], optedIn: true },
    { phone: '+24174000008', name: 'Claire Bongo', email: 'claire.bongo@email.com', segment: 'VIP', tags: ['vip', 'premium'], optedIn: true },
    { phone: '+24174000009', name: 'Pierre Ella', email: 'pierre.ella@email.com', segment: 'ACTIVE', tags: ['app-mobile'], optedIn: true },
    { phone: '+24174000010', name: 'Fatou Diallo', email: 'fatou.diallo@email.com', segment: 'ACTIVE', tags: ['app-mobile', 'premium'], optedIn: true }
  ];

  for (const contact of contacts) {
    await prisma.contact.upsert({
      where: { phone: contact.phone },
      update: {},
      create: {
        ...contact,
        optedInAt: contact.optedIn ? new Date() : null,
        lastActivity: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000)
      }
    });
  }
  console.log(`${contacts.length} contacts créés`);

  // ============================================
  // 4. Campagne de test
  // ============================================
  const campaign = await prisma.campaign.upsert({
    where: { id: '00000000-0000-0000-0000-000000000010' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000010',
      name: 'Campagne Test - Relance App',
      type: 'REACTIVATION',
      status: 'DRAFT',
      templateId: '00000000-0000-0000-0000-000000000002',
      segment: 'ACTIVE',
      variables: { var1: 'nom', var2: 'https://bgfi.ga/app' },
      createdBy: admin.id
    }
  });
  console.log(`Campagne créée: ${campaign.name}`);

  // ============================================
  // 5. API Key de test
  // ============================================
  const apiKey = await prisma.apiKey.upsert({
    where: { key: 'bgfi-test-api-key-2026' },
    update: {},
    create: {
      name: 'Test API Key',
      key: 'bgfi-test-api-key-2026',
      permissions: ['campaign:create', 'campaign:read', 'campaign:send', 'contact:create', 'contact:read', 'template:read'],
      isActive: true,
      createdBy: admin.id
    }
  });
  console.log(`API Key créée: ${apiKey.name}`);

  console.log('\nSeed terminé !');
  console.log('=====================================');
  console.log('Comptes de test:');
  console.log('  Admin:    admin@bgfi.ga / admin123');
  console.log('  Operator: operator@bgfi.ga / operator123');
  console.log('=====================================');
}

main()
  .catch((e) => {
    console.error('Erreur seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
