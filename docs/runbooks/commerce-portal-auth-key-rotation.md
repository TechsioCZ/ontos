# Runbook: Commerce portal-auth signing-secret rotation

Owner: `app/verticals/commerce-customer-context`. For a deployment that has not yet opted into the
realm, use the fresh-deploy runbook instead.

Env vars (`api/portal-auth/provider/config.ts`, `auth.ts`):

- `COMMERCE_PORTAL_AUTH_SECRET` — required, ≥32 chars. Legacy bare-value fallback; must stay valid
  even while `COMMERCE_PORTAL_AUTH_SECRETS` drives rotation.
- `COMMERCE_PORTAL_AUTH_SECRETS` — optional, comma-separated `version:value`, **current-key first**
  (e.g. `2:<new>,1:<old>`). Each `version` unique non-negative int, each `value` ≥32 chars.

## Rotate (add a key)

1. `openssl rand -hex 32` to generate the new secret.
2. Prepend it to `COMMERCE_PORTAL_AUTH_SECRETS` with a new, unused version number, current-key-first:
   - before: `COMMERCE_PORTAL_AUTH_SECRETS=1:<secret-v1>`
   - after: `COMMERCE_PORTAL_AUTH_SECRETS=2:<secret-v2>,1:<secret-v1>`
3. Leave `COMMERCE_PORTAL_AUTH_SECRET` set to any valid (≥32 char) value. Do not blank it.
4. Deploy/restart the Commerce Customer Context process (config is read once at boot; no hot reload).
5. Verify (below).
6. Once nothing needs the old key, drop its entry from `COMMERCE_PORTAL_AUTH_SECRETS` in a separate,
   later deploy — never in the same step as adding the new one.

Removing an old version invalidates every outstanding session cookie and signature under it
(forces re-auth) but does not delete the DB session row or invalidate reset/verification tokens
(those are opaque DB-backed values, not secret-signed). To revoke sessions outright, use
`CommercePortalAuthSessionLifecycle.revoke` / `revokeAll`.

## Verify

Run from `app/verticals/commerce-customer-context` (or `pnpm --filter @app/commerce-customer-context <script>` from `app/`):

```sh
pnpm db:portal-auth:check              # drizzle-kit check --config drizzle.portal-auth.config.ts
pnpm db:portal-auth:verify             # table catalog + runtime-role privilege proof
pnpm test:unit -- tests/unit/portal-auth-provider.test.ts
```

Then send a portal-auth sign-in route a request with deliberately wrong credentials:

- **`401`** — expected. New config parsed, realm live, bad credentials correctly rejected.
- **`503`** (`"...realm is not installed..."`) — unexpected here; see Rollback.

## Rollback

A bad rotation (malformed `COMMERCE_PORTAL_AUTH_SECRETS` or under-length `COMMERCE_PORTAL_AUTH_SECRET`)
does not degrade to the 503 fail-closed path — it fails the boot for the whole vertical
(`Layer.orDie` in `api/index.ts` wraps the API handler layer).

1. Restore the previous known-good `COMMERCE_PORTAL_AUTH_SECRETS` (and `_SECRET` if touched).
2. Redeploy/restart — there is no partial-degradation state to wait out.
3. Re-run Verify before retrying the rotation.
