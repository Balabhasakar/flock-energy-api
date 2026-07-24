# REFLECTION.md

## 1. What assumptions did you make?

The build started with placeholder assumptions about the legacy portal's
login flow and page markup, since it was written before live reconnaissance
was possible from this environment. Every assumption was flagged with an
`ASSUMPTION:` comment and cross-referenced in `PROTOCOL.md`. Reconnaissance
was then done iteratively, turn by turn, replacing each guess with
confirmed behavior as real DevTools traces came in — login payload shape,
the SvelteKit `fail()`/redirect response pattern, the session cookie, and
finally each data endpoint.

The single biggest surprise: the original assumption was that the portal
returned HTML needing scraping. Reconnaissance revealed the opposite — the
frontend itself calls a clean internal JSON API under `/portal/...` for
everything (meter search, geo, energy, transformers). Once that became
clear, the entire HTML-parsing approach (and the `cheerio` dependency) was
removed in favor of calling those JSON endpoints directly — a much better
outcome than the original plan, but only discoverable through the actual
reconnaissance step, not by guessing upfront.

## 2. What was difficult?

Designing the adapter to be *correct without being verifiable* was the
core tension. Rather than writing code that would silently succeed
against fake data, I tried to make it fail loudly and specifically when
its assumptions don't hold — e.g. `getMeterDetails` throws a descriptive
error if neither the serial nor status selector matches anything, instead
of quietly returning an empty/garbage object. That's a deliberate
trade-off: less "resilient-looking" on the surface, but far easier to
debug once pointed at the real portal.

Deciding how much retry/reauth logic belongs in the adapter vs. the route
layer was another judgment call — I kept all of it in `client.js` so
routes stay dumb and portal-shape-agnostic.

## 3. What mistakes occurred / what would you do differently?

Without live access to the target portal, there's a real risk that the
selector assumptions in `client.js` are simply wrong, and no amount of
careful code structure fixes that — only actual reconnaissance does. If I
were doing this again with portal access from the start, I'd write
`PROTOCOL.md` first from real traces, then build the adapter directly
against confirmed shapes, rather than backfilling assumptions and
retrofitting.

I also initially considered auto-following redirects in the HTTP client
(the axios default), which would have made session-expiry detection via
"redirected to /login" invisible to the adapter. Catching that early and
setting `maxRedirects: 0` explicitly was a small but important fix.

## 4. What would you improve given more time?

- Replace the shared single-session adapter with a per-caller session
  pool, so the wrapper API can serve multiple concurrent users of the
  legacy portal without cross-contaminating sessions.
- Add a thin caching layer (Redis or in-memory LRU) in front of
  `listMeters()`/`getHierarchy()` to reduce load on the legacy system.
- Add integration tests that run against either the real portal (in CI
  with test credentials) or a small mock Express server that mimics its
  HTML shape, so `client.js` regressions are caught automatically.
- Add authentication (API key or JWT) to the new wrapper API itself —
  currently it's unauthenticated, which is fine for this assignment's
  scope but not for anything beyond a local demo.
- If reconnaissance reveals the legacy frontend already calls internal
  JSON endpoints, delete all HTML-scraping code in favor of calling those
  directly — much less brittle than parsing markup.

## 5. Anything else worth noting?

The layering choice — routes only ever talk to `client.js`, never to
cookies/HTML/base URLs directly — was the single decision I'd defend most
strongly. It means the "this assignment's biggest unknown" (what the
legacy portal actually looks like under the hood) is fully contained in
one file, so verifying and fixing it later touches nothing else in the
codebase.
