// src/client.js
//
// Adapter layer for the legacy "Urja Meter Ops" portal. This module is the
// only place that knows about the legacy portal's HTTP shape (URLs, form
// fields, auth flow). Routes never touch cookies or the legacy base URL
// directly — they just call methods on this class.

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
        // Don't auto-follow redirects, so we can detect a bounce back to
        // /login as a session-expiry signal ourselves.
        maxRedirects: 0,
        validateStatus: (status) => status < 500,
        // SvelteKit's CSRF protection checks the Origin header on
        // non-GET requests. A browser sends this automatically; a plain
        // Node client doesn't, so set it explicitly here.
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
   * Logs into the legacy portal and stores the session cookie.
   *
   * The portal is a SvelteKit app — /login is a form action, so the HTTP
   * status is always 200 even on failure. Success/failure is encoded in
   * the JSON body instead ({ type: "redirect" | "failure", ... }).
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

      const isLogicalFailure = parsed && parsed.type === 'failure';

      if (isLogicalFailure) {
        this.isAuthenticated = false;
        const errorMessage = this._extractSvelteKitFailureMessage(parsed);
        throw new Error(
          `Login rejected by legacy portal (logical status ${parsed.status}): ${errorMessage}`
        );
      }

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
   * Decodes SvelteKit's devalue-encoded failure payload to pull out the
   * human-readable error message.
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
   * Wraps a request with auto-reauth: if the session has expired,
   * log in again and retry once.
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
   * GET /meters — paginated list of smart meters, backed by the portal's
   * own /portal/meters/search endpoint (also used for filtering by id).
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
   * GET /meters/{id} — single meter detail. There's no standalone detail
   * endpoint on the legacy portal, so this combines a filtered search
   * (base fields) with /geo (coordinates).
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
   * GET /meters/{id}/consumption — 30-min interval energy readings.
   * kwh/kvah are cumulative register values, not per-interval deltas.
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

  /** Converts the portal's "DD/MM/YYYY HH:mm" format to ISO 8601. */
  _normalizeLegacyTimestamp(raw) {
    if (!raw) return null;
    const match = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!match) return raw;
    const [, dd, mm, yyyy, hh, min] = match;
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:00`;
  }

  /**
   * GET /hierarchy — Feeder -> DT tree. There's no literal hierarchy route
   * on the portal, so this paginates /portal/dts and groups by feeder.
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
