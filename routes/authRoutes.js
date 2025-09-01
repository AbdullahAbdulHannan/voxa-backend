const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Regular auth routes
router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password/:token', authController.resetPassword);

// Google auth route
router.post('/google', authController.googleAuth);

module.exports = router;