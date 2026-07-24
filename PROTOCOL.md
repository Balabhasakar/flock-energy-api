# PROTOCOL.md — Legacy "Urja Meter Ops" Portal Behavior

> **Status: FULLY CONFIRMED.** All core endpoints (auth, meters list,
> meter detail, meter energy/consumption, transformer/hierarchy data)
> verified via live DevTools traces. This portal is a SvelteKit app whose
> frontend itself calls a clean internal JSON API under `/portal/...` —
> no HTML scraping is used anywhere in the final adapter.

## 1. Authentication Workflow

**App framework:** SvelteKit (confirmed from `__sveltekit` bootstrap
script and `_app/immutable/` asset paths in page source). Login is a
SvelteKit form action, not a plain custom REST endpoint — this affects
the response shape below.

- **Endpoint:** `POST /login` — `CONFIRMED`
- **Payload:** `multipart/form-data` with fields `email` + `password`
  (field is `email`, **not** `username`) — `CONFIRMED`
- **CSRF token:** none observed in the request payload — `CONFIRMED` (no
  hidden token field submitted alongside email/password)
- **Failure signal:** `CONFIRMED` — the HTTP status is **always 200**,
  even when login fails. Failure is indicated by the JSON response body:
  ```json
  {
    "type": "failure",
    "status": 401,
    "data": "[{\"email\":1,\"error\":2},\"operator@urja.local\",\"Invalid email or password.\"]"
  }
  ```
  The `data` field is a **devalue-encoded** string (SvelteKit's compact
  serialization format): the first array element is a map of field name →
  index, and the following elements are the actual values. So
  `{"email":1,"error":2}` means index 1 = the submitted email, index 2 =
  the error message.
- **Success signal:** `CONFIRMED`. Successful login returns:
  ```json
  {"type": "redirect", "status": 303, "location": "/meters"}
  ```
  (again, HTTP status is 200 — the `303`/`location` are logical values
  inside the body, mirroring the failure-case pattern). `/meters` is
  confirmed as the post-login landing route.
- **Session cookie:** `CONFIRMED`. Set via `Set-Cookie` on successful
  login:
  ```
  __Secure-better-auth.session_token=<token>; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax
  ```
  - Cookie name confirms the portal uses the **better-auth** library.
  - `Max-Age=3600` — session is valid for 1 hour. The adapter should treat
    sessions as stale slightly before this (e.g. proactively re-login
    after ~55 min) rather than waiting for a hard failure, though reactive
    reauth-on-failure is already implemented as a fallback.
  - `HttpOnly` + `Secure` + `__Secure-` prefix — cookie jar must operate
    over HTTPS only (already the case, since `baseUrl` is `https://...`).
    `axios-cookiejar-support` + `tough-cookie` handle this automatically;
    no special-casing needed in `client.js`.
- **Session expiry signal:** still `[ASSUMED]` — likely the same
  `type: "failure"` pattern as login, redirecting to `/login` or returning
  a failure body on an authenticated request after the session lapses.
  Confirm once a session naturally expires or is tested by clearing the
  cookie manually.

## 2. Internal Endpoints Discovered

| Method | Path | Notes | Status |
|---|---|---|---|
| GET | `/portal/meters/search?q=<query>&page=<n>` | **Real JSON API** (not HTML scraping). Returns `{data:[{meterId,serialNo,make,phaseType,installStatus,dtCode}],total,page,pageSize}`. `q` blank = no filter. 403 meters total, 20/page. This is what the `/meters` page's UI calls internally for both initial load and pagination/search — confirmed by capturing the XHR while clicking "Next" and typing in the search box. | `CONFIRMED` |
| GET | `/portal/meters/{id}/geo` | **Real JSON API, confirmed.** Returns `{data:{latitude,longitude}}`. Only fired when opening an individual meter's detail page. | `CONFIRMED` |
| GET | `/portal/meters/{id}/energy` | **Real JSON API, confirmed.** Returns `{data:[{timestamp,kwh,kvah,voltR}]}` — 30-min interval readings. `timestamp` is `DD/MM/YYYY HH:mm` (day-first, confirmed by sequential dates in sample data). `kwh`/`kvah` are cumulative register readings (strings, need `parseFloat`), NOT per-interval deltas — computing a period's actual consumption requires subtracting readings. `voltR` = instantaneous R-phase voltage (string). No pagination seen; date-range filter params (e.g. `from`/`to`) not yet confirmed. | `CONFIRMED` |
| — | No standalone `/portal/meters/{id}` endpoint | **Confirmed absence.** Opening a meter's detail page only fires `/geo` and `/energy` — no third call for base fields (serial/make/phase/status). The frontend must already hold that data client-side from the earlier `/portal/meters/search` list call. Our adapter reconstructs it by re-calling `search?q={id}` and merging with `/geo`. | `CONFIRMED` |
| GET | `/portal/dts?page=<n>` | **Real JSON API**, confirmed. Returns `{data:[{code,name,feederCode,capacityKva}],total,page,pageSize}`. 40 transformers total, 20/page. Used to synthesize the `/hierarchy` extension (Feeder → DT), since there's no literal `/hierarchy` route. | `CONFIRMED` |

**Key finding:** this portal is NOT primarily HTML-to-scrape — it's a
SvelteKit frontend that itself calls a clean internal JSON API under
`/portal/...`. The adapter (`client.js`) has been rewritten to call these
JSON endpoints directly wherever confirmed, which is far more robust than
the original HTML-parsing plan.

**Remaining action items:**
- Click into an individual meter (e.g. `/meters/J100000`) and check the
  Network tab for a `/portal/meters/J100000` (or similar) JSON call.
- Same for that meter's consumption/history view, if one exists in the UI.
- Confirm whether `/portal/meters/search` and `/portal/dts` require any
  request headers beyond the session cookie (e.g. an `Accept: application/json`
  header) — check the Request Headers tab on one of these calls.

## 3. Data Structures & Anomalies

To be filled in once real data is available. Things to watch for:
- Inconsistent date formats between pages (e.g. `DD/MM/YYYY` vs ISO)
- Numeric fields rendered with currency symbols, commas, or units
  (`"1,240.50 kWh"`) that need stripping before parsing to `float`
- Missing/`N/A` fields in older meter records
- Pagination on `/meters` (if the list is large, is there a `?page=` param?)
- Rate limiting or bot-detection on repeated automated requests

## 4. Verification Checklist

- [x] Captured real login request/response in DevTools
- [x] Confirmed cookie name(s) — no CSRF token flow exists
- [x] Confirmed `/portal/meters/search` returns JSON (not HTML)
- [x] Confirmed exact JSON shape for meters list, energy, geo, transformers
- [x] Confirmed session cookie details (better-auth, 1hr expiry)
- [x] Updated `src/client.js` to match verified behavior
- [x] Removed HTML-scraping code (cheerio) entirely — not needed
- [ ] Session expiry / reauth behavior still unconfirmed (would need to
      wait out the 1hr cookie expiry or manually clear it to observe)
- [ ] Date-range filtering params on `/portal/meters/{id}/energy` (e.g.
      `from`/`to`) not yet confirmed — currently fetches the full range
      the portal returns by default
- [ ] Pagination behavior of `/portal/dts` beyond page 1 assumed to follow
      the same `{data,total,page,pageSize}` shape as meters search (not
      independently re-verified per page, but same API family)
