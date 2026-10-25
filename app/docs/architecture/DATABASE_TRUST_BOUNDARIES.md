# Database Trust Boundaries

Architecture record for [TechsioCZ/ontos#174](https://github.com/TechsioCZ/ontos/issues/174) (pilot narrow database roles and trusted tenant context). It builds on the current-state audit from [TechsioCZ/ontos#370](https://github.com/TechsioCZ/ontos/issues/370) (`scripts/audit-database-trust-boundaries.mts`).

Evidence labels:

- **VERIFIED**: shown by repository code, a live probe of a fully migrated local PostgreSQL 18.6, a named test, or the audit.
- **INFERRED**: follows from code or PostgreSQL semantics, but was not observed in a deployed environment.
- **UNKNOWN**: controlled outside this repository.

Non-goals: this delivery rolls out no production grants or credentials. Checked-in role definitions do not prove how secrets are distributed in production.

## Decisions

| #   | Decision               | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Trust root (Petr)      | Option B. A hardened entry point in PostgreSQL, in schema `trust`, owned by the migration admin. There is no broker or pooler hop.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D2  | Core access (Petr)     | Each process gets an explicit, checked-in grant manifest. The bootstrap, the owner verifiers, the audit and the tests all read it.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D3  | Rollback (Petr)        | In place: changes are applied to the same database, forward only. There is no dual path, shim, wrapper or compatibility layer. Re-running the previous bootstrap restores grants only. Policies, Core RLS and the `trust` schema need the rollback release described in [Rollback](#rollback).                                                                                                                                                                                                                                                                                 |
| D4  | Pilot scope            | Party Registry, which owns schema `party` (18 tables) and schema `contacts` (3 tables). Contacts merged into Party Registry in #395. Shell and the other verticals stay on `ontos_runtime`.                                                                                                                                                                                                                                                                                                                                                                                    |
| D5  | Identity split         | Four runtime logins plus the migration admin: `ontos_runtime` (shared), `shell_gateway_issuer` (registers artifacts), `party_registry_runtime` (Party BFF) and `party_registry_worker` (Party Outbox worker entry). The issuer is split out because registration is the trust root: if every `ontos_runtime` process could register, any vertical could mint Party scope. The worker is split out because otherwise `ontos_runtime` would have to keep reading Party tables for the Party worker entry. The worker also has no issuer artifact and uses different Core tables. |
| D6  | Trusted RLS path       | For `party_registry_runtime`, these all take tenant and legal entity only from the `trust.current_*` accessors: all 20 forced-RLS tables in `party` and `contacts`, Party rows in `core.search_index_entries`, inserts of Party-produced `core.domain_events` and `core.outbox_messages` rows, and Party row locks on `core.tenants`.                                                                                                                                                                                                                                          |
| D7  | Issuer-backed artifact | The issuer-registered gateway scope grant. Shell, connected as `shell_gateway_issuer`, registers the SHA-256 digest of every Ed25519 assertion it issues for an enrolled audience. The JWT contract does not change, and no extension is needed.                                                                                                                                                                                                                                                                                                                               |
| D8  | Trusted state          | A sealed, transaction-local setting, `ontos_trust.scope`. Its HMAC-SHA-256 key never leaves the database. The seal is bound to the top-level transaction ID (`xid8`), to `session_user`, and to a deadline sealed inside it (stored grant expiry + 30 s; the stored expiry is capped at 300 s after registration, so the deadline is at most 330 s after registration). The deadline is checked against `clock_timestamp()` every time the seal is read.                                                                                                                       |
| D9  | Core evidence          | Core writes some Party evidence before the trusted scope exists: `core.action_invocations`, `core.audit_events` and `core.data_access_events`. Row-level security binds these rows to module `party.registry`, not to a tenant.                                                                                                                                                                                                                                                                                                                                                |
| D10 | Worker                 | The worker is excluded from the trusted path. Its Core write privileges are reduced to lock-only wherever Core takes a row lock.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D11 | Credentials            | Passwords for the new logins are Zerops service secrets on `migrator`, and each service that needs one references it explicitly. They are never Zerops project variables, because every service inherits those (DEPLOYMENT.md, Shell secrets section).                                                                                                                                                                                                                                                                                                                         |

## Baseline before the pilot (VERIFIED)

The probe ran against a fully migrated local PostgreSQL 18.6 at HEAD 0325cbf9f.

`ontos_runtime`:

- has `LOGIN NOINHERIT NOBYPASSRLS`;
- has USAGE on 17 schemas, including `public`, and DML on tables in 12 schemas;
- can execute 213 of the 261 SECURITY DEFINER routines;
- holds `TEMPORARY`;
- can forge `ontos.*` with `set_config` and with `SET LOCAL`. Placeholder settings are `USERSET`, and `pg_parameter_acl` is empty.

Row-level security:

- 334 tables have RLS enabled, and 332 of them are forced.
- 17 of the 22 `core` tables have no RLS, including `tenants`, `principals`, `action_invocations`, `domain_events` and `outbox_*`.

Every runtime process is `ontos_runtime`. Shell and all vertical Workers share the Hyperdrive config `ontos-stage-runtime`. The combined `outbox-worker-host` runs five owners on one `DATABASE_URL`.

Other probe results:

- `transaction_timestamp()` is identical for every transaction sent in one simple-query message.
- `pg_current_xact_id()` works in `READ ONLY` transactions and returns the top-level ID inside savepoints.
- `log_parameter_max_length = -1`: bind parameters are logged in full whenever a statement is logged.

The earlier baseline in this file (27 DML tables, 2 RLS tables, no executable SECURITY DEFINER routines) described a partially migrated database. It is superseded.

## Identities

Every runtime login is `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`. On every bootstrap pass, a runtime login:

- loses every membership in either direction;
- has its role settings reset;
- must own nothing and must not hold `CREATE` anywhere.

| Identity id              | PostgreSQL role                                    | Used by                                                                                                                                                             | URL key / Cloudflare binding (build variable)                                                                            | Scope authority                            | Stage secret                                 |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------- |
| admin                    | `ontos_admin` locally; the Zerops `db18` superuser | Migrator, Drizzle, bootstrap, seed and provision scripts, and the admin connection of the verifiers and the audit. It owns every schema, table and `trust` routine. | `DATABASE_ADMIN_URL`                                                                                                     | n/a                                        | `db18_superUserPassword`                     |
| `shared_runtime`         | `ontos_runtime`                                    | Shell BFF (Core, Better Auth), every vertical BFF except Party, the four non-Party entries of `outbox-worker-host`, and the non-Party dedicated workers             | `DATABASE_URL`; `HYPERDRIVE` (`ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID`)                                                    | `session_setting`                          | `db18_password`                              |
| `shell_gateway_issuer`   | `shell_gateway_issuer`                             | The Shell gateway-grant registrar only                                                                                                                              | `SHELL_GATEWAY_ISSUER_DATABASE_URL`; `GATEWAY_ISSUER_HYPERDRIVE` (`ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID`) | `none` (issuer)                            | `migrator_SHELL_GATEWAY_ISSUER_DB_PASSWORD`  |
| `party_registry_request` | `party_registry_runtime`                           | Party Registry BFF (Worker or Node)                                                                                                                                 | `PARTY_REGISTRY_DATABASE_URL`; `PARTY_REGISTRY_HYPERDRIVE` (`ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID`)       | `gateway_grant`, audience `party-registry` | `migrator_PARTY_REGISTRY_DB_PASSWORD`        |
| `party_registry_worker`  | `party_registry_worker`                            | The Party Outbox worker entry, either in the dedicated `party-registry-worker` service or in the combined `outbox-worker-host`                                      | `PARTY_REGISTRY_WORKER_DATABASE_URL`; no Worker binding                                                                  | `session_setting` (excluded)               | `migrator_PARTY_REGISTRY_WORKER_DB_PASSWORD` |

Credentials each process holds:

- Shell: `DATABASE_URL` and `SHELL_GATEWAY_ISSUER_DATABASE_URL`.
- Party BFF: `PARTY_REGISTRY_DATABASE_URL` only.
- Dedicated `party-registry-worker`: `PARTY_REGISTRY_WORKER_DATABASE_URL` only.
- `outbox-worker-host`: `DATABASE_URL` and `PARTY_REGISTRY_WORKER_DATABASE_URL`. Each entry builds its own pool from its own identity, so this works without changing `outbox/process.ts` (VERIFIED: every `worker-host/entry.ts` provides its own `DatabaseConfig`).
- Migrator: every credential.

Separation rules:

- No process except the migrator holds the Party request credential together with any other credential.
- Only Shell and the migrator hold the issuer credential.
- `scripts/tests/zerops-deployment-contract.test.mts` enforces this on `zerops.yaml`. It also checks that each `${migrator_*_DB_PASSWORD}` reference appears only in the migrator and the owning services, and that no project-level variable carries a database credential.
- Local development keeps every key in one `app/.env`, so locally this is not a boundary.

Unchanged:

- The Commerce portal-auth realm.
- The SpiceDB login. It uses its own database `spicedb` (VERIFIED in `scripts/postgres/bootstrap-spicedb-database.mts`), so the per-database `TEMPORARY` revoke cannot affect it.
- The pricing NOLOGIN routine-owner roles. None of their routines reference `core` (VERIFIED).

## Grant manifest

Each fact is declared in exactly one place:

- `app/packages/core-runtime/src/db/database-identities.ts` holds the identities, role names, URL keys, Cloudflare bindings, scope authority, audiences, issuer flag, owner module and the grant types.
- `app/verticals/party-registry/src/db/database-grants.ts` holds `PARTY_REGISTRY_REQUEST_DATABASE_GRANTS` and `PARTY_REGISTRY_WORKER_DATABASE_GRANTS`. The process owner declares the Core subset it uses, every entry names the statement that needs it, and Core owners review it.
- `app/scripts/postgres/database-role-manifest.mts` holds `DATABASE_ROLE_GRANT_MANIFEST`. It composes the Party grants, the issuer grants (CONNECT, USAGE on `trust`, EXECUTE on the register routine), the legacy shared entry and `TRUST_ROUTINES`.

A `DatabaseTableGrant` may restrict a privilege to named columns. That privilege is then granted on exactly those columns.

Consumers:

- `scripts/postgres/bootstrap-runtime-role.mts` grants the manifest, fails on any privilege outside it, and fails on any membership, owned object, `CREATE`, unexpected `TEMPORARY` or unexpected role setting.
- The Party verifiers compare the catalog with the manifest.
- `packages/core-runtime/scripts/verify-db-schema.mts` checks the Core policies and the hardening of `trust`.
- The audit (report schema version 2) checks every identity against the manifest.
- `scripts/tests/database-role-manifest.test.mts` checks that the manifest is consistent with itself.

### `party_registry_runtime`

| Object                                                                                                | Privileges                                                                                                                                                   | Row-level security that applies                                                                                                                                           | Used by                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 18 `party.*` tables                                                                                   | S I U D                                                                                                                                                      | Gateway-grant tenant; also sealed entity-or-global on `counterparties`, `counterparty_role_periods`, `privacy_measure_executions` and both Counterparty admin projections | Owner services                                                                      |
| `contacts.organization_engagement_profiles`, `contacts.person_engagement_profiles`                    | S I U D                                                                                                                                                      | Gateway-grant tenant                                                                                                                                                      | Engagement services                                                                 |
| `contacts.gateway_assertion_redemptions`                                                              | S I D                                                                                                                                                        | None (not tenant data)                                                                                                                                                    | jti redemption runtime                                                              |
| `core.tenants`                                                                                        | SELECT (`tenant_id`, `status`); UPDATE (`tenant_id`)                                                                                                         | Select: `true`. Update: lock-only (`WITH CHECK (false)`), and only the row of the trusted tenant                                                                          | Scope resolver; `FOR UPDATE` in `module-state-gate.recheckWrite` and `flushSuccess` |
| `core.legal_entities`                                                                                 | SELECT (`legal_entity_id`, `tenant_id`, `status`)                                                                                                            | Trusted tenant                                                                                                                                                            | Scope resolver                                                                      |
| `core.principals`                                                                                     | SELECT (`principal_id`, `tenant_id`, `status`)                                                                                                               | Trusted tenant                                                                                                                                                            | Scope resolver                                                                      |
| `core.principal_auth_bindings`                                                                        | SELECT (`principal_auth_binding_id`, `tenant_id`, `principal_id`, `authentication_namespace_id`, `subject_type`, `status`, `binding_revision`, `revoked_at`) | Trusted tenant                                                                                                                                                            | Scope resolver                                                                      |
| `core.tenant_module_states`                                                                           | SELECT                                                                                                                                                       | `true`                                                                                                                                                                    | Module-state gate                                                                   |
| `core.application_composition_authority`                                                              | SELECT                                                                                                                                                       | `true` (existing policy, widened)                                                                                                                                         | Composition lock                                                                    |
| `core.action_invocations`                                                                             | S I U                                                                                                                                                        | Trusted tenant, entity-or-global, and `starts_with(action_key, 'party.registry.')`                                                                                        | Invocation lifecycle and `FOR UPDATE`                                               |
| `core.audit_events`                                                                                   | SELECT (`action_invocation_id`, `event_type`, `outcome_code`, `outcome_stage`); INSERT                                                                       | Trusted tenant, entity-or-global; row belongs to a visible `party.registry.` invocation                                                                                   | Rejection lookup; audit evidence                                                    |
| `core.data_access_events`                                                                             | INSERT                                                                                                                                                       | Trusted tenant, entity-or-global, and `serving_module_key = 'party.registry'`                                                                                             | Read and Action evidence                                                            |
| `core.domain_events`, `core.outbox_messages`                                                          | INSERT                                                                                                                                                       | Trusted tenant and `producer_module_key = 'party.registry'`; domain events also entity-or-global                                                                          | `flushSuccess`                                                                      |
| `core.search_index_entries`                                                                           | SELECT                                                                                                                                                       | Trusted tenant, entity-or-global, and `source_module_key = 'party.registry'`                                                                                              | Party Search                                                                        |
| sequence `core.domain_event_tenant_sequence_no_seq`                                                   | USAGE                                                                                                                                                        |                                                                                                                                                                           | `nextval` default                                                                   |
| `trust.establish_gateway_scope(text)`, `trust.current_tenant_id()`, `trust.current_legal_entity_id()` | EXECUTE                                                                                                                                                      |                                                                                                                                                                           | Entry point and accessors                                                           |
| schemas `party`, `contacts`, `core`, `trust`                                                          | USAGE                                                                                                                                                        |                                                                                                                                                                           | `public` comes from PUBLIC                                                          |
| database                                                                                              | CONNECT only                                                                                                                                                 |                                                                                                                                                                           | No `CREATE`, no `TEMPORARY`                                                         |

The column lists are a starting point, derived from `operations/context.ts`, `actions/repository.ts` and `modules/module-state-gate.ts`. The Party lane narrows or extends them, and each change names the statement behind it.

### `party_registry_worker`

| Object                                                                                                                                                                                                | Privileges                                        | Row-level security                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `party.parties`, `party_aliases`, `party_contact_points`, `party_official_identifiers`, `counterparties`, `counterparty_role_periods` (VERIFIED reads in `party-search-projection-source.service.ts`) | SELECT                                            | `<prefix>_worker_select`, with the `ontos.*` session predicate |
| `core.outbox_messages`                                                                                                                                                                                | SELECT; UPDATE (`matched_at`)                     | Select `true`; update `true` (column-limited)                  |
| `core.outbox_deliveries`, `core.outbox_attempts`, `core.worker_checkpoints`                                                                                                                           | S I U                                             | None (global outbox authority, as `ontos_runtime` has today)   |
| `core.search_index_entries`, `core.search_projection_generations`, `core.search_projection_rebuilds`                                                                                                  | S I U                                             | Session predicate and `source_module_key = 'party.registry'`   |
| `core.domain_events`                                                                                                                                                                                  | SELECT; UPDATE (`domain_event_id`)                | Select `true`; update lock-only                                |
| `core.tenant_module_states`                                                                                                                                                                           | SELECT; UPDATE (`tenant_module_state_id`)         | Select `true`; update lock-only                                |
| `core.tenants`                                                                                                                                                                                        | SELECT (`tenant_id`); UPDATE (`tenant_id`)        | Select `true`; update lock-only                                |
| `core.legal_entities`                                                                                                                                                                                 | SELECT (`legal_entity_id`, `tenant_id`, `status`) | None                                                           |
| `core.action_invocations`                                                                                                                                                                             | SELECT                                            | `true`                                                         |
| `core.application_composition_authority`                                                                                                                                                              | SELECT                                            | `true`                                                         |
| schemas `party`, `core`                                                                                                                                                                               | USAGE                                             |                                                                |

Why lock-only privileges exist: PostgreSQL requires UPDATE privilege on every table that `SELECT ... FOR UPDATE` locks (VERIFIED lock sites: `outbox/repository.ts` claim joins `outbox_deliveries`, `outbox_messages`, `domain_events` and `tenant_module_states` without `OF`; `complete` locks `core.tenants`). A row passes `FOR UPDATE` when it satisfies the UPDATE policy's `USING`. `WITH CHECK (false)` makes every real `UPDATE` fail with 42501.

### `shell_gateway_issuer`

It has CONNECT, USAGE on `trust`, and EXECUTE on `trust.register_gateway_scope_grant(text,text,uuid,uuid,uuid,uuid,timestamptz)`. Nothing else.

### `ontos_runtime`

`ontos_runtime` keeps the legacy blanket bootstrap on `core`, `auth`, `catalog`, `inventory`, `tax`, `privacy` and `projects`, plus every owner-migration grant. Changes:

- It loses every privilege and default privilege on `party` and `contacts`.
- It gets no access to `trust`.
- Its Core Search policies exclude `source_module_key = 'party.registry'`.
- `TEMPORARY` is revoked from PUBLIC on the application database and granted back to `ontos_runtime` only.
- The new Core RLS gives it one `FOR ALL ... USING (true) WITH CHECK (true)` policy per table, so its behaviour does not change.

## Trusted tenant context

### Lifecycle

```text
Browser / API-key caller
  -> Shell POST /shell-super-app-api/auth/gateway-context{,/api-key}
       GatewayIssuer.issue: sign the Ed25519 JWT (claims unchanged, TTL 300 s)
       GatewayScopeGrantRegistrar.register  (no-op unless the audience maps to a gateway_grant role)
         -> shell_gateway_issuer, autocommit:
            select trust.register_gateway_scope_grant(token, aud, jti, principal, tenant, legalEntity, to_timestamp(exp))
  -> Party Registry BFF (party_registry_runtime)
       verifyAndRedeem: EdDSA + claims + composition binding + jti redemption
       trustVerifiedGatewayPrincipalContext(principal, revision, { audience, assertion: Redacted })
       OperationalScopeResolver -> preserveSystemPrincipalContextTrust (carries the assertion)
       installOperationalScope(tx, scope)      [Action main tx | Read nested savepoint | Core Search query tx]
         select ... from trust.establish_gateway_scope($assertion)
             definer: digest lookup; audience -> SESSION_USER; clock_timestamp() < stored expiry (≤ 300 s) + 30 s
             seal = 'v2|<top-level xid8>|<deadline µs>|<session_user>|<tenant>|<legal entity or ->'
                    || '|' || hmac(seal)
             set_config('ontos_trust.scope', seal, true)
         select trust.current_tenant_id(), trust.current_legal_entity_id()   -- must equal the scope
       owner services -> party / contacts / Core tables
         RLS: tenant_id = (select trust.current_tenant_id()) [and legal_entity_id = (select trust.current_legal_entity_id())]
  -> COMMIT / ROLLBACK: the setting disappears. A copied seal fails the xid8 binding;
     a seal past its deadline fails the clock check.
```

### SQL objects

These objects come from the Core custom migration `packages/core-runtime/drizzle/20261020062648_trusted-gateway-scope/migration.sql`, whose owner is the migration admin. Every routine:

- sets `search_path = pg_catalog, pg_temp`;
- uses static SQL only;
- schema-qualifies every reference;
- has EXECUTE revoked from PUBLIC (only the bootstrap grants it, from the manifest).

The accessors are `PARALLEL RESTRICTED`.

```sql
CREATE SCHEMA trust;
REVOKE ALL ON SCHEMA trust FROM PUBLIC;

CREATE TABLE trust.scope_sealing_keys (
  key_id smallint PRIMARY KEY CHECK (key_id = 1),
  inner_pad bytea NOT NULL CHECK (pg_catalog.length(inner_pad) = 64),
  outer_pad bytea NOT NULL CHECK (pg_catalog.length(outer_pad) = 64),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);
REVOKE ALL ON TABLE trust.scope_sealing_keys FROM PUBLIC;

-- 256-bit key from pg_strong_random (three gen_random_uuid values), stored only as HMAC ipad/opad blocks.
DO $$
DECLARE
  v_key bytea := pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, 'UTF8'));
  v_block bytea := v_key || pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex');
  v_inner bytea := v_block;
  v_outer bytea := v_block;
BEGIN
  FOR i IN 0..63 LOOP
    v_inner := pg_catalog.set_byte(v_inner, i, pg_catalog.get_byte(v_block, i) # 54);
    v_outer := pg_catalog.set_byte(v_outer, i, pg_catalog.get_byte(v_block, i) # 92);
  END LOOP;
  INSERT INTO trust.scope_sealing_keys (key_id, inner_pad, outer_pad) VALUES (1, v_inner, v_outer);
END
$$;

CREATE TABLE trust.gateway_audience_roles (
  audience text PRIMARY KEY CHECK (audience ~ '^[a-z][a-z0-9]*([.-][a-z0-9]+)*$'),
  role_name name NOT NULL UNIQUE
);
REVOKE ALL ON TABLE trust.gateway_audience_roles FROM PUBLIC;

CREATE TABLE trust.gateway_scope_grants (
  assertion_digest bytea PRIMARY KEY CHECK (pg_catalog.length(assertion_digest) = 32),
  audience text NOT NULL,
  jti uuid NOT NULL,
  principal_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid,
  expires_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL,
  registered_by name NOT NULL,
  CONSTRAINT gateway_scope_grants_audience_jti_uk UNIQUE (audience, jti),
  CONSTRAINT gateway_scope_grants_lifetime_ck
    CHECK (expires_at > registered_at AND expires_at <= registered_at + interval '300 seconds')
);
CREATE INDEX gateway_scope_grants_expires_at_idx ON trust.gateway_scope_grants (expires_at);
REVOKE ALL ON TABLE trust.gateway_scope_grants FROM PUBLIC;

-- Internal: SECURITY INVOKER; reachable only through the definer routines below.
CREATE FUNCTION trust.scope_mac(p_payload text) RETURNS text
  LANGUAGE sql STABLE PARALLEL RESTRICTED SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(k.outer_pad || pg_catalog.sha256(k.inner_pad || pg_catalog.convert_to(p_payload, 'UTF8'))), 'hex')
  FROM trust.scope_sealing_keys AS k WHERE k.key_id = 1
$$;
REVOKE ALL ON FUNCTION trust.scope_mac(text) FROM PUBLIC;

CREATE FUNCTION trust.scope_payload(p_xid xid8, p_deadline timestamptz, p_tenant_id uuid, p_legal_entity_id uuid) RETURNS text
  LANGUAGE sql STABLE PARALLEL RESTRICTED SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.concat_ws('|', 'v2',
    p_xid::text,
    ((EXTRACT(EPOCH FROM p_deadline) * 1000000)::bigint)::text,
    SESSION_USER::text,
    p_tenant_id::text,
    COALESCE(p_legal_entity_id::text, '-'))
$$;
REVOKE ALL ON FUNCTION trust.scope_payload(xid8, timestamptz, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION trust.verified_scope(OUT tenant_id uuid, OUT legal_entity_id uuid)
  LANGUAGE plpgsql STABLE PARALLEL RESTRICTED SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sealed text := pg_catalog.current_setting('ontos_trust.scope', true);
  v_parts text[];
BEGIN
  IF v_sealed IS NULL OR v_sealed = '' THEN
    RETURN;
  END IF;
  v_parts := pg_catalog.regexp_match(v_sealed,
    '^(v2\|([0-9]{1,20})\|([0-9]{1,20})\|([a-z_][a-z0-9_]{0,62})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-))\|([0-9a-f]{64})$');
  IF v_parts IS NULL
     OR v_parts[2] IS DISTINCT FROM pg_catalog.pg_current_xact_id_if_assigned()::text
     OR v_parts[3]::bigint <= (EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()) * 1000000)::bigint
     OR v_parts[4] IS DISTINCT FROM SESSION_USER::text
     OR pg_catalog.sha256(pg_catalog.convert_to(v_parts[7], 'UTF8'))
        IS DISTINCT FROM pg_catalog.sha256(pg_catalog.convert_to(trust.scope_mac(v_parts[1]), 'UTF8')) THEN
    RAISE EXCEPTION 'trusted scope seal rejected' USING ERRCODE = '42501';
  END IF;
  tenant_id := v_parts[5]::uuid;
  legal_entity_id := NULLIF(v_parts[6], '-')::uuid;
END
$$;
REVOKE ALL ON FUNCTION trust.verified_scope() FROM PUBLIC;

CREATE FUNCTION trust.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER PARALLEL RESTRICTED SET search_path = pg_catalog, pg_temp
AS $$ SELECT s.tenant_id FROM trust.verified_scope() AS s $$;
REVOKE ALL ON FUNCTION trust.current_tenant_id() FROM PUBLIC;

CREATE FUNCTION trust.current_legal_entity_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER PARALLEL RESTRICTED SET search_path = pg_catalog, pg_temp
AS $$ SELECT s.legal_entity_id FROM trust.verified_scope() AS s $$;
REVOKE ALL ON FUNCTION trust.current_legal_entity_id() FROM PUBLIC;

CREATE FUNCTION trust.establish_gateway_scope(p_assertion text)
  RETURNS TABLE (established_tenant_id uuid, established_legal_entity_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant_id uuid;
  v_legal_entity_id uuid;
  v_deadline timestamptz;
  v_payload text;
BEGIN
  IF p_assertion IS NULL OR pg_catalog.length(p_assertion) > 8192 THEN
    RAISE EXCEPTION 'gateway scope grant is not usable' USING ERRCODE = '42501';
  END IF;
  SELECT g.tenant_id, g.legal_entity_id, g.expires_at + interval '30 seconds'
    INTO v_tenant_id, v_legal_entity_id, v_deadline
    FROM trust.gateway_scope_grants AS g
    JOIN trust.gateway_audience_roles AS a ON a.audience = g.audience
   WHERE g.assertion_digest = pg_catalog.sha256(pg_catalog.convert_to(p_assertion, 'UTF8'))
     AND a.role_name = SESSION_USER
     AND g.expires_at + interval '30 seconds' > pg_catalog.clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway scope grant is not usable' USING ERRCODE = '42501';
  END IF;
  v_payload := trust.scope_payload(pg_catalog.pg_current_xact_id(), v_deadline, v_tenant_id, v_legal_entity_id);
  PERFORM pg_catalog.set_config('ontos_trust.scope', v_payload || '|' || trust.scope_mac(v_payload), true);
  established_tenant_id := v_tenant_id;
  established_legal_entity_id := v_legal_entity_id;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION trust.establish_gateway_scope(text) FROM PUBLIC;

```

`trust.register_gateway_scope_grant(p_assertion text, p_audience text, p_jti uuid, p_principal_id uuid, p_tenant_id uuid, p_legal_entity_id uuid, p_expires_at timestamptz) RETURNS void` is a `SECURITY DEFINER` routine with EXECUTE revoked from PUBLIC. Its body lives only in the migration above. It rejects the call with SQLSTATE `22023` unless:

- the assertion is a compact JWS of at most 8192 characters and every required argument is present;
- `p_expires_at` is in the future and at most 330 seconds ahead;
- `p_audience` is enrolled in `trust.gateway_audience_roles`;
- the decoded assertion payload matches the arguments: `aud` equals `p_audience`, `jti` equals `p_jti`, `sub` and `principal.principalId` equal `p_principal_id`, `principal.tenantId` equals `p_tenant_id`, `principal.legalEntityId` equals `p_legal_entity_id` (absent when the argument is null), and `exp` equals the epoch of `p_expires_at`;
- `p_principal_id` is an active principal of `p_tenant_id` in `core.principals`;
- `p_legal_entity_id`, when given, belongs to `p_tenant_id` in `core.legal_entities`.

It then deletes up to 500 grants that expired more than 60 seconds ago and inserts the assertion's SHA-256 digest with `expires_at = LEAST(p_expires_at, now + 300 seconds)`. The table check `expires_at <= registered_at + 300 seconds` enforces the same cap.

The bootstrap applies these grants on every pass, after revoking every `trust` routine and table from PUBLIC and from all four runtime roles:

```sql
GRANT USAGE ON SCHEMA trust TO shell_gateway_issuer, party_registry_runtime;
GRANT EXECUTE ON FUNCTION trust.register_gateway_scope_grant(text, text, uuid, uuid, uuid, uuid, timestamptz) TO shell_gateway_issuer;
GRANT EXECUTE ON FUNCTION trust.establish_gateway_scope(text), trust.current_tenant_id(), trust.current_legal_entity_id() TO party_registry_runtime;
INSERT INTO trust.gateway_audience_roles (audience, role_name) VALUES ('party-registry', 'party_registry_runtime')
  ON CONFLICT (audience) DO UPDATE SET role_name = EXCLUDED.role_name;
DELETE FROM trust.gateway_audience_roles WHERE audience <> ALL ($1::text[]);   -- $1: gateway_grant audiences from the manifest
ALTER ROLE shell_gateway_issuer SET log_parameter_max_length = 0;
ALTER ROLE shell_gateway_issuer SET log_parameter_max_length_on_error = 0;
ALTER ROLE party_registry_runtime SET log_parameter_max_length = 0;
ALTER ROLE party_registry_runtime SET log_parameter_max_length_on_error = 0;
```

### RLS predicates

`party` and `contacts`, for `party_registry_runtime`. These are generated by `gatewayScopedTenantRlsPolicies` and `gatewayScopedTenantLegalEntityRlsPolicies`. The existing policy names are kept, so Drizzle emits `ALTER POLICY ... TO "party_registry_runtime"`. `FORCE ROW LEVEL SECURITY` stays on.

```sql
-- 15 tenant-only tables (13 party + 2 contacts)
tenant_id = (select trust.current_tenant_id())
-- counterparties, counterparty_role_periods, privacy_measure_executions,
-- counterparty_admin_read_models; also Core invocation/evidence/Search rows
-- in addition to their module predicates:
tenant_id = (select trust.current_tenant_id())
and ((select trust.current_legal_entity_id()) is null
     or legal_entity_id is null
     or legal_entity_id = (select trust.current_legal_entity_id()))
-- counterparty_role_admin_read_models has no legal_entity_id; its policy
-- requires a tenant-qualified parent in counterparty_admin_read_models,
-- whose SELECT policy enforces the same sealed entity boundary.
```

A grant sealed to L1 may access L1 and tenant-global (NULL legal entity) rows, never L2.
A grant sealed without a legal entity is tenant-wide and may access all entities of that tenant.
No grant still means no tenant and no visible rows. These rules govern both `USING` and
`WITH CHECK`, so updates cannot move a visible row outside the seal.

**Admin-projection decision (review confirmed[0]).** The dissent correctly notes that these
projections were intentionally tenant-only before the pilot and support tenant-wide administration.
That is not authority for a request sealed to one legal entity: a copied counterparty or role history
must not bypass its source row's boundary. Both projections now enforce the seal; an explicitly
tenant-wide grant retains the administrative behavior. The role projection uses its constrained,
RLS-protected parent rather than a duplicated, independently writable legal-entity column.

On the six worker tables, `party_registry_worker` additionally gets one `<prefix>_worker_select` (`FOR SELECT`) policy with the legacy predicate `tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid` (plus the legal-entity version on the two counterparty tables). No policy on `party` or `contacts` names `ontos_runtime`.

Core (`packages/core-runtime/src/db/schema.ts`). RLS is enabled but not forced. The owner, which is the migration admin, is exempt, and referential-integrity checks bypass RLS. Each newly RLS-enabled table gets `core_<table>_shared_runtime_all` (`FOR ALL TO ontos_runtime USING (true) WITH CHECK (true)`). In the table, `T` means `(select trust.current_tenant_id())`; `E` means the entity-or-global predicate above (including tenant equality).

| Table                                                                  | Party request (`party_registry_runtime`)                                                                                                                                                   | Party worker (`party_registry_worker`)                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `tenants` (new RLS)                                                    | select `true`; update `USING (tenant_id = T) WITH CHECK (false)`                                                                                                                           | select `true`; update `USING (true) WITH CHECK (false)`                                                       |
| `tenant_module_states` (new RLS)                                       | select `true`                                                                                                                                                                              | select `true`; update `USING (true) WITH CHECK (false)`                                                       |
| `legal_entities`, `principals`, `principal_auth_bindings`              | select `tenant_id = T` (column-limited identity metadata)                                                                                                                                  | legal entities select `true`; no principal/binding access                                                     |
| `action_invocations` (new RLS)                                         | select / insert / update `E and starts_with(action_key, 'party.registry.')`                                                                                                                | select `true`                                                                                                 |
| `audit_events` (new RLS)                                               | select / insert `E and exists (select 1 from core.action_invocations i where i.action_invocation_id = audit_events.action_invocation_id and starts_with(i.action_key, 'party.registry.'))` | none                                                                                                          |
| `data_access_events` (new RLS)                                         | insert `E and serving_module_key = 'party.registry'`                                                                                                                                       | none                                                                                                          |
| `domain_events` (new RLS)                                              | insert `E and producer_module_key = 'party.registry'`                                                                                                                                      | select `true`; update `USING (true) WITH CHECK (false)`                                                       |
| `outbox_messages` (new RLS)                                            | insert `tenant_id = T and producer_module_key = 'party.registry'`                                                                                                                          | select `true`; update `USING (true) WITH CHECK (true)` (column grant `matched_at` only)                       |
| `search_index_entries` (forced)                                        | select: `E and source_module_key = 'party.registry'`                                                                                                                                       | select / insert / update: the existing `ontos_runtime` predicates plus `source_module_key = 'party.registry'` |
| `search_projection_generations`, `search_projection_rebuilds` (forced) | none                                                                                                                                                                                       | select / insert / update: the existing predicates plus `source_module_key = 'party.registry'`                 |
| `application_composition_authority`                                    | the existing select policy is widened to `ontos_runtime`, `party_registry_runtime` and `party_registry_worker`                                                                             | (same policy)                                                                                                 |

Every existing `ontos_runtime` Search policy gains `and source_module_key <> 'party.registry'`. Module keys come from `DatabaseIdentity.ownerModuleKey` and are rendered as checked literals.

### Core installer

`installOperationalScope(transaction, scope)` (`packages/core-runtime/src/db/scoped-transaction.ts`) keeps its signature, and `OperationalScopeTransactionService` keeps its shape. The transaction service is built per transaction with the authority chosen from the scope:

- **`gateway_grant`**: `readVerifiedGatewayScopeAssertion(scope)` returns an assertion whose audience maps to a role through `gatewayScopeGrantRoleForAudience`. `install` runs `select established_tenant_id::text as tenant_id, coalesce(established_legal_entity_id::text, '') as legal_entity_id from trust.establish_gateway_scope($1)`. `verify` runs `select coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id`. No `ontos.*` setting is written.
- **`session_setting`**: everything else. This is the existing `set_config` / `current_setting` pair.

The existing comparison against `scope.tenantId` and `scope.legalEntityId ?? ''` turns any mismatch or SQL failure into `OperationContextUnavailable`. A Party scope without an assertion writes only legacy settings, and Party policies ignore those, so it fails closed.

Callers:

- The Action main transaction (`actions/runtime.ts`) and the Read nested savepoint (`reads/runtime.ts`). A released savepoint keeps the transaction-local seal, and `pg_current_xact_id()` returns the top-level ID inside savepoints (VERIFIED).
- The Core Search query transaction. `CoreSearchQueryRuntime.search(input, scope)` passes the Read factory's `OperationalScope` to `queryCandidates`, which installs it instead of calling `set_config`.
- Invocation creation and Action denial persistence use `invocationScopeExecutor`, which installs
  the unchanged operational scope before repository access. Read denials use `persistScopedReadEvidence`.

Search uses the same authority rule before installing the original scope: tenant IDs must match;
when both the query and the seal select a legal entity, those IDs must match. A tenant-wide seal may
select any entity, and a query without a selected entity remains valid under an L1 seal. That last
query still selects only `legal_entity_id IS NULL` documents; it does not widen to L1/L2 documents.
The PostgreSQL and in-memory candidate stores apply the same guard and document-selection filter.

The Worker-side `apply`/`replace` paths keep the session setting. The verifier attaches `{ audience, assertion: Redacted }` only after redemption succeeds, inside the non-enumerable provenance closure.

### Properties

| Required property                                            | How it holds                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not derivable from settings or from state the role can write | Policies for the role read only `trust.current_*`. These accept only a seal whose HMAC verifies under a key that no runtime role can read. `ontos.*` is ignored. The role has no DML on `trust.*`.                                                                                            |
| Requires an issuer-backed artifact the role cannot mint      | `establish` needs the preimage of a digest registered through `register_gateway_scope_grant`. Only `shell_gateway_issuer` can execute that routine, and only Shell holds that login. No definer routine accepts tenant or legal-entity IDs chosen by the caller.                              |
| Transaction-scoped; nothing retained on pooled connections   | `set_config(..., true)`, bound to the top-level `xid8`. A seal copied into a later transaction, including one sent in the same simple-query message, into another backend or into a session-level `SET` has a different or unassigned xid, so it is rejected with 42501.                      |
| Time-bounded                                                 | The deadline (stored grant expiry, capped at 300 s after registration, + 30 s) is inside the HMAC and is compared with `clock_timestamp()` on every accessor call. `establish` also uses `clock_timestamp()`. Long transactions and stale `statement_timestamp()` values cannot extend scope. |
| Audience-bound to the calling role                           | `establish` joins `trust.gateway_audience_roles` on `role_name = SESSION_USER`. The role has no memberships, and `SET ROLE` and `SET SESSION AUTHORIZATION` are refused.                                                                                                                      |
| Built-in features only                                       | `sha256`, `gen_random_uuid`, `pg_current_xact_id`, `clock_timestamp`, `set_config`, `regexp_match`, plpgsql. Everything is available in PostgreSQL 18.6, and no Ed25519 extension exists or is needed.                                                                                        |

## Non-request paths

- **Party Outbox worker.** Excluded from the trusted path. It holds no issuer artifact, because scope comes from the claimed `core.outbox_messages` row, and it handles every tenant by design. Scope from claim rows in the database would only be sound once no runtime role can write `core.outbox_*` or `core.domain_events` directly; that is a follow-up. The split still removes from the worker all Contacts access, all Party writes, `trust`, `auth` and every other vertical schema.
- **System principals.** Party Registry has none (VERIFIED). A system or support-recovery context has no assertion, so on Party tables it fails closed.
- **Callers from other verticals.** The Privacy-measure worker and Commerce enrollment use Shell API-key issuance, and Catalog uses the browser operation gateway. Both go through `GatewayIssuer.issue`, so a grant is registered for each.
- **Admin, seed, verify and audit scripts.** They connect as the migration admin. That role owns the tables, so it is exempt from non-forced RLS and is a superuser.
- **`PrincipalEligibility`** still switches `ontos.*`. Party does not use it (VERIFIED), and it is not on the pilot path.

## Threat model and acceptance criteria

| #174 criterion                                                                   | Pilot mechanism                                                                                                                                                                                  | Evidence                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| #370 documents grants, identities and gaps                                       | This record, plus the audit report per identity                                                                                                                                                  | `pnpm database-trust:audit` (schema version 2), run in CI                                                                            |
| Separate runtime, worker and migration authority where justified                 | Four runtime logins plus admin (D5)                                                                                                                                                              | Bootstrap assertions; the audit findings `runtime_identities_share_role` and `runtime_identity_can_assume_other_identity` are absent |
| Request-serving identities lack unrelated schemas and DDL                        | `party_registry_runtime` has USAGE only on `party`, `contacts`, `core`, `trust` and `public`. It has no `CREATE`, no `TEMPORARY` and owns nothing. `ontos_runtime` loses `party` and `contacts`. | `database-role-boundary.test.ts`; audit findings `runtime_role_privilege_outside_manifest` and `runtime_role_has_ddl_authority`      |
| Runtime roles cannot bypass RLS or set trusted context outside the approved path | NOBYPASSRLS everywhere; `row_security = off` raises an error. Trusted scope only comes from `establish` with an issuer-registered artifact, and Party policies read only the trusted scope.      | `scripts/integration/trusted-gateway-scope.test.mts`, `database-role-boundary.test.ts`                                               |
| Negative tests                                                                   | See the matrix                                                                                                                                                                                   | Files in the matrix                                                                                                                  |
| Rotation, rollback, deployment and local-dev costs recorded                      | [Operations](#operations)                                                                                                                                                                        | This record                                                                                                                          |

| Threat                                                                                                                                                                             | Before                         | After                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A compromised Party BFF forges `ontos.*` to reach another tenant's Party/Contacts rows                                                                                             | Possible                       | Blocked on all 20 tables and on Party Search rows                                                           |
| Forges, copies or replays a seal (including several transactions in one message, or a long transaction)                                                                            | n/a                            | Blocked: the key is unreadable; the seal is bound to the xid, the role and the sealed deadline              |
| Mints a grant                                                                                                                                                                      | n/a                            | Blocked: no EXECUTE on the register routine and no DML on `trust`                                           |
| A compromised non-Party vertical mints Party scope                                                                                                                                 | n/a                            | Blocked at the database: no EXECUTE on register, no Party password (service-scoped secret)                  |
| A compromised Party BFF writes events for another tenant or producer, which other verticals then consume                                                                           | Possible                       | Blocked: `domain_events` and `outbox_messages` inserts are bound to the trusted tenant and `party.registry` |
| A compromised Party BFF changes another vertical's `action_invocations` or audit/data-access evidence                                                                              | Possible                       | Blocked: module-bound RLS                                                                                   |
| A compromised Party BFF reads other tenants' events, payloads, display names or Search rows                                                                                        | Possible                       | Blocked: no SELECT on events/outbox/data-access; column-limited identity reads; trusted Search              |
| A compromised Party BFF reads or changes Party's own invocation rows, or Party audit/data-access evidence, of another tenant                                                       | Possible                       | Blocked: trusted tenant and legal-entity RLS (fabrication within that authority remains, limit 3)           |
| A compromised Party BFF runs DDL, uses another schema, or mutates a sequence or role                                                                                               | Possible (USAGE on 17 schemas) | Denied with 42501                                                                                           |
| Shell or another vertical reads Party data                                                                                                                                         | Possible                       | Denied (privileges, default privileges and Search rows removed)                                             |
| A compromised worker reads Party data across tenants                                                                                                                               | Possible                       | Still possible: read-only on 6 tables, and only Party Search rows (limit 5)                                 |
| A compromised `ontos_runtime` process forges identity-store rows (`auth.*`, `core.principals`/`principal_auth_bindings`) and obtains genuine Party assertions from Shell over HTTP | Possible                       | Still possible (limit 2)                                                                                    |

## Negative test matrix

Every case runs against real PostgreSQL in CI (job `service-integration`, `pnpm test:integration`).

| Area                     | Case                                                                                                                                                                                                                                                                        | Expected                                                                                  | File                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Cross-tenant             | Scope for tenant A; select/update/delete tenant B rows in `party.parties` and the two `contacts` profile tables                                                                                                                                                             | 0 rows                                                                                    | `verticals/party-registry/tests/integration/database-role-boundary.test.ts`    |
| Cross-tenant             | Insert a tenant B row under tenant A scope                                                                                                                                                                                                                                  | 42501                                                                                     | same                                                                           |
| Cross-legal-entity       | Legal entity 1 scope against legal entity 2 rows in `party.counterparties`                                                                                                                                                                                                  | 0 rows; insert fails with 42501                                                           | same                                                                           |
| No scope                 | Select or insert without `establish`                                                                                                                                                                                                                                        | 0 rows / 42501                                                                            | same                                                                           |
| Core cross-tenant writes | Insert into `core.domain_events` or `core.outbox_messages` for tenant B, or with producer `privacy.core`; update another module's `core.action_invocations`; insert `core.data_access_events` with another `serving_module_key`                                             | 42501, or 0 rows for the update                                                           | same                                                                           |
| Core cross-tenant reads  | Select from `core.domain_events`, `core.outbox_messages`, `core.data_access_events`, `core.principals.display_name`, `core.legal_entities.legal_name`, `core.audit_events.evidence_json`                                                                                    | 42501                                                                                     | same                                                                           |
| Search                   | `set_config('ontos.tenant_id', B)` then a select on `core.search_index_entries`; scope A against B's `party.registry` rows                                                                                                                                                  | 0 rows                                                                                    | same                                                                           |
| Legacy spoof             | `set_config('ontos.tenant_id', B, true)` and `SET LOCAL ontos.tenant_id`                                                                                                                                                                                                    | Party rows stay invisible; accessor returns NULL                                          | same and `scripts/integration/trusted-gateway-scope.test.mts`                  |
| RLS bypass               | `SET row_security = off`, then read a Party table                                                                                                                                                                                                                           | 42501                                                                                     | Party boundary test                                                            |
| DDL                      | `CREATE TABLE party.x`, `CREATE TABLE public.x`, `CREATE SCHEMA`, `CREATE TEMP TABLE`, `ALTER TABLE party.parties ADD COLUMN`, `DROP TABLE`, `TRUNCATE`, `CREATE FUNCTION`, `CREATE INDEX`                                                                                  | 42501                                                                                     | same                                                                           |
| Unrelated schemas        | Select from `pricing.*`, `catalog.*`, `auth.session`, `core.media_assets`, `core.outbox_deliveries`; insert into `core.tenants` or `core.principals`                                                                                                                        | 42501                                                                                     | same                                                                           |
| Lock-only                | Request role: `UPDATE core.tenants SET tenant_id = tenant_id` in scope. Worker: the same on `core.tenants`, `core.domain_events`, `core.tenant_module_states`                                                                                                               | 42501 (WITH CHECK)                                                                        | same                                                                           |
| Sequences                | `setval` or `ALTER SEQUENCE core.domain_event_tenant_sequence_no_seq`                                                                                                                                                                                                       | 42501                                                                                     | same                                                                           |
| Role changes             | `SET ROLE` to `ontos_runtime`, the admin or the worker; `SET SESSION AUTHORIZATION`; `ALTER ROLE ... BYPASSRLS/SUPERUSER/CREATEROLE`; `ALTER ROLE ontos_runtime NOLOGIN`; `CREATE ROLE`; `GRANT party_registry_runtime TO ontos_runtime`                                    | 42501                                                                                     | same                                                                           |
| Grant propagation        | `GRANT SELECT ON party.parties TO ontos_runtime` run by the Party role                                                                                                                                                                                                      | Admin still sees `has_table_privilege` = false                                            | same                                                                           |
| Role settings            | The Party role runs `ALTER ROLE party_registry_runtime SET statement_timeout = '1ms'`; the bootstrap runs                                                                                                                                                                   | The setting is reset; the audit reports `runtime_role_has_role_settings` before the reset | same and `migrator-runtime-owner-access.test.mts`                              |
| Identity separation      | The worker inserts into Party, reads Contacts or calls `establish`; `ontos_runtime` reads Party/Contacts or calls `establish`/`register`; the issuer reads any table                                                                                                        | 42501                                                                                     | same                                                                           |
| Trusted-state writes     | DML on any `trust` table, or execution of the internal routines, by each of the four runtime roles                                                                                                                                                                          | 42501                                                                                     | `scripts/integration/trusted-gateway-scope.test.mts`                           |
| Issuer                   | `register` run by the Party role, the worker or `ontos_runtime`                                                                                                                                                                                                             | 42501                                                                                     | same                                                                           |
| Artifact                 | Unregistered or forged token, unmapped audience, expired grant at `establish` / a malformed token, `exp` more than 330 s ahead (300 s TTL + 30 s issuer clock skew; the stored expiry is capped at 300 s), unknown audience at registration / a duplicate `(audience, jti)` | 42501 / 22023 / 23505                                                                     | same                                                                           |
| Seal forgery             | `SET LOCAL ontos_trust.scope` to a well-formed seal with a wrong MAC                                                                                                                                                                                                        | 42501                                                                                     | same                                                                           |
| Copied seal              | A seal reused in the next transaction on the same connection; a seal from another backend; a session-level `SET`                                                                                                                                                            | 42501; a later `establish` overrides it                                                   | same                                                                           |
| Single-message replay    | One parameterless simple-query message: `BEGIN; establish; set_config(..., false) copy; COMMIT; BEGIN; accessor; COMMIT` (with and without `pg_current_xact_id()` in the second transaction)                                                                                | 42501                                                                                     | same                                                                           |
| Deadline                 | `establish` with a grant whose deadline is about 2 s away, then `pg_sleep(2.5)` and the accessor; `establish` after the deadline in the same message                                                                                                                        | 42501                                                                                     | same                                                                           |
| Retention                | After COMMIT and after ROLLBACK on the same connection: the setting and the accessor                                                                                                                                                                                        | `''` and NULL                                                                             | same                                                                           |
| Savepoint / read-only    | Release keeps the seal; rollback-to discards it; `establish` inside `BEGIN READ ONLY`                                                                                                                                                                                       | As stated                                                                                 | same                                                                           |
| HMAC                     | The admin recomputes `sha256(opad ‖ sha256(ipad ‖ payload))`                                                                                                                                                                                                                | Equals the sealed MAC                                                                     | same                                                                           |
| Hardening                | All 7 `trust` routines: `prosecdef`, `proconfig`, owner, no PUBLIC execute, exact grantees; no runtime grantee on any `trust` table                                                                                                                                         | As declared                                                                               | same, plus the Core verifier and the audit                                     |
| Runtime                  | A real Party Action, Read and Search, and a denied Action, through the production layers as `party_registry_runtime` with a registered grant; a worker match/claim/handle/complete cycle as `party_registry_worker`                                                         | Succeed; denial evidence is recorded                                                      | `verticals/party-registry/tests/integration/party-identity-runtime.test.ts`    |
| Installer                | Registered grant / no assertion / tenant mismatch                                                                                                                                                                                                                           | Scope installed / Party rows invisible / `OperationContextUnavailable`                    | `packages/core-runtime/tests/integration/gateway-scope-installation.test.ts`   |
| Issuance                 | `party-registry` assertions registered; a registrar failure means no token                                                                                                                                                                                                  | stage `scope_grant`                                                                       | `apps/shell-super-app/tests/unit/gateway-issuer.test.ts` and Shell integration |

## Operations

### Provisioning (stage; a human runs it, agents never do)

1. Run `node scripts/ops/cloudflare-stage-cutover.mts database-identities` from a host on the Zerops VPN, with `DATABASE_ADMIN_URL` set. It does two things:
   - It creates the missing sensitive service secrets on `migrator`: `PARTY_REGISTRY_DB_PASSWORD`, `PARTY_REGISTRY_WORKER_DB_PASSWORD` and `SHELL_GATEWAY_ISSUER_DB_PASSWORD`, each 48 random bytes in base64url, never printed.
   - It creates or alters the three login roles with `LOGIN` and `CONNECT` only, through `scripts/postgres/database-login-roles.mts`. This step must come first because Hyperdrive tests the connection when a config is created. The roles are inert until the bootstrap grants them anything.
2. Run `provision` (Hyperdrive step). It creates `ontos-stage-party-registry` (user `party_registry_runtime`, caching disabled, origin connection limit 10) and `ontos-stage-gateway-issuer` (user `shell_gateway_issuer`, caching disabled, limit 5). It reads the passwords through `readZeropsValue('migrator_<KEY>')` and writes both IDs into `topology/cloudflare-placement.json` `buildEnvironment` for a reviewed PR. `verify` checks drift on user, caching and limit.
3. Merge. `edge-deploy-readiness` requires both new IDs, and every deploy job waits on it, so nothing changes before provisioning is complete.

Each pass of the migrator bootstrap (before the owner migrations and after them, and three times in `pnpm db:migrate`):

- reads `DATABASE_ADMIN_URL` and the four runtime URLs, requiring every URL user to equal its manifest role and to target the admin's host, port and database;
- re-sets passwords;
- resets role settings and re-applies the manifest;
- syncs `trust.gateway_audience_roles`.

Zerops service environment:

- `party-registry`: `PARTY_REGISTRY_DATABASE_URL` from `${migrator_PARTY_REGISTRY_DB_PASSWORD}`, and no `DATABASE_URL`.
- `party-registry-worker`: `PARTY_REGISTRY_WORKER_DATABASE_URL` only.
- `outbox-worker-host`: `DATABASE_URL` and `PARTY_REGISTRY_WORKER_DATABASE_URL`.
- `shellsuperapp`: `DATABASE_URL` and `SHELL_GATEWAY_ISSUER_DATABASE_URL`.
- `migrator`: all of them.

`zerops.yaml` is shared with production. Production deploys nothing today (no `ZEROPS_PROJECT_ID`), and it must not deploy until the same migrator secrets exist there.

### Credential rotation

| Credential                                       | Steps                                                                                                                                                                                                                                                                  | Cost                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `party_registry_runtime`, `shell_gateway_issuer` | Follow the [Deployment rotation runbook](./DEPLOYMENT.md#database-identities): after PostgreSQL credentials are rotated, `node scripts/ops/cloudflare-stage-cutover.mts provision` PUTs the current password into existing Hyperdrive configs before service restarts. | New connections fail between database rotation and credential sync; existing pools can mask drift.                       |
| `party_registry_worker`                          | Follow the same runbook, skipping Hyperdrive credential sync (direct connection).                                                                                                                                                                                      | Window ends when every service using the credential restarts.                                                            |
| `ontos_runtime`                                  | Unchanged (`db18_password` and `ontos-stage-runtime`)                                                                                                                                                                                                                  | Unchanged                                                                                                                |
| Sealing key                                      | The admin updates `trust.scope_sealing_keys` with new pads, using the migration's generation block                                                                                                                                                                     | Seals in in-flight transactions stop verifying, and those requests fail and are retried. The key is in database backups. |
| Gateway Ed25519 key                              | Unchanged; grants are keyed by token digest                                                                                                                                                                                                                            | None                                                                                                                     |

### Observability

- SQLSTATE 42501 with `gateway scope grant is not usable` or `trusted scope seal rejected` marks a forgery, an expiry or a misconfiguration. 22023 marks an invalid registration. The application maps these to `OperationContextUnavailable` or Shell stage `scope_grant` (503), with the cause redacted.
- Grant volume: `select audience, registered_by, count(*) from trust.gateway_scope_grants group by 1, 2`.
- `pg_stat_activity.usename` separates connections per identity, for the connection budget.
- Bearer assertions are bind parameters of `register` and `establish`. The bootstrap sets `log_parameter_max_length = 0` and `log_parameter_max_length_on_error = 0` on the two roles that send them. `log_parameter_max_length` is superuser-protected. On PostgreSQL 18, `log_parameter_max_length_on_error` is USERSET: a role can raise it in its own session, so zero is only the bootstrap default, not an enforced boundary (see explicit limits). The local default of `log_parameter_max_length` is -1 (VERIFIED), which would log tokens in full whenever a statement is logged.
- `pnpm database-trust:audit` runs in CI after `db:verify` and fails on any finding not in the manifest's `acceptedFindings`.

### Deployment

- The planner always orders the migrator, then providers, then workers, then Shell (`scripts/plan-deployment-impact.mts`). Shell goes last because it loads provider remotes. This pilot does not reorder it.
- **During the first deploy of this change, Party requests fail closed** from the end of the migrator until Shell finishes deploying. During that window, either the old Party Worker connects as `ontos_runtime`, which no policy matches any more, or the new Party Worker receives tokens from an old Shell that registers no grants. The window spans the provider, worker and Shell phases of that single deploy. Announce it as stage maintenance. Later deploys are unaffected.
- Optional, to remove the Shell half of the window: land the issuer parts first as a separate stacked PR. Those parts are the `trust` migration, the issuer role in the bootstrap, the registrar, Shell registration and the issuer Hyperdrive.
- Each request to the Party audience costs one issuer autocommit insert, plus a bounded prune. Each Party scoped transaction costs one `establish` call and one xid assignment; read-only transactions now get an xid too, but their commit writes only a commit record and does not wait for a WAL flush (INFERRED). Each statement on a Party RLS table costs one or two initplans: a regexp, two SHA-256 calls and a key-row read. Measured local numbers are in [Measured costs](#measured-costs).

### Rollback

Rollback is in place and forward-only. It is one rollback release applied to the same database; redeploying the previous release on its own does **not** work. The previous verifiers reject the `trust` schema and the widened composition policy, and the previous bootstrap does not retarget policies. The rollback release:

1. Reverts the pilot's source changes but **keeps** every applied pilot migration folder, journal and snapshot.
2. Runs `pnpm db:generate` for `@app/core-runtime` and `@app/party-registry`. Drizzle then emits:
   - `ALTER POLICY ... TO "ontos_runtime"` with the `ontos.*` predicates for the 80 Party policies;
   - `DROP POLICY` for the worker and identity policies;
   - `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` on the 10 Core tables;
   - `ALTER POLICY` for the composition and Search policies.
3. Ships the reverted bootstrap, which grants `party` and `contacts` back to `ontos_runtime`, and the reverted wiring, which points Party back to `DATABASE_URL` and `HYPERDRIVE` and drops the Shell issuer binding.
4. Adds an explicit **post-owner-migrations retirement step**, not a Core migration. The migrator runs
   Core before Contacts and Party, so it must first finish the Core inverse migrations, then Contacts,
   then Party, and verify that no surviving policy references `trust`. Only then may this step run
   `DROP SCHEMA trust CASCADE;` and `GRANT TEMPORARY ON DATABASE <db> TO PUBLIC;`. After removing
   remaining dependencies, retire the pilot roles idempotently as admin. Run the rollback verifiers
   and grant audit only after retirement. Never drop `trust` before owner `ALTER POLICY` migrations:
   cascading would delete those policies and the later alters would fail with SQLSTATE 42704.

Deploy the rollback release with that explicit post-owner step before verification. Rehearse the complete Core → Contacts → Party → retirement → verification sequence on a disposable database, including policy counts before and after retirement; do not retire cluster-global roles on a database shared with other lane tests. Party recovers when the migrator finishes. Cost: one migrator run plus a deploy of Party and Shell. Rehearse it before merging (see follow-ups).

### Local development

- `pnpm env:local:ensure` derives `PARTY_REGISTRY_DATABASE_URL`, `PARTY_REGISTRY_WORKER_DATABASE_URL` and `SHELL_GATEWAY_ISSUER_DATABASE_URL` from a loopback `DATABASE_URL`, with user and password equal to the role name. It never overwrites existing values. `.env.example` documents the keys.
- `pnpm db:migrate` creates the roles.
- `docker-init-runtime-role.sh` is unchanged and still pre-creates only `ontos_runtime`.
- Locki runs `env:local:ensure`.
- Running Party locally needs Shell for assertions, as before.
- The local Cloudflare topology proof exports `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PARTY_REGISTRY_HYPERDRIVE` and `..._GATEWAY_ISSUER_HYPERDRIVE`.

### CI

- `service-integration` exports the three URLs (`ontos_ci`, port 5433, password equal to the role name).
- The Worker-proof steps' `printenv | grep -E` filters gain `PARTY_REGISTRY_DATABASE_URL`, `PARTY_REGISTRY_WORKER_DATABASE_URL` and `SHELL_GATEWAY_ISSUER_DATABASE_URL`.
- Test zero IDs are set for both new Hyperdrive variables wherever `ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID` is set.
- A new step `Audit runtime database identities against the checked-in grant manifest` runs `pnpm database-trust:audit` after `db:verify`.
- The step that drops `ontos_runtime` still proves the bootstrap runs first.
- Added runtime: about 2–3 minutes of integration tests, plus seconds for the audit.

### Measured costs

Local and indicative only. These were measured with `EXPLAIN (ANALYZE, BUFFERS)` on the migrated local PostgreSQL 18.6, five runs each, on 2026-10-20. All buffers were hits. The lane database holds 97 `party.parties` rows, 44 of them for the measured tenant. Stage numbers are UNKNOWN.

| Statement                                                                                  | Role                     | Execution time | Shared buffers    |
| ------------------------------------------------------------------------------------------ | ------------------------ | -------------- | ----------------- |
| `trust.register_gateway_scope_grant(...)`, first call on a new connection                  | `shell_gateway_issuer`   | 1.26–2.15 ms   | ~557              |
| `trust.establish_gateway_scope($assertion)`, first call on a connection                    | `party_registry_runtime` | 1.67–1.85 ms   | 800               |
| `trust.establish_gateway_scope($assertion)`, later transaction on the same connection      | `party_registry_runtime` | 0.10–0.15 ms   | 6                 |
| `select count(*) from party.parties` under RLS with the accessor initplan, first statement | `party_registry_runtime` | 1.24–1.70 ms   | 50 (+69 planning) |
| The same select, later statements                                                          | `party_registry_runtime` | 0.33–0.60 ms   | 4                 |
| `select count(*) from party.parties where tenant_id = $1`                                  | admin                    | 0.035–0.041 ms | 107               |

Most of the first-call cost is PL/pgSQL compilation and catalog loading, paid once per connection. On a warm connection, the accessor initplan (a regexp, two SHA-256 calls and a key-row read) adds about 0.3 ms per statement on a Party RLS table. `establish` adds about 0.1 ms per scoped transaction.

### Cost summary

| Area         | Added cost                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets      | 3 migrator service secrets; 2 Hyperdrive origin passwords                                                                                                                         |
| Cloudflare   | 2 Hyperdrive configs and bindings, 2 placement keys, drift checks; origin connection budget 40 + 10 + 5 against db18 `max_connections` (UNKNOWN)                                  |
| Zerops       | Generator, contract test and migrator environment changes; one extra URL each for the combined host and the Shell                                                                 |
| Database     | 1 schema, 3 tables, 7 routines; RLS on 10 Core tables; 4 runtime roles; 1 grant row per Party-audience assertion, pruned 60 s after expiry; xid consumption per Party transaction |
| Code         | Identity-aware config, provenance, installer, Search scope, registrar, Shell issuer, Party schemas, wiring and verifiers, bootstrap, audit v2                                     |
| Tests        | 3 new integration suites; 6+ Party integration files moved off `set_config`                                                                                                       |
| Rollback     | One forward rollback release plus one migrator run                                                                                                                                |
| Local and CI | Three environment keys (added automatically), one audit step                                                                                                                      |

## Explicit limits

1. Only Party Registry's request path is trusted. `ontos_runtime` can still forge `ontos.*` for every non-pilot table. It keeps cross-schema DML and `TEMPORARY`, and can execute 213 definer routines. These are accepted baseline findings, not regressions.
2. **Identity stores.** `ontos_runtime` can still write `auth.*`, `core.principals` and `core.principal_auth_bindings`. A compromised shared-runtime process could create an API key or binding and obtain genuine Party assertions from Shell over HTTP (INFERRED). The database trust root does not protect against identity forgery that happens before the issuer.
3. **Evidence integrity within authority.** Invocation creation and Action denial persistence now run through `invocationScopeExecutor`; Read denials use `persistScopedReadEvidence`. Request-role invocation, audit, data-access and domain-event policies enforce the trusted tenant, module, and sealed entity-or-global rule. A compromised Party process can still fabricate evidence within that authority, including tenant-global rows; these policies are isolation controls, not proof that the business event happened.
4. **Metadata.** Tenant IDs/status and module states remain cross-tenant metadata. Legal-entity, principal and binding metadata now require the trusted tenant, but legal-entity IDs/status within that tenant are not restricted to the selected entity. Column grants exclude names and secret payloads. No scope exposes no identity-table rows.
5. **Worker.** The worker reads 6 Party tables and Party Search rows under forgeable `ontos.*`. It holds the global Outbox matching and claim authority that `ontos_runtime` has today, so it could suppress or delay deliveries for other verticals by setting `matched_at`. Its locks on `tenants`, `domain_events` and `tenant_module_states` cannot write.
6. **Bearer reuse.** A compromised Party BFF can establish scope for any tenant whose live assertion it received, until its stored expiry + 30 s (at most 330 s after registration).
7. The `trust` routines are owned by the migration admin, which is a superuser on Zerops (INFERRED). A bug in a definer routine therefore has superuser reach. Static SQL, a pinned `search_path` and the catalog tests reduce the risk; a NOLOGIN owner is a follow-up.
8. A role can `ALTER ROLE` itself for user-settable parameters, and can change its own password. The bootstrap resets persistent settings/passwords and the audit flags role settings. On PostgreSQL 18, `log_parameter_max_length_on_error` is USERSET: a compromised issuer or request session can raise it and cause bind parameters (including bearer assertions) to enter error logs. The zero bootstrap default mitigates accidental logging but does not prevent malicious session overrides; restrict log access and retention. `log_parameter_max_length` is superuser-protected and cannot be raised by those roles.
9. Advisory locks share one global keyspace. A compromised Party BFF can hold the composition-authority key and block every vertical (denial of service).
10. `TEMPORARY` is revoked from PUBLIC on the application database. SpiceDB is unaffected because it uses a separate database (VERIFIED).
11. Effective grants on stage and production are UNKNOWN until the audit runs there.
12. Local development keeps every credential in one `.env`.
13. The sealing key is in database backups. Anyone with a backup and database access can forge seals, but that already amounts to admin access.
14. The worker split is a database boundary only inside the dedicated service. Inside `outbox-worker-host`, the same process also holds `DATABASE_URL`.

## Run the audit

```sh
mise exec -- pnpm database-trust:audit
```

The audit:

- requires `DATABASE_ADMIN_URL`, `DATABASE_URL`, `SHELL_GATEWAY_ISSUER_DATABASE_URL`, `PARTY_REGISTRY_DATABASE_URL` and `PARTY_REGISTRY_WORKER_DATABASE_URL`, all on one server and database;
- opens one connection per identity and requires `current_user = session_user` on each, with no two identities sharing a role;
- writes `.codex/reports/database/database-trust-boundary.json` (schema version 2), with one section per identity plus global findings;
- never writes URLs, passwords, tokens or real IDs into the report;
- exits non-zero on any finding not covered by the identity's `acceptedFindings`.

Code: `scripts/audit-database-trust-boundaries.mts` (entry), `scripts/database-trust-audit/collect-snapshot.mts` (catalog reads and probes) and `scripts/database-trust-audit/report.mts` (findings).

New finding codes, in addition to the 14 existing ones:

| Code                                         | Scope    | Severity |
| -------------------------------------------- | -------- | -------- |
| `runtime_role_has_temporary_authority`       | identity | high     |
| `runtime_role_privilege_outside_manifest`    | identity | high     |
| `runtime_role_missing_manifest_privilege`    | identity | high     |
| `runtime_role_has_role_settings`             | identity | high     |
| `trusted_scope_entry_point_unhardened`       | global   | critical |
| `runtime_identities_share_role`              | global   | critical |
| `runtime_identity_can_assume_other_identity` | global   | critical |

Rules:

- `runtime_role_has_cross_schema_dml` now applies only to the legacy shared identity.
- `runtime_role_can_forge_trusted_context` probes `set_config`, `SET LOCAL` and a forged `ontos_trust.scope`. For a `gateway_grant` identity it fires when the accessor accepts a forged seal or a plain session setting, or when a policy on a table the role can reach reads `ontos.*`. For a `session_setting` identity it fires when the role can set `ontos.*` and one of its policies reads it.
- `trusted_context_survives_transaction` also covers `ontos_trust.scope`, after rollback and after commit. The commit probe commits a transaction that only sets settings.
- For an explicit identity, effective schema USAGE, table and column privileges, sequence privileges and executable SECURITY DEFINER routines are compared with the manifest. `runtime_role_can_execute_security_definer` ignores the routines the manifest declares.
- `runtime_role_has_temporary_authority` fires whenever `TEMPORARY` is effective. It is accepted for `ontos_runtime` only.
- `trusted_scope_entry_point_unhardened` fires when a `TRUST_ROUTINES` entry is missing, has the wrong SECURITY DEFINER flag or `search_path`, is not owned by the admin, is executable by PUBLIC or an undeclared role, or when a `trust` routine is not declared at all, or a `trust` table has a runtime grantee.
- A finding is accepted only when an `acceptedFindings` entry has the same code and its objects are `'all'` or cover every finding object.

The audit does not analyze reachability in general: triggers, rules and cascades each need their own contract and test.

Local result on 2026-10-20 (migrated local PostgreSQL 18.6, worktree on top of 0325cbf9f): exit 0, 0 unaccepted and 0 global findings.

| Identity                 | Findings | Accepted                                                                                                                                                                          |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared_runtime`         | 4        | `runtime_role_can_execute_security_definer` (213 routines), `runtime_role_can_forge_trusted_context`, `runtime_role_has_cross_schema_dml`, `runtime_role_has_temporary_authority` |
| `shell_gateway_issuer`   | 0        |                                                                                                                                                                                   |
| `party_registry_request` | 0        |                                                                                                                                                                                   |
| `party_registry_worker`  | 1        | `runtime_role_can_forge_trusted_context` (the 6 Party worker-read tables and Party Search rows; see [Explicit limits](#explicit-limits) item 5)                                   |

## Acceptance evidence

For each #174 criterion, this section lists the exact test files and commands, and the date and commit they passed on. It is completed after integration.

| Criterion                                                         | Evidence                                                                                      | Command                                                                                                                                            | Passed on                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Effective grants match the checked-in manifest for every identity | `scripts/tests/audit-database-trust-boundaries.test.mts` (DB-free rules) and a live audit run | `mise exec -- pnpm exec rstest --project scripts scripts/tests/audit-database-trust-boundaries.test.mts`; `mise exec -- pnpm database-trust:audit` | 2026-10-20, local, uncommitted worktree on top of 0325cbf9f |
