# 📡 API Documentation - BGFI WhatsApp Marketing SaaS

## Base URL
```
Production: https://api.bgfi-whatsapp.ga
Local: http://localhost:3000
```

## Authentification
Toutes les requêtes API (sauf `/auth/login` et `/health`) nécessitent un token JWT dans le header:
```
Authorization: Bearer <token>
```

---

## 🔐 Authentification

### POST /api/auth/login
Connexion utilisateur.

**Request:**
```json
{
  "email": "admin@bgfi.ga",
  "password": "votre_mot_de_passe"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "email": "admin@bgfi.ga",
    "name": "Admin BGFI",
    "role": "ADMIN"
  }
}
```

### POST /api/auth/refresh
Rafraîchir le token JWT.

**Request:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

---

## 📢 Campagnes

### GET /api/campaigns
Lister les campagnes.

**Query Parameters:**
| Paramètre | Type | Description |
|-----------|------|-------------|
| page | int | Numéro de page (défaut: 1) |
| limit | int | Nombre d'éléments par page (défaut: 20) |
| status | string | Filtrer par statut (DRAFT, SCHEDULED, RUNNING, COMPLETED) |
| type | string | Filtrer par type (REACTIVATION, TUTORIAL, NOTIFICATION, FEATURE) |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Relance App Mobile",
      "type": "REACTIVATION",
      "status": "COMPLETED",
      "sent": 25000,
      "delivered": 24200,
      "read": 18900,
      "clicked": 4200,
      "createdAt": "2026-01-15T10:00:00Z",
      "template": {
        "id": "uuid",
        "name": "Relance Connexion",
        "category": "MARKETING"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### POST /api/campaigns
Créer une nouvelle campagne.

**Request:**
```json
{
  "name": "Nouvelle Campagne",
  "type": "REACTIVATION",
  "templateId": "uuid-du-template",
  "segment": "INACTIVE",
  "variables": {
    "var1": "nom",
    "var2": "lien"
  },
  "scheduledAt": "2026-02-10T14:00:00Z"
}
```

**Response:**
```json
{
  "id": "uuid",
  "name": "Nouvelle Campagne",
  "type": "REACTIVATION",
  "status": "SCHEDULED",
  "templateId": "uuid-du-template",
  "segment": "INACTIVE",
  "variables": {
    "var1": "nom",
    "var2": "lien"
  },
  "scheduledAt": "2026-02-10T14:00:00Z",
  "createdAt": "2026-02-06T10:00:00Z"
}
```

### POST /api/campaigns/:id/send
Lancer une campagne.

**Response:**
```json
{
  "success": true,
  "campaignId": "uuid",
  "totalContacts": 25000,
  "queued": 25000,
  "estimatedTime": "5 minutes"
}
```

### GET /api/campaigns/:id/stats
Statistiques d'une campagne.

**Response:**
```json
{
  "total": 25000,
  "delivered": 24200,
  "read": 18900,
  "clicked": 4200,
  "failed": 800,
  "pending": 0,
  "rates": {
    "delivery": 96.8,
    "open": 78.1,
    "click": 22.2
  }
}
```

---

## 👥 Contacts

### GET /api/contacts
Lister les contacts.

**Query Parameters:**
| Paramètre | Type | Description |
|-----------|------|-------------|
| page | int | Numéro de page |
| limit | int | Nombre d'éléments |
| segment | string | Filtrer par segment (ACTIVE, INACTIVE, NEW) |
| status | string | Filtrer par statut (ACTIVE, UNSUBSCRIBED, BLOCKED) |
| search | string | Recherche par nom, email ou téléphone |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "phone": "+24174123456",
      "email": "jean.dupont@email.com",
      "name": "Jean Dupont",
      "segment": "INACTIVE",
      "tags": ["app-mobile"],
      "status": "ACTIVE",
      "lastActivity": "2025-11-20T14:30:00Z",
      "createdAt": "2025-01-15T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 125000,
    "totalPages": 2500
  }
}
```

### POST /api/contacts
Créer un contact.

**Request:**
```json
{
  "phone": "+24174123456",
  "email": "jean.dupont@email.com",
  "name": "Jean Dupont",
  "segment": "ACTIVE",
  "tags": ["app-mobile", "premium"]
}
```

### POST /api/contacts/import
Importer des contacts (CSV/Excel).

**Request:**
```http
Content-Type: multipart/form-data

file: contacts.csv
```

**Response:**
```json
{
  "imported": 5000,
  "failed": 23,
  "errors": [
    {
      "row": 45,
      "phone": "+241...",
      "error": "Invalid phone number"
    }
  ]
}
```

---

## 📝 Templates

### GET /api/templates
Lister les templates WhatsApp.

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "relance_connexion",
      "displayName": "Relance Connexion",
      "category": "MARKETING",
      "content": "Bonjour {{1}} ! Votre application BGFI vous attend...",
      "variables": ["var1", "var2"],
      "status": "APPROVED",
      "approvedAt": "2026-01-10T10:00:00Z"
    }
  ],
  "pagination": { ... }
}
```

### POST /api/templates
Créer un template.

**Request:**
```json
{
  "name": "Nouveau Template",
  "displayName": "Nouveau Template",
  "category": "UTILITY",
  "content": "Votre code OTP est : {{1}}",
  "language": "fr"
}
```

**Response:**
```json
{
  "id": "uuid",
  "name": "nouveau_template",
  "status": "PENDING",
  "message": "Template créé et soumis pour approbation Meta. Délai: 24-48h."
}
```

---

## 🤖 Chatbot RAG

### POST /api/chatbot/message
Envoyer un message au chatbot.

**Request:**
```json
{
  "message": "Comment récupérer mes identifiants ?",
  "sessionId": "uuid-optionnel",
  "contactId": "uuid-optionnel"
}
```

**Response:**
```json
{
  "response": "Pour récupérer vos identifiants BGFI, vous pouvez...",
  "sources": [
    {
      "document": "FAQ_BGFI_2026.pdf",
      "page": 12,
      "score": 0.94
    }
  ],
  "confidence": 0.94,
  "sessionId": "uuid",
  "processingTime": 1.234
}
```

### GET /api/chatbot/knowledge
Lister les documents de la base de connaissances.

**Response:**
```json
{
  "documents": [
    {
      "id": "uuid",
      "name": "FAQ_BGFI_2026.pdf",
      "type": "pdf",
      "size": "2.4 MB",
      "status": "INDEXED",
      "chunks": 45,
      "indexedAt": "2026-01-10T10:00:00Z"
    }
  ]
}
```

### GET /api/chatbot/config
Récupérer la configuration RAG.

**Response:**
```json
{
  "model": "gpt-4",
  "chunkSize": 1000,
  "chunkOverlap": 200,
  "topK": 5,
  "similarityThreshold": 0.75
}
```

---

## 📊 Analytics

### GET /api/analytics/dashboard
Dashboard overview.

**Query Parameters:**
| Paramètre | Type | Description |
|-----------|------|-------------|
| startDate | date | Date de début (YYYY-MM-DD) |
| endDate | date | Date de fin (YYYY-MM-DD) |

**Response:**
```json
{
  "overview": {
    "totalMessages": 164200,
    "deliveryRate": 96.8,
    "openRate": 78.2,
    "clickRate": 22.4,
    "conversionRate": 12.4
  },
  "campaigns": {
    "total": 45,
    "active": 3,
    "completed": 38,
    "scheduled": 4
  },
  "contacts": {
    "total": 125000,
    "active": 98000,
    "inactive": 25000,
    "unsubscribed": 2000
  },
  "templates": {
    "total": 15,
    "approved": 12,
    "pending": 3
  }
}
```

### GET /api/analytics/campaigns
Analytics des campagnes.

**Response:**
```json
{
  "data": [
    {
      "date": "2026-01-15",
      "sent": 25000,
      "delivered": 24200,
      "read": 18900,
      "clicked": 4200,
      "failed": 800
    }
  ],
  "period": {
    "start": "2026-01-01T00:00:00Z",
    "end": "2026-02-06T00:00:00Z"
  }
}
```

---

## 🔗 Webhooks

### POST /webhooks/respondio/incoming
Webhook pour les événements Respond.io.

**Events supportés:**
- `message.received` - Message reçu
- `message.delivered` - Message délivré
- `message.read` - Message lu
- `message.failed` - Échec d'envoi
- `contact.created` - Contact créé
- `contact.updated` - Contact mis à jour

**Request:**
```json
{
  "event": "message.delivered",
  "data": {
    "messageId": "msg_123",
    "contact": {
      "id": "contact_123",
      "phone": "+24174123456"
    },
    "timestamp": "2026-02-06T10:00:00Z"
  }
}
```

---

## ⚠️ Codes d'erreur

| Code | Description |
|------|-------------|
| 400 | Requête invalide |
| 401 | Non authentifié |
| 403 | Accès refusé |
| 404 | Ressource non trouvée |
| 409 | Conflit |
| 429 | Trop de requêtes |
| 500 | Erreur serveur |

**Format d'erreur:**
```json
{
  "error": "Description de l'erreur",
  "message": "Message détaillé",
  "details": { ... }
}
```

---

## 📈 Rate Limiting

| Endpoint | Limite |
|----------|--------|
| /api/* | 1000 req/min |
| /api/auth/login | 5 req/15min |
| /api/campaigns | 10 req/hour |
| /api/chatbot/message | 30 req/min |
| /api/contacts/import | 10 req/hour |

---

## 🧪 Tests avec cURL

```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bgfi.ga","password":"password"}' | jq -r '.token')

# Liste des campagnes
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/campaigns

# Créer une campagne
curl -X POST http://localhost:3000/api/campaigns \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test API",
    "type": "MARKETING",
    "templateId": "uuid",
    "segment": "ACTIVE"
  }'

# Chatbot
curl -X POST http://localhost:3000/api/chatbot/message \
  -H "Content-Type: application/json" \
  -d '{"message": "Bonjour !"}'
```

---

**Version API:** 1.0.0  
**Dernière mise à jour:** 06 Février 2026
