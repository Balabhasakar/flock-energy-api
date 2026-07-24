// src/config.js
require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,

  // Legacy portal base URL. Override via .env for local/staging testing.
  urjaBaseUrl: process.env.URJA_BASE_URL || 'https://urja-ops.flockenergy.tech',

  // Credentials for the legacy portal. NEVER hardcode these — always pull
  // from environment variables. See .env.example.
  urjaUsername: process.env.URJA_USERNAME,
  urjaPassword: process.env.URJA_PASSWORD,

  // How many times to retry a request after a forced re-login before giving up.
  maxReauthRetries: 1
};
