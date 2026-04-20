const Joi = require('joi');

/**
 * Fabrique un middleware de validation Joi.
 * @param {Object} schemas - { body?: Joi.Schema, query?: Joi.Schema, params?: Joi.Schema }
 * @param {Object} [options] - { stripUnknown?: boolean }
 */
const validate = (schemas, options = {}) => {
  const { stripUnknown = true } = options;

  return (req, res, next) => {
    for (const key of ['body', 'query', 'params']) {
      const schema = schemas[key];
      if (!schema) continue;

      const { error, value } = schema.validate(req[key], {
        abortEarly: false,
        stripUnknown,
        convert: true
      });

      if (error) {
        return res.status(400).json({
          error: 'Donnees invalides',
          message: error.details.map(d => d.message).join(', '),
          field: error.details[0]?.path?.join('.')
        });
      }

      // Ecraser par la valeur nettoyee/coerce (seulement pour body/params, pas query en readonly)
      if (key !== 'query') {
        req[key] = value;
      }
    }
    next();
  };
};

// ============================================
// Schemas reutilisables
// ============================================
const schemas = {
  auth: {
    login: Joi.object({
      email: Joi.string().email().max(255).required(),
      password: Joi.string().min(1).max(200).required()
    }),
    register: Joi.object({
      email: Joi.string().email().max(255).required(),
      password: Joi.string().min(8).max(200).required(),
      name: Joi.string().trim().min(1).max(100).required(),
      role: Joi.string().valid('ADMIN', 'OPERATOR', 'VIEWER').default('OPERATOR')
    }),
    refresh: Joi.object({
      token: Joi.string().required()
    }),
    changePassword: Joi.object({
      currentPassword: Joi.string().min(1).required(),
      newPassword: Joi.string().min(8).max(200).required()
    })
  }
};

module.exports = { validate, schemas, Joi };
