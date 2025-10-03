const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const { auth } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const locationController = require('../controllers/locationController');

// Store background location permission flag
router.post(
  '/permission',
  auth,
  [
    body('backgroundGranted').isBoolean().withMessage('backgroundGranted must be boolean')
  ],
  validate,
  locationController.setPermission
);

// Scan nearby places for active location reminders and possibly trigger
router.post(
  '/scan',
  auth,
  [
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('lat invalid'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('lng invalid')
  ],
  validate,
  locationController.scanAndTrigger
);

module.exports = router;
