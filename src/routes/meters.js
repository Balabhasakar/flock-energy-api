// src/routes/meters.js
const express = require('express');
const { SessionExpiredError } = require('../client');

function createMetersRouter(portalClient) {
  const router = express.Router();

  // Shared error handler for legacy-portal calls
  const handle = (fn) => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (result === null) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.json(result);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return res.status(502).json({
          error: 'Legacy portal session could not be re-established',
          detail: err.message
        });
      }
      res.status(500).json({ error: 'Internal error', detail: err.message });
    }
  };

  /**
   * @openapi
   * /api/v1/meters:
   *   get:
   *     summary: List all smart meters
   *     tags: [Meters]
   *     parameters:
   *       - in: query
   *         name: page
   *         schema: { type: integer, default: 1 }
   *         description: Page number (legacy portal paginates at 20/page)
   *       - in: query
   *         name: q
   *         schema: { type: string }
   *         description: Optional search string (meter number or serial number)
   *     responses:
   *       200:
   *         description: Paginated array of meters
   */
  router.get(
    '/meters',
    handle(async (req) => {
      const page = parseInt(req.query.page, 10) || 1;
      const q = req.query.q || '';
      return portalClient.listMeters(page, q);
    })
  );

  /**
   * @openapi
   * /api/v1/meters/{id}:
   *   get:
   *     summary: Get details for a single meter (base info + coordinates)
   *     tags: [Meters]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Meter detail object, including lat/long coordinates
   *       404:
   *         description: Meter not found
   */
  router.get(
    '/meters/:id',
    handle(async (req) => portalClient.getMeterDetails(req.params.id))
  );

  /**
   * @openapi
   * /api/v1/meters/{id}/consumption:
   *   get:
   *     summary: Get consumption history for a meter
   *     tags: [Meters]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Consumption history
   *       404:
   *         description: Meter not found
   */
  router.get(
    '/meters/:id/consumption',
    handle(async (req) => portalClient.getMeterConsumption(req.params.id))
  );

  /**
   * @openapi
   * /api/v1/hierarchy:
   *   get:
   *     summary: Get the organizational meter network tree (optional extension)
   *     tags: [Hierarchy]
   *     responses:
   *       200:
   *         description: Nested hierarchy tree
   */
  router.get(
    '/hierarchy',
    handle(async () => portalClient.getHierarchy())
  );

  return router;
}

module.exports = createMetersRouter;
