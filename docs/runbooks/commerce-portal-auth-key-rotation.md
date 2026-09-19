# Runbook: Commerce portal-auth signing-secret rotation

Owner: `app/verticals/commerce-customer-context` (Commerce portal authentication realm).
Read this before touching `COMMERCE_PORTAL_AUTH_SECRET` or `COMMERCE_PORTAL_AUTH_SECRETS` on a
deployment that has already opted into the realm (see the fresh-deploy runbook for a deployment
that has not opted in yet).

## What is being rotated

Source of truth: `app/verticals/commerce-customer-context/api/portal-auth/provider/config.ts` and
`.../provider/auth.ts`.

- `COMMERCE_PORTAL_AUTH_SECRET` — a single required value (minimum 32 characters). Historically the
  only signing secret; the config module's own comment now calls it "the legacy bare-value
  fallback" once `COMMERCE_PORTAL_AUTH_SECRETS` is populated. It must always be present and valid
  (`parseCommercePortalAuthConfig` rejects anything shorter than 32 characters) even while rotation
  is driven through `COMMERCE_PORTAL_AUTH_SECRETS`.
- `COMMERCE_PORTAL_AUTH_SECRETS` — optional, comma-separated `version:value` pairs, **current-key
  first**, e.g. `2:<new-32+-char-secret>,1:<previous-32+-char-secret>`. Each `version` must be a
  unique non-negative integer and each `value` at least 32 characters; a malformed or duplicate-
  version entry fails config parsing (`app/verticals/commerce-customer-context/tests/unit/portal-auth-provider.test.ts`,
  "rejects malformed Better Auth rotation keys"). Parsed values are passed to Better Auth as
  `secrets: [{ value, version }, ...]` in `auth.ts`.
- `COMMERCE_PORTAL_AUTH_POLICY.secretRotation` (`config.ts`) records the intent in code:
  `versionedSecretsSupportedByProvider: true` and `routineRefreshRotatesSessionIdentifier: false` —
  a routine session refresh does not itself rotate the session identifier, only credential change,
  privilege boundary, recovery, sign-in and step-up do (`session.identifierRotation` in the same
  policy).

## Order of operations (adding a new key — the safe direction)

1. Generate a new secret of at least 32 characters, e.g. `openssl rand -hex 32`.
2. Prepend it to `COMMERCE_PORTAL_AUTH_SECRETS` with a **new, unused** version number ahead of the
   existing entries (current-key-first). Keep every still-trusted older entry after it. Example,
   rotating from version 1 to version 2:
   - before: `COMMERCE_PORTAL_AUTH_SECRETS=1:<secret-v1>`
   - after: `COMMERCE_PORTAL_AUTH_SECRETS=2:<secret-v2>,1:<secret-v1>`
3. Leave `COMMERCE_PORTAL_AUTH_SECRET` set to any valid (≥32 character) value — it is still a
   required field even though `COMMERCE_PORTAL_AUTH_SECRETS` is what actually carries the rotation.
   Do not blank it.
4. Deploy the updated environment and restart/redeploy the Commerce Customer Context process.
   Configuration is read once at boot from `ConfigProvider.fromEnv` — there is no hot-reload path,
   so a config-only edit with no restart has no effect.
5. Verify (see below).
6. Once you are certain nothing still needs the old key (see "What gets invalidated" below), drop
   its entry from `COMMERCE_PORTAL_AUTH_SECRETS` in a later, separate deploy. Do not remove an old
   version in the same step you add the new one.

## What gets invalidated at each step

- **Adding a new current-key-first entry while keeping the old one:** non-disruptive. Anything
  already signed under a version still listed in `COMMERCE_PORTAL_AUTH_SECRETS` keeps verifying;
  this is the entire reason the array exists ("a Commerce deployment must be able to rotate its
  secret ... independently", `config.ts`).
- **Removing a version from `COMMERCE_PORTAL_AUTH_SECRETS`:** whatever was signed under that
  version stops verifying immediately on the next boot that reads the new value — holders are
  forced to re-authenticate. Do this only after you have confirmed (step 5) that no traffic still
  depends on it.
- **Session validity itself:** `COMMERCE_PORTAL_AUTH_POLICY.session.cookieCacheEnabled` is `false`,
  so live sessions are resolved by their database-stored token on every request
  (`portal-auth/persistence/portal-auth-tables.ts`), not purely by verifying a signed cookie. The
  session cookie Better Auth issues is still signed with the rotating secret, though: **removing a
  version from `COMMERCE_PORTAL_AUTH_SECRETS` invalidates every still-outstanding session cookie
  signed under it** — the signature no longer verifies, so the holder is forced to re-authenticate —
  but it does **not** delete or revoke the underlying session row in the database. The row stays
  live (and would still validate a cookie re-signed under a still-trusted version) until it expires
  on its own or is revoked explicitly. If an operator wants the session rows themselves gone — for
  example because a credential compromise is suspected, not just a routine rotation — use the
  lifecycle revoke path instead of (or in addition to) rotating the secret:
  `CommercePortalAuthSessionLifecycle.revoke` / `revokeAll` — not a side effect of key rotation.
- **Password-reset and email-verification tokens** are opaque, database-backed, one-use values
  (see the `verification`/token tables under `src/portal-auth/persistence/portal-auth-tables.ts`),
  not signatures over the rotating secret; rotating the secret does not invalidate an in-flight
  reset or verification link.

## Verification commands

Run from `app/verticals/commerce-customer-context` (or via `pnpm --filter @app/commerce-customer-context <script>` from `app/`). All three exist in that package's `package.json`:

```sh
pnpm db:portal-auth:check              # drizzle-kit check --config drizzle.portal-auth.config.ts
pnpm db:portal-auth:verify             # node scripts/verify-portal-auth-db-schema.mts — table catalog + runtime-role privilege proof
pnpm test:unit -- tests/unit/portal-auth-provider.test.ts   # rstest: config parsing incl. rotation-key tests
```

Then confirm the deployment itself came up: the vertical's `readiness` route is unconditional and
does not depend on the portal-auth realm, so use one of the four portal-auth groups (e.g. the
configured sign-in route) to prove the new configuration parsed and the realm is live. Send that
route a request with deliberately wrong credentials and check the status code, not just that the
process answers at all:

- **`401`** — expected. The realm parsed the new configuration, is live, and correctly rejected bad
  credentials; this is the proof the rotation deploy succeeded.
- **`503`** — the fail-closed retryable response naming `"The Commerce portal authentication realm
  is not installed in this deployment"` (`api/portal-auth/realm-unavailable.ts`). This is *not* the
  expected outcome for a deployment that had already opted into the realm before the rotation; see
  "If the rotation was bad" below for how a bad rotation actually fails (it does not degrade to this
  `503`) and what a `503` here would instead indicate.

## If the rotation was bad (rollback)

A malformed `COMMERCE_PORTAL_AUTH_SECRETS` or an under-length `COMMERCE_PORTAL_AUTH_SECRET` does
**not** degrade gracefully to the fail-closed 503 realm. That path
(`api/portal-auth/realm-unavailable.ts`, wired in `api/index.ts` via
`selectPortalAuthRuntimeLive`) only exists for a deployment that opted out entirely — one that
declared none of `COMMERCE_PORTAL_AUTH_URL` / `_DATABASE_URL` / `_SECRET`. Once any one of those is
declared, the deployment is committed to a fully valid configuration: `resolvedApiHandlersLive` in
`api/index.ts` wraps the whole API handler layer — portal-auth included — in `Layer.orDie`, so a
config parse failure becomes a boot-time defect that brings down **every** route of this vertical,
not only the four portal-auth groups.

Rollback:

1. Restore the previous, known-good `COMMERCE_PORTAL_AUTH_SECRETS` (and `COMMERCE_PORTAL_AUTH_SECRET`
   if that was also touched) immediately.
2. Redeploy/restart. There is no partial-degradation state to wait out — the process either boots
   with a config that parses, or it does not boot at all.
3. Re-run the verification commands above before trying the rotation again.
