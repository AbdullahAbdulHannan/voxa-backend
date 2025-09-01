const { validationResult } = require('express-validator');

/**
 * Middleware to validate request data against validation rules
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (errors.isEmpty()) {
    return next();
  }

  // Extract error messages
  const extractedErrors = [];
  errors.array().map(err => {
    // Handle nested errors (e.g., location.name)
    const field = err.param.includes('.') 
      ? err.param.split('.')[1] 
      : err.param;
      
    extractedErrors.push({
      field,
      message: err.msg
    });
  });

  return res.status(422).json({
    success: false,
    errors: extractedErrors
  });
};

module.exports = validate;
