# Flock Energy — Urja Meter Ops API

A clean, documented REST API wrapper around the legacy "Urja Meter Ops"
portal. Handles authentication/session persistence with the legacy site,
normalizes its HTML responses into structured JSON, and exposes a modern
documented REST interface with auto-generated OpenAPI/Swagger docs.

> **Note:** `src/client.js` currently encodes *assumptions* about the legacy
> portal's login flow and HTML structure (clearly marked `ASSUMPTION:` in
> comments), since this build was done without live browser access to the
> portal. See `PROTOCOL.md` for the verification checklist — walk through
> Step 1 of the assignment against the real site and update `client.js`
> accordingly before treating this as production-ready.

## Setup

```bash
git clone <this-repo>
cd flock-energy-api
npm install
cp .env.example .env
# edit .env with real URJA_USERNAME / URJA_PASSWORD
npm start
```

Server starts on `http://localhost:4000` by default.

- Health check: `GET /health`
- Interactive docs (Swagger UI): `GET /docs`
- Raw OpenAPI spec: `GET /openapi.json`

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the API server listens on | `4000` |
| `URJA_BASE_URL` | Base URL of the legacy portal | `https://urja-ops.flockenergy.tech` |
| `URJA_USERNAME` | Legacy portal login username | *(required)* |
| `URJA_PASSWORD` | Legacy portal login password | *(required)* |

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/meters` | List all smart meters |
| GET | `/api/v1/meters/:id` | Get details for one meter |
| GET | `/api/v1/meters/:id/consumption` | Get consumption history for one meter |
| GET | `/api/v1/hierarchy` | Get the org/network tree (optional extension) |

## Sample Requests

```bash
curl http://localhost:4000/api/v1/meters?page=1
```
```json
{
  "meters": [
    {
      "meter_id": "J100000",
      "serial_number": "SE33962",
      "make": "HPL",
      "phase": "single",
      "status": "DECOMMISSIONED",
      "transformer_code": "DT-001"
    }
  ],
  "pagination": { "total": 403, "page": 1, "pageSize": 20, "totalPages": 21 }
}
```

```bash
curl http://localhost:4000/api/v1/meters?q=J100000
```
Searches by meter number or serial (forwards to the legacy portal's own search).

```bash
curl http://localhost:4000/api/v1/meters/J100002
```
```json
{
  "meter_id": "J100002",
  "serial_number": "AL28136",
  "make": "L&T",
  "phase": "single",
  "status": "INSTALLED",
  "transformer_code": "DT-003",
  "coordinates": { "latitude": 26.840224163401967, "longitude": 75.71461868999545 }
}
```

```bash
curl http://localhost:4000/api/v1/meters/J100002/consumption
```
```json
{
  "meter_id": "J100002",
  "history": [
    { "timestamp": "2026-06-23T23:30:00", "kwh": 6850.32, "kvah": 7398.35, "volt_r": 227 },
    { "timestamp": "2026-06-24T00:00:00", "kwh": 6850.78, "kvah": 7398.84, "volt_r": 236 }
  ]
}
```
Note: `kwh`/`kvah` are cumulative register readings, not per-interval deltas —
compute actual consumption for a window by subtracting readings.

```bash
curl http://localhost:4000/api/v1/hierarchy
```
```json
[
  {
    "name": "F-001",
    "children": [
      { "name": "DT-001", "label": "Malviya Nagar DT 1", "capacity_kva": 100, "children": [] }
    ]
  }
]
```

## Architecture

```
flock-energy-api/
├── src/
│   ├── server.js       # entrypoint — starts the HTTP server
│   ├── app.js           # Express app assembly, Swagger wiring
│   ├── client.js         # legacy portal adapter (auth, scraping, normalization)
│   ├── config.js         # environment-driven configuration
│   └── routes/
│       └── meters.js     # /api/v1/* route handlers
├── openapi.json           # exported OpenAPI 3.0 spec
├── PROTOCOL.md            # documented legacy-portal behavior + verification checklist
├── REFLECTION.md          # reflection write-up
└── README.md
```

**Layering principle:** `client.js` is the *only* file that knows anything
about the legacy portal's HTTP shape. Routes never touch cookies, HTML, or
the legacy base URL directly — they call clean methods on the adapter
(`listMeters()`, `getMeterDetails(id)`, etc.) and return whatever comes
back. This means if the legacy portal changes its markup, or if it turns
out to expose an internal JSON API instead of HTML, only `client.js` needs
to change.

## Architectural Trade-offs & Intentional Omissions

- **Single shared session, not per-user.** The adapter holds one session
  cookie jar for the whole API process rather than a per-caller session
  pool. This matches the assignment's "automate authentication...behind
  the scenes" framing, but means this service assumes a single legacy
  portal account is shared across all API consumers. A production version
  serving multiple end users would need a session pool keyed by API caller.
- **No caching layer.** Every request round-trips to the legacy portal.
  For a real deployment, a short-TTL cache (e.g. Redis, 30–60s) on
  `/meters` and `/hierarchy` would reduce load on the legacy system.
- **No auth on the new API itself.** The wrapper API is currently open —
  it doesn't require its own API key/JWT from callers. Intentionally
  omitted for assignment scope; flagged as a must-fix before any real
  deployment.
- **HTML parsing was NOT needed.** The original plan assumed the legacy
  portal returned HTML requiring scraping. Live reconnaissance revealed
  the opposite: the frontend itself calls a clean internal JSON API under
  `/portal/...` for everything (meter list/search, geo, energy,
  transformers). The adapter calls these directly — `cheerio` was removed
  entirely as a dependency once this was confirmed.
- **No standalone meter-detail endpoint exists.** `getMeterDetails()`
  reconstructs a full record by combining a filtered `/portal/meters/search`
  call (base fields) with `/portal/meters/{id}/geo` (coordinates) — two
  calls in parallel — since the legacy frontend itself never re-fetches
  base fields on the detail page (it already has them client-side from
  the list view).
- **Cumulative vs. delta energy values.** `/portal/meters/{id}/energy`
  returns cumulative register readings (`kwh`/`kvah`), not per-interval
  consumption deltas. The adapter passes these through as-is rather than
  computing deltas server-side, leaving that choice to API consumers who
  may want raw registers, deltas, or both depending on use case.
- **Redirects not auto-followed** in the HTTP client (`maxRedirects: 0`),
  specifically so the adapter can detect "redirected back to /login" as a
  session-expiry signal. This is a deliberate trade-off vs. default axios
  behavior.

## Running Tests / Verifying Against the Real Portal

All core endpoints (`login`, `/portal/meters/search`, `/portal/meters/{id}/geo`,
`/portal/meters/{id}/energy`, `/portal/dts`) have been confirmed via
captured live DevTools traces against the real portal — see `PROTOCOL.md`
for full details and exact response shapes. This build has NOT yet been
executed end-to-end from this codebase against the live portal directly
(no outbound network access from the build environment), so before
treating it as production-ready:

1. Run `npm start` with real credentials in `.env`.
2. Hit each endpoint via `curl` or the Swagger UI at `/docs` and confirm
   the responses match what's documented in `PROTOCOL.md`.
3. Pay particular attention to error paths not yet exercised: an invalid
   meter ID, an expired session mid-request, and pagination past page 21
   on `/meters`.
