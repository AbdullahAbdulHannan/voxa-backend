const jwt = require('jsonwebtoken');

/**
 * Generate JWT token for user authentication
 * @param {string} userId - The user's ID
 * @param {boolean} [rememberMe=false] - Whether to extend the token's expiry
 * @returns {string} JWT token
 */
exports.generateToken = (userId, rememberMe = false) => {
  // If rememberMe is true, token expires in 30 days, otherwise 7 days
  const expiresIn = rememberMe ? '30d' : '7d';
  
  return jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};