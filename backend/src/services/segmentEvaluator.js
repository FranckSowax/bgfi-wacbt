/**
 * Segment Evaluator - Converts JSON criteria to Prisma where clauses
 *
 * Criteria format:
 * {
 *   operator: "AND" | "OR",
 *   rules: [
 *     { field: "city", op: "eq", value: "Libreville" },
 *     { field: "engagementScore", op: "gte", value: 50 }
 *   ],
 *   groups: [
 *     { operator: "OR", rules: [...], groups: [...] }
 *   ]
 * }
 *
 * Supported operators: eq, neq, gt, gte, lt, lte, in, nin, contains, isNull, isNotNull
 */

const ALLOWED_FIELDS = [
  'category', 'city', 'country', 'ageRange', 'gender', 'language',
  'accountType', 'engagementScore', 'status', 'tags', 'optedIn',
  'registrationDate', 'lastActivity', 'lastCampaignInteraction', 'createdAt'
];

function buildRuleCondition(rule) {
  const { field, op, value } = rule;

  if (!ALLOWED_FIELDS.includes(field)) {
    throw new Error(`Champ non autorisé: ${field}`);
  }

  switch (op) {
    case 'eq':
      return { [field]: value };
    case 'neq':
      return { [field]: { not: value } };
    case 'gt':
      return { [field]: { gt: value } };
    case 'gte':
      return { [field]: { gte: value } };
    case 'lt':
      return { [field]: { lt: value } };
    case 'lte':
      return { [field]: { lte: value } };
    case 'in':
      return { [field]: { in: Array.isArray(value) ? value : [value] } };
    case 'nin':
      return { [field]: { notIn: Array.isArray(value) ? value : [value] } };
    case 'contains':
      return { [field]: { contains: value, mode: 'insensitive' } };
    case 'has':
      return { [field]: { has: value } };
    case 'isNull':
      return { [field]: null };
    case 'isNotNull':
      return { [field]: { not: null } };
    default:
      throw new Error(`Opérateur non supporté: ${op}`);
  }
}

function buildWhereClause(criteria) {
  if (!criteria || (!criteria.rules && !criteria.groups)) {
    return {};
  }

  const conditions = [];

  // Process rules
  if (criteria.rules && criteria.rules.length > 0) {
    for (const rule of criteria.rules) {
      conditions.push(buildRuleCondition(rule));
    }
  }

  // Process nested groups (recursive)
  if (criteria.groups && criteria.groups.length > 0) {
    for (const group of criteria.groups) {
      conditions.push(buildWhereClause(group));
    }
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];

  const operator = (criteria.operator || 'AND').toUpperCase();
  return operator === 'OR' ? { OR: conditions } : { AND: conditions };
}

async function evaluateCount(prisma, criteria) {
  const criteriaWhere = buildWhereClause(criteria);
  const where = {
    AND: [
      { status: 'ACTIVE' },
      criteriaWhere
    ]
  };
  return prisma.contact.count({ where });
}

async function evaluateContacts(prisma, criteria) {
  const criteriaWhere = buildWhereClause(criteria);
  const where = {
    AND: [
      { status: 'ACTIVE' },
      criteriaWhere
    ]
  };
  return prisma.contact.findMany({ where });
}

module.exports = {
  buildWhereClause,
  buildRuleCondition,
  evaluateCount,
  evaluateContacts,
  ALLOWED_FIELDS
};
