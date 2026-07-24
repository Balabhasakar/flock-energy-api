// src/client.js
//
// Adapter layer for the legacy "Urja Meter Ops" portal.
// This module is the ONLY place that should know about the legacy portal's
// HTTP shape (URLs, form fields, HTML structure). Everything above this
// layer (routes/) should only ever see clean JS objects.
//
// =========================================================================
// !! ASSUMPTIONS FLAGGED BELOW (marked with "ASSUMPTION:") are placeholders
// !! based on common legacy-portal patterns. You MUST verify these against
// !! real DevTools network traces (Step 1 of the assignment) and update
// !! this file + PROTOCOL.md to match reality.
// =========================================================================

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const config = require('./config');

class SessionExpiredError extends Error {
  constructor(message = 'Session expired or unauthorized') {
    super(message);
    this.name = 'SessionExpiredError';
    this.statusCode = 401;
  }
}

class UrjaPortalClient {
  constructor(baseUrl = config.urjaBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.jar = new CookieJar();
    this.http = wrapper(
      axios.create({
        jar: this.jar,
        withCredentials: true,
        timeout: 10000,
        // Legacy portals often 302-redirect to /login on an expired session
        // instead of returning a clean 401. Don't auto-follow so we can
        // detect that redirect ourselves.
        maxRedirects: 0,
        validateStatus: (status) => status < 500,
        // SvelteKit's built-in CSRF protection checks the Origin header on
        // any non-GET form-action request (e.g. POST /login) and rejects
        // it with 403 if Origin doesn't match the site's own origin. A
        // real browser sends this automatically; a plain Node HTTP client
        // does not, so we set it explicitly here as a default header for
        // every request this client instance makes.
        headers: {
          Origin: this.baseUrl,
          Referer: `${this.baseUrl}/login`
        }
      })
    );
    this.isAuthenticated = false;
    this.loginPromise = null; // guards against concurrent duplicate logins
  }

  /**
   * Logs into the legacy portal and stores session cookies in the jar.
   *
   * CONFIRMED (via live DevTools trace, 2026-07):
   * - This is a SvelteKit app. The login form posts to `/login` as a
   *   SvelteKit form action.
   * - Request payload uses field names `email` + `password` (NOT
   *   `username` — that was an earlier wrong assumption), sent as
   *   `multipart/form-data` (standard HTML <form> POST — no JS
   *   `x-sveltekit-action` header was present, so this is the classic
   *   non-enhanced form submission path).
   * - CRITICAL: the HTTP status is ALWAYS 200, even on a failed login.
   *   SvelteKit's `fail(401, {...})` action pattern encodes the *logical*
   *   status inside the JSON body, not the HTTP status code. Do NOT use
   *   `response.status` to detect login failure here.
   * - Response body on failure looks like:
   *   `{"type":"failure","status":401,"data":"[{\"email\":1,\"error\":2},\"<email>\",\"<message>\"]"}`
   *   The `data` field is a *devalue-encoded* JSON string: a flat array
   *   where the first element is a map of field-name -> array-index, and
   *   subsequent elements are the actual values at those indices.
   * - Response body on success: `CONFIRMED` —
   *   `{"type":"redirect","status":303,"location":"/meters"}`
   *   (again, HTTP status is 200 — the 303/location are logical values
   *   inside the body). `/meters` is confirmed as the post-login landing
   *   route, matching this project's planned `/api/v1/meters` endpoint.
   * - Session cookie: `CONFIRMED` — `__Secure-better-auth.session_token`,
   *   `HttpOnly; Secure; SameSite=Lax; Max-Age=3600` (1hr expiry, portal
   *   uses the better-auth library). Handled automatically by
   *   axios-cookiejar-support + tough-cookie since baseUrl is HTTPS — no
   *   special-casing needed here.
   */
  async login(email = config.urjaUsername, password = config.urjaPassword) {
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      if (!email || !password) {
        throw new Error(
          'Missing URJA_USERNAME / URJA_PASSWORD environment variables'
        );
      }

      const loginUrl = `${this.baseUrl}/login`;
      const form = new FormData();
      form.append('email', email);
      form.append('password', password);

      const response = await this.http.post(loginUrl, form);

      let parsed;
      try {
        parsed = typeof response.data === 'string'
          ? JSON.parse(response.data)
          : response.data;
      } catch {
        parsed = null;
      }

      // SvelteKit action failures come back as HTTP 200 with
      // { type: "failure", status: <logical status>, data: "<devalue string>" }
      const isLogicalFailure = parsed && parsed.type === 'failure';

      if (isLogicalFailure) {
        this.isAuthenticated = false;
        const errorMessage = this._extractSvelteKitFailureMessage(parsed);
        throw new Error(
          `Login rejected by legacy portal (logical status ${parsed.status}): ${errorMessage}`
        );
      }

      // Treat anything else (type: "success", type: "redirect", or a
      // classic 302) as success, pending confirmation with real credentials.
      const success =
        (parsed && (parsed.type === 'success' || parsed.type === 'redirect')) ||
        response.status === 302;

      this.isAuthenticated = Boolean(success);
      if (!success) {
        throw new Error(
          `Login failed against legacy portal (unrecognized response shape, status ${response.status})`
        );
      }
      return true;
    })();

    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  /**
   * Decodes SvelteKit's devalue-style failure payload:
   * `data` is a JSON string like `[{"email":1,"error":2},"<email>","<msg>"]`
   * where the first element maps field names to indices into the rest of
   * the array. This pulls out the human-readable error message.
   */
  _extractSvelteKitFailureMessage(parsed) {
    try {
      const decoded = JSON.parse(parsed.data);
      const [fieldMap, ...values] = decoded;
      const errorIndex = fieldMap.error;
      return errorIndex != null ? values[errorIndex - 1] : JSON.stringify(decoded);
    } catch {
      return 'Unknown error (could not decode devalue payload)';
    }
  }

  /**
   * Wraps a request with auto-reauth: if the legacy portal signals an
   * expired session (401, or a redirect back to /login), log in again and
   * retry exactly once.
   */
  async _requestWithReauth(requestFn, retries = config.maxReauthRetries) {
    if (!this.isAuthenticated) {
      await this.login();
    }

    const response = await requestFn();

    const sessionExpired =
      response.status === 401 ||
      (response.status === 302 && /\/login/i.test(response.headers.location || ''));

    if (sessionExpired) {
      if (retries <= 0) {
        throw new SessionExpiredError();
      }
      this.isAuthenticated = false;
      await this.login();
      return this._requestWithReauth(requestFn, retries - 1);
    }

    return response;
  }

  /**
   * GET /meters — list of smart meters.
   *
   * CONFIRMED (via live DevTools trace, 2026-07): the portal exposes a
   * clean internal JSON API — NOT HTML scraping. The frontend's pagination
   * (and search box) call:
   *   GET /portal/meters/search?q=<query>&page=<n>
   * returning:
   *   { data: [{ meterId, serialNo, make, phaseType, installStatus, dtCode }],
   *     total, page, pageSize }
   * `q` can be blank for "no filter". This replaces the earlier HTML-table
   * scraping approach entirely — far more reliable.
   *
   * @param {number} page - 1-indexed page number.
   * @param {string} query - optional search string (meter number or serial).
   */
  async listMeters(page = 1, query = '') {
    const response = await this._requestWithReauth(() =>
      this.http.get(`${this.baseUrl}/portal/meters/search`, {
        params: { q: query, page }
      })
    );

    if (response.status !== 200 || !response.data || !Array.isArray(response.data.data)) {
      throw new Error(
        `Unexpected response from /portal/meters/search (status ${response.status})`
      );
    }

    const meters = response.data.data.map((m) => ({
      meter_id: m.meterId,
      serial_number: m.serialNo,
      make: m.make,
      phase: m.phaseType,
      status: this._normalizeStatus(m.installStatus),
      transformer_code: m.dtCode
    }));

    return {
      meters,
      pagination: {
        total: response.data.total,
        page: response.data.page,
        pageSize: response.data.pageSize,
        totalPages: response.data.pageSize
          ? Math.ceil(response.data.total / response.data.pageSize)
          : null
      }
    };
  }

  /**
   * GET /meters/{id} — single meter detail.
   *
   * CONFIRMED (via live DevTools trace, 2026-07): there is NO standalone
   * `/portal/meters/{id}` JSON endpoint. Clicking into a meter only
   * triggers two calls:
   *   - GET /portal/meters/{id}/geo   -> { data: { latitude, longitude } }
   *   - GET /portal/meters/{id}/energy (see getMeterConsumption)
   * Basic fields (serial, make, phase, status, transformer code) are
   * presumably already held client-side from the list page's earlier
   * `/portal/meters/search` call, so the frontend never re-fetches them.
   * This method reconstructs a full detail object by combining:
   *   1. `/portal/meters/search?q={id}` filtered to the exact meter (reuses
   *      the confirmed listMeters() endpoint)
   *   2. `/portal/meters/{id}/geo` for coordinates
   */
  async getMeterDetails(meterId) {
    const [searchResult, geoResponse] = await Promise.all([
      this.listMeters(1, meterId),
      this._requestWithReauth(() =>
        this.http.get(`${this.baseUrl}/portal/meters/${encodeURIComponent(meterId)}/geo`)
      )
    ]);

    const match = searchResult.meters.find((m) => m.meter_id === meterId);
    if (!match) {
      return null;
    }

    let coordinates = null;
    if (geoResponse.status === 200 && geoResponse.data?.data) {
      coordinates = {
        latitude: this._normalizeNumber(geoResponse.data.data.latitude),
        longitude: this._normalizeNumber(geoResponse.data.data.longitude)
      };
    }

    return { ...match, coordinates };
  }

  /**
   * GET /meters/{id}/consumption — energy/consumption interval readings.
   *
   * CONFIRMED (via live DevTools trace, 2026-07): real endpoint is
   *   GET /portal/meters/{id}/energy
   * returning 30-minute interval readings:
   *   { data: [{ timestamp: "DD/MM/YYYY HH:mm", kwh, kvah, voltR }] }
   * All numeric fields arrive as STRINGS and must be parsed. `kwh`/`kvah`
   * are cumulative meter register readings (not per-interval deltas) —
   * consumption for a period is the difference between readings, not the
   * raw value itself. `voltR` is instantaneous R-phase voltage at that
   * timestamp. No pagination observed in this response (single flat array
   * covering the requested range) — date-range filtering params, if any,
   * are NOT YET CONFIRMED (worth checking for `from`/`to` query params).
   */
  async getMeterConsumption(meterId) {
    const response = await this._requestWithReauth(() =>
      this.http.get(`${this.baseUrl}/portal/meters/${encodeURIComponent(meterId)}/energy`)
    );

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200 || !Array.isArray(response.data?.data)) {
      throw new Error(
        `Unexpected response from /portal/meters/${meterId}/energy (status ${response.status})`
      );
    }

    const history = response.data.data.map((reading) => ({
      timestamp: this._normalizeLegacyTimestamp(reading.timestamp),
      kwh: this._normalizeNumber(reading.kwh),
      kvah: this._normalizeNumber(reading.kvah),
      volt_r: this._normalizeNumber(reading.voltR)
    }));

    return { meter_id: meterId, history };
  }

  /**
   * Parses the legacy portal's "DD/MM/YYYY HH:mm" timestamp format into
   * ISO 8601. Note: DD/MM (not MM/DD) — confirmed by sequential dates like
   * "23/06/2026" -> "24/06/2026" -> "25/06/2026" in observed data.
   */
  _normalizeLegacyTimestamp(raw) {
    if (!raw) return null;
    const match = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!match) return raw; // fall back to raw string if format ever differs
    const [, dd, mm, yyyy, hh, min] = match;
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:00`;
  }

  /**
   * GET /hierarchy — network tree (Feeder -> Distribution Transformer).
   *
   * CONFIRMED (via live DevTools trace, 2026-07): there is no literal
   * `/hierarchy` route. Instead, `/portal/dts?page=N` returns transformer
   * (DT) records with a `feederCode`:
   *   { data: [{ code, name, feederCode, capacityKva }], total, page, pageSize }
   * 40 DTs total, 20/page (2 pages). This method paginates through all DTs
   * and groups them by feeder to synthesize a Feeder -> DT tree, since the
   * portal itself doesn't expose a single "hierarchy" JSON blob.
   *
   * NOTE: meter -> DT association is already available per-meter via
   * `dtCode` from `listMeters()` / `getMeterDetails()`, so a full
   * Feeder -> DT -> Meter tree could be built by cross-referencing both
   * endpoints if that level of detail is ever needed.
   */
  async getHierarchy() {
    const allDts = [];
    let page = 1;
    let totalPages = 1;

    do {
      const response = await this._requestWithReauth(() =>
        this.http.get(`${this.baseUrl}/portal/dts`, { params: { page } })
      );

      if (response.status !== 200 || !Array.isArray(response.data?.data)) {
        throw new Error(
          `Unexpected response from /portal/dts (status ${response.status})`
        );
      }

      allDts.push(...response.data.data);
      totalPages = response.data.pageSize
        ? Math.ceil(response.data.total / response.data.pageSize)
        : 1;
      page += 1;
    } while (page <= totalPages);

    const feederMap = new Map();
    for (const dt of allDts) {
      if (!feederMap.has(dt.feederCode)) {
        feederMap.set(dt.feederCode, { name: dt.feederCode, children: [] });
      }
      feederMap.get(dt.feederCode).children.push({
        name: dt.code,
        label: dt.name,
        capacity_kva: dt.capacityKva,
        children: []
      });
    }

    return Array.from(feederMap.values());
  }

  // ---- Normalization helpers -------------------------------------------

  _normalizeNumber(raw) {
    if (raw == null) return null;
    const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
    if (cleaned === '') return null;
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? null : num;
  }

  _normalizeDate(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString().slice(0, 10);
  }

  _normalizeStatus(raw) {
    if (!raw) return 'UNKNOWN';
    return raw.trim().toUpperCase();
  }
}

module.exports = { UrjaPortalClient, SessionExpiredError };
