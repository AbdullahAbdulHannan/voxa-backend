const express = require('express');
const router = express.Router();
const { body, query, param } = require('express-validator');
const reminderController = require('../controllers/reminderController');
const { auth } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

// Create a new reminder
router.post(
  '/',
  auth,
  [
    body('type')
      .isIn(['Task', 'Meeting', 'Location'])
      .withMessage('Type must be one of: Task, Meeting, Location'),
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('description').optional().trim(),
    body('icon').optional().trim(),
    body('startDate').optional().isISO8601().withMessage('Invalid start date'),
    body('endDate').optional().isISO8601().withMessage('Invalid end date'),
    body('location').optional().isObject().withMessage('Location must be an object'),
    body('location.name').optional().trim(),
    body('location.link').optional().isURL().withMessage('Invalid location URL'),
  ],
  validate,
  reminderController.createReminder
);

// Get all reminders for the authenticated user with optional filtering
router.get(
  '/',
  auth,
  [
    query('type')
        .optional()
        .isIn(['Task', 'Meeting', 'Location'])
        .withMessage('Type must be one of: Task, Meeting, Location'),
      query('completed')
        .optional()
        .isBoolean()
        .withMessage('Completed must be a boolean'),
      query('startDate')
        .optional()
        .isISO8601()
        .withMessage('Start date must be a valid date'),
      query('endDate')
        .optional()
        .isISO8601()
        .withMessage('End date must be a valid date'),
      query('page')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Page must be a positive integer'),
      query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('Limit must be between 1 and 100'),
    ],
    validate,
    reminderController.getReminders
);

// Update a reminder
router.put(
  '/:id',
  auth,
  [
    body('type').optional().isIn(['Task', 'Meeting', 'Location']).withMessage('Invalid reminder type'),
    body('title').optional().trim().notEmpty().withMessage('Title cannot be empty'),
    body('description').optional().trim(),
    body('icon').optional().trim(),
    body('startDate').optional().isISO8601().withMessage('Invalid start date'),
    body('endDate').optional().isISO8601().withMessage('Invalid end date'),
    body('isCompleted').optional().isBoolean().withMessage('isCompleted must be a boolean'),
    body('location').optional().isObject().withMessage('Location must be an object'),
    body('location.name').optional().trim(),
    body('location.link').optional().isURL().withMessage('Invalid location URL'),
  ],
  validate,
  reminderController.updateReminder
);

// Get a single reminder by ID
// router.get(
//   '/:id',
//   auth,
//   [
//     param('id')
//       .isMongoId()
//       .withMessage('Invalid reminder ID'),
//     validate
//   ],
//   reminderController.getReminder
// );

// Delete a reminder
router.delete('/:id', auth, reminderController.deleteReminder);

module.exports = router;
