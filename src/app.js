// src/app.js
const express = require('express');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const { UrjaPortalClient } = require('./client');
const createMetersRouter = require('./routes/meters');
const config = require('./config');

function createApp() {
  const app = express();
  app.use(express.json());

  // Single shared portal client instance holding the legacy session.
  // NOTE: for a multi-user production deployment, this should become a
  // per-user session pool rather than one shared adapter instance — see
  // README "Architectural trade-offs".
  const portalClient = new UrjaPortalClient(config.urjaBaseUrl);

  const openapiSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Flock Energy - Urja Meter Ops API',
        version: '1.0.0',
        description:
          'Clean REST API proxy layer over the legacy Urja Meter Ops portal'
      },
      servers: [{ url: '/' }]
    },
    apis: ['./src/routes/*.js']
  });

  app.get('/openapi.json', (req, res) => res.json(openapiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/api/v1', createMetersRouter(portalClient));

  // Fallback error handler
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Unhandled server error' });
  });

  return { app, portalClient, openapiSpec };
}

module.exports = createApp;
