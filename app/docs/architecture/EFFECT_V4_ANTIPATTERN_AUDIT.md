# Effect v4 anti-pattern audit

## Verdict

OntOS is **Effect-aware, but not yet Effect-native end to end**.

The core contains strong Effect foundations—`Context.Service`, `Layer`, typed errors, Schema decoding, HttpApi contracts, structured logging—but those foundations are repeatedly escaped at the most important seams:

1. **Effect → Promise → Effect runtime fragmentation**
2. **Competing type authorities instead of Schema-owned models**
3. **Generators and tooling propagating Promise-first/manual patterns**

Because OntOS is pre-live, the right move is not to add wrappers around these patterns. It is to remove the competing abstractions, fix the scaffolds, and establish one Effect-native application composition model before adding more MicroVerticals.

### Audit confidence

- **482 source files**
- **≈111,439 LOC**
- **24 Fable-only audit dimensions**
- **262 raw clusters**
- **133 merged clusters**
- **133/133 survived first-round adversarial verification**
- Completeness critic added **12 confirmed clusters**
- **145 verified surviving clusters**
- **1 refuted**, **1 dropped as non-Effect tooling**
- No repository files changed
- TraceDecay saved approximately **47k tokens**

The final Fable synthesizer itself was quota-blocked. The tiering below is a direct consolidation of the completed Fable finder, merger, verifier, and completeness-critic outputs.

---

# S tier — architectural blocker

## S1. Eliminate the Effect–Promise–Effect transaction sandwich

**Severity:** Systemic correctness and runtime-integrity problem  
**Effort:** XL  
**Scale:** Exactly 16 bare `Effect.runPromiseExit` re-entries inside the two governed transaction engines, plus private throw-based rollback sentinels.

The Action and Read runtimes leave Effect to enter a Drizzle Promise transaction, then repeatedly start new root fibers inside the callback. This breaks propagation of:

- parent spans
- log annotations
- `Context.Reference` values
- `ConfigProvider`
- `Clock` and test capabilities
- interruption
- the handler’s `R` environment

Evidence:

- `packages/core-runtime/src/actions/runtime.ts:776`
- `packages/core-runtime/src/actions/runtime.ts:781`
- `packages/core-runtime/src/actions/runtime.ts:813`
- `packages/core-runtime/src/actions/runtime.ts:836`
- `packages/core-runtime/src/actions/runtime.ts:907`
- `packages/core-runtime/src/reads/runtime.ts:96`

### Effect v4 target

Create one Core-owned transaction bridge whose body remains an `Effect<A, E, R>`. Capture the current context and use `Effect.runPromiseExitWith(context)` only once at the unavoidable Drizzle callback boundary. Preserve the existing uncertain-commit handling, but carry typed failures in `E` and defects/interruption in `Cause`.

Longer-term, transaction bodies should become a single `Effect.gen` program:

```text
lock → validate → install scope → recheck → execute handler → flush → commit
```

Do not individually `runPromiseExit` each step.

**Unlocks:** reliable tracing, ambient request context, deterministic interruption, Effect-aware testing, simpler rollback semantics, and removal of multiple local `Effect.provide` calls.

---

# A tier — high priority

## A1. Establish one process-level Layer and ManagedRuntime composition model

**Effort:** XL  
**Scale:** Four runtime roots, 15+ manually wired layers, 12 `Layer.orDie` sites, duplicated persistence providers, multiple pools, and roughly 40 browser `runPromise` seams.

Current service classes and Live layers are good locally, but process roots manually reconstruct the graph. Some library layers internally provide their own dependencies, hiding their true requirements and prompting `Layer.fresh` workarounds. Browser clients have no stable runtime at all.

Evidence:

- `packages/core-runtime/src/actions/runtime.ts:1028`
- `packages/core-runtime/src/reads/runtime.ts:746`
- `verticals/contacts/api/index.ts:227`
- `verticals/contacts/api/read-server-support.ts:51`
- `apps/shell-super-app/src/api/auth-client.ts:172`
- `verticals/contacts/src/api/contacts-client.ts:63`

### Effect v4 target

- Define explicit Shell, Contacts, worker, and browser Layer graphs.
- Keep library Live layers dependency-transparent; compose dependencies at the application root.
- Create one `ManagedRuntime` per long-lived host/runtime.
- Construct HttpApi clients once from injected `HttpClient`.
- Capture the runtime at forced Promise adapters rather than calling bare `Effect.runPromise`.
- Move Bearer/JWK verification and imported key material into long-lived services rather than rebuilding them per request.

**Unlocks:** test substitution, stable resource ownership, shared clients, configuration injection, observability, and removal of per-handler wiring.

---

## A2. Make Schema the sole authority for contracts and domain models

**Effort:** XL  
**Scale:** Approximately 119 `Schema.Codec<Interface>`-style declarations, zero production `Schema.Class` domain entities, zero branded identifiers, and hundreds of overlapping hand-authored shapes.

The repository frequently declares a TypeScript interface first and then annotates a Schema to match it. Drizzle rows, transport DTOs, domain values, form models, and service inputs often become separate competing authorities.

Evidence:

- `packages/shared-contracts/src/index.ts:209`
- `packages/core-runtime/src/outbox/repository.ts:76`
- `packages/core-runtime/src/auth/principal-management.ts:61`
- `verticals/contacts/src/services/customer-contact-persistence.service.ts:77`
- `verticals/contacts/src/services/customer-contact-persistence.service.ts:141`
- `apps/shell-super-app/api/modules/shell-resources.ts:114`

### Effect v4 target

- Define transport types using `Schema.Struct`, `Schema.TaggedClass`, and `Schema.TaggedError`.
- Derive types from the Schema rather than annotating the Schema with a prior interface.
- Introduce `Schema.brand` for tenant, principal, legal-entity, module, action, customer, contact, deployment, IČO, and idempotency identifiers.
- Introduce schema-backed persistence/domain models and explicit row codecs.
- Model absence and outcomes with `Option`, `Result`, `Schema.OptionFromNullOr`, or typed failures as appropriate.
- Move refinements and cross-field rules into the owning Schema.
- Use `Schema.DateTimeUtc` and explicit date-only codecs instead of generic strings and hand calendar arithmetic.

**Unlocks:** removal of manual guards, safer forms and routes, meaningful identifier incompatibility, property-based testing, and shared validation across client/server/persistence.

---

## A3. Replace ambient configuration with Config, ConfigProvider, and Redacted

**Effort:** L  
**Scale:** Baseline of 141 `process.env` occurrences; approximately 80–110 hand-parsed configuration sites depending on how shared helpers are counted.

Configuration currently combines `process.env`, per-module dotenv loading, `trim`, `new URL`, number/range checks, `JSON.parse`, synchronous Schema decoding, and throws. Credentials, private keys, Bearer tokens, and passwords often remain ordinary strings.

Evidence:

- `packages/core-runtime/src/db/config.ts:87`
- `packages/core-runtime/src/permissions/config.ts:105`
- `packages/core-runtime/src/permissions/config.ts:11`
- `verticals/contacts/api/auth/action-principal.ts:117`
- `apps/shell-super-app/api/auth/gateway-issuer-config.ts:57`
- `apps/shell-super-app/api/auth/config.ts:54`

### Effect v4 target

- Create one application configuration Schema.
- Decode it through `Config`, `Config.schema`, and a root `ConfigProvider`.
- Compose environment and dotenv providers at startup.
- Use `Schema.fromJsonString` for JSON-valued configuration.
- Represent key material and credentials using `Redacted`/`Schema.Redacted`.
- Load and import JWK material once in a Layer.

**Unlocks:** deterministic tests with map-backed providers, secure logging, removal of repetitive parsing, and one typed startup failure vocabulary.

---

## A4. Rebuild the error system around typed channels and contract-owned Problem Details

**Effort:** XL  
**Scale:** Roughly 113 manual `_tag` comparisons, numerous blanket `mapError` collapses, duplicated endpoint Problem schemas, and approximately 20 local defect-to-500 seams.

Current patterns include:

- `_tag ===` inside `Effect.catch` and `mapError`
- non-exhaustive switches
- `Effect.mapError(() => oneGenericError)` discarding original failures
- Problem Details literals duplicated from endpoint schemas
- raw statuses duplicated in object constructors
- WeakMaps carrying defect causes beside typed errors
- frontend reclassification after `runPromise` erases the original union

Evidence:

- `apps/shell-super-app/api/auth/impersonation-service.ts:493`
- `verticals/contacts/api/read-server-support.ts:67`
- `apps/shell-super-app/api/index.ts:186`
- `verticals/contacts/api/index.ts:179`
- `verticals/contacts/src/error-classification.ts:6`
- `verticals/contacts/src/routes/[lang]/contacts/customers/page.tsx:95`

### Effect v4 target

- Define each expected failure as `Schema.TaggedError`.
- Declare public errors once on the HttpApi endpoint.
- Derive RFC 9457 payloads and HTTP status from that contract.
- Use `Effect.catchTag`, `Effect.catchTags`, and exhaustive `Match`.
- Preserve original failures or causes when translating between layers.
- Keep unexpected defects in `Cause` until one outer HTTP seam converts them into a sanitized typed internal problem.
- Remove WeakMap cause side channels; use an explicit safe cause field where appropriate.
- Generate or centralize frontend classification from the same error vocabulary.

This is also required by `docs/architecture/ERRORS.md`; it is not merely stylistic.

**Unlocks:** exhaustive UI handling, correct retry policy, accurate 400/401/409/428/429/503 distinctions, and removal of per-endpoint error factories.

---

## A5. Introduce an Effect-shaped persistence seam and typed database failures

**Effort:** XL  
**Scale:** Approximately 85 ad hoc `Effect.tryPromise` wrappers, multiple Promise-shaped first-party ports, and four independent PostgreSQL cause-chain/SQLSTATE walkers.

First-party repositories frequently return `Promise`, then callers reconstruct Effects around them. PostgreSQL failures are either walked manually through unknown `.cause` chains or collapsed into generic retryable 503 errors.

Evidence:

- `packages/core-runtime/src/actions/repository.ts:282`
- `packages/core-runtime/src/actions/repository.ts:327`
- `packages/core-runtime/src/actions/runtime.ts:203`
- `apps/shell-super-app/api/auth/service.ts:250`
- `apps/shell-super-app/api/auth/impersonation-service.ts:177`
- `verticals/contacts/src/services/customer-contact-persistence.service.ts:97`

### Effect v4 target

- First-party ports return `Effect`, not `Promise`.
- Keep Drizzle as an implementation detail behind `Context.Service`.
- Centralize Promise conversion at the driver edge.
- Introduce a Core-owned database failure taxonomy and one decoder for SQLSTATE, constraints, connectivity, deadlock, serialization, scope/RLS, and unexpected defects.
- Never expose raw driver messages in public Problem Details.
- Unify this with the S-tier transaction bridge.

**Unlocks:** retry schedules based on typed reasons, simpler service code, preserved causes, and consistent persistence behavior across Shell and MicroVerticals.

---

## A6. Activate real observability at the runtime roots

**Effort:** L–M  
**Scale:** No explicit Tracer/OTel/Logger/minimum-level Layer at the examined roots; `Effect.fn` usage is zero and `Metric` usage is zero.

Production logging is already structured, but spans are not backed by an installed tracing runtime, correlation data is threaded manually, and operational subsystems expose no metrics.

Evidence:

- `apps/shell-super-app/api/index.ts:724`
- `apps/shell-super-app/api/index.ts:1155`
- `verticals/contacts/api/customer-list-read-server.ts:73`
- `packages/core-runtime/src/actions/runtime.ts:630`
- `packages/core-runtime/src/reads/runtime.ts:254`
- `packages/core-runtime/src/permissions/service.ts:181`

### Effect v4 target

- Install Tracer/OpenTelemetry, Logger, and minimum log-level Layers at each runtime root.
- Establish one outer HTTP instrumentation/error seam.
- Put correlation, tenant, legal-entity, principal, module, action, and invocation identities into ambient annotations/span attributes.
- Adopt `Effect.fn` for service operations and handlers.
- Add `Metric` counters/histograms/gauges for actions, reads, authorization, authentication, outbox claims/delivery/retries, and dependency availability.

**Unlocks:** reliable cross-service traces, latency/error attribution, operational alerts, and removal of copy-pasted annotations.

---

## A7. Give topology, composition, and authorization evidence shared Schemas

**Effort:** L–M  
**Scale:** At least eight independently shaped topology/config readers plus several security-gate document validators.

Authoritative topology and authorization documents are decoded using combinations of `JSON.parse`, `Schema.Json`, optional interfaces, structural walking, exact-key comparisons, and casts.

Evidence:

- `apps/shell-super-app/modern.config.ts:101`
- `apps/shell-super-app/module-deployment-allowlist.config.ts:62`
- `apps/shell-super-app/api/modules/deployment-allowlist.ts:25`
- `apps/shell-super-app/api/verticals/installed-verticals.ts:37`
- `scripts/authorization/rollout-contract.mts:36`
- `scripts/authorization/protected-entrypoint-inventory.mts:41`

### Effect v4 target

Create a shared composition-contract package containing Schemas and JSON-string codecs for:

- reference topology
- ownership
- local overlays
- deployment allowlists
- Module Federation manifests
- authorization rollout contracts
- readiness and would-deny evidence

All runtime, build, and script consumers should decode through those same Schemas.

**Unlocks:** trustworthy deployment planning, safer authorization rollout, removal of casts, and consistent diagnostics.

---

## A8. Fix the generators before generating more code

**Effort:** L–M  
**Scale:** Scaffolds emit approximately 40 recurring plumbing sites; scripts contain about 28k LOC outside current lint/typecheck coverage.

Generators currently emit Promise-first browser code, repeated route argument types, per-call clients, manual error switches, and—in one stale template—manual JWK parsing that production Contacts had already replaced.

Evidence:

- `scripts/scaffolding/microvertical-page/scaffold.mts:236`
- `scripts/scaffolding/microvertical-page/scaffold.mts:243`
- `scripts/scaffolding/microvertical-page/scaffold.mts:374`
- `scripts/scaffolding/governed-contribution/scaffold.mts:281`
- `scripts/validate-ultramodern-workspace.mts:2109`
- `package.json:70`

### Effect v4 target

Change scaffolds to emit:

- Schema-first contracts
- branded route parameters
- a shared browser runtime
- generated Effect data hooks
- exhaustive typed error handling
- shared form codecs
- Layer-provided test seams

Bring `scripts/` and `tools/oxlint` under explicit TypeScript and anti-slop gates. Govern file-wide Effect diagnostic suppressions with narrow justifications and expiry/removal criteria.

**Unlocks:** stops architecture debt from multiplying and makes later migrations durable.

---

## A9. Preserve typed Effects through the frontend

**Effort:** XL  
**Scale:** Roughly 40 scattered browser `runPromise` calls, fresh clients per operation, ten route-specific error classifiers, and repeated manual route/form parsing.

Evidence:

- `apps/shell-super-app/src/api/auth-client.ts:172`
- `apps/shell-super-app/src/api/auth-client.ts:419`
- `verticals/contacts/src/api/contacts-client.ts:63`
- `apps/shell-super-app/src/routes/module-entrypoint-loader.ts:41`
- `verticals/contacts/tests/components/contact-create-page.test.tsx:62`
- `verticals/contacts/src/routes/[lang]/contacts/customers/page.tsx:95`

### Effect v4 target

- One browser `ManagedRuntime`.
- Long-lived HttpApi clients.
- One query adapter that runs Effects, threads cancellation signals, and preserves typed failures until the React/TanStack boundary.
- Schema-driven route/search parameters through `Schema.standardSchemaV1`.
- Form codecs derived from payload Schemas.
- Exhaustive `Match` against a shared frontend failure vocabulary.

React and TanStack still require Promise adapters; that does **not** require making the application Promise-first internally.

**Unlocks:** cancellation, coherent retries, shared cache behavior, fewer classifiers, and substantially smaller generated pages.

---

# B tier — important consolidation

## B1. Make workers and independent reads declaratively concurrent

**Effort:** M

The outbox uses fixed-interval imperative polling; independent remote providers and enrichment reads are frequently sequential; database and SpiceDB operations lack consistent typed timeout/retry policy.

Evidence:

- `packages/core-runtime/src/outbox/runtime.ts:262`
- `packages/core-runtime/src/outbox/poller.ts:166`
- `apps/shell-super-app/api/modules/shell-resources.ts:191`
- `apps/shell-super-app/api/modules/shell-resources.ts:236`
- `apps/shell-super-app/src/routes/module-entrypoint-loader.ts:32`

Use `Stream`, `Schedule`, bounded `Effect.forEach`/`Effect.all`, typed retry schedules, explicit timeouts, and interruption-aware worker scopes. Preserve deterministic ordering where business semantics actually require it.

---

## B2. Build one Effect-aware testing harness

**Effort:** L–M  
**Scale:** Approximately 642 `Effect.runPromise` calls in tests, real sleeps/timers, hand-built HTTP servers, and extensive module mocking.

Evidence:

- `packages/core-runtime/tests/integration/action-runtime.test.ts:389`
- `packages/core-runtime/tests/integration/action-runtime.test.ts:1392`
- `packages/core-runtime/tests/unit/outbox-poller.test.ts:127`
- `verticals/contacts/tests/integration/customer-contact-bff.test.ts:380`
- `verticals/contacts/tests/unit/customer-contact-persistence.service.test.ts:63`

Create repository-owned `itEffect`/`itLayer` helpers using `effect/testing`, `TestClock`, scoped Layers, and map-backed `ConfigProvider`s. Exercise HttpApi handlers through an injected client rather than three copies of `node:http` bridging.

Add property-based testing for Schema round trips and refinements.

**Correction:** `@effect/vitest` is **not currently installed** in this checkout. Do not base the migration on it unless dependency policy explicitly adds it.

---

## B3. Convert consequential operational scripts into Effect programs

**Effort:** XL  
**Scale:** Approximately 79 of 103 scripts are primarily async/await; hundreds of manual throws and several independent argv parsers remain.

Evidence:

- `scripts/migrate-contacts-authorization.mts:98`
- `scripts/migrate-contacts-authorization.mts:291`
- `scripts/postgres/bootstrap-runtime-role.mts:29`
- `scripts/initialize-local-development.mts:652`
- `scripts/check-ontos-module-contracts.mts:69`
- `scripts/scaffolding/cli.mts:683`

Prioritize migration, bootstrap, authorization, topology, and scaffold scripts—not trivial wrappers. Use scoped resources, shared Layers, typed errors, Schema decoders, and `effect/unstable/cli`. Keep one small process-exit adapter at the executable edge.

---

## B4. Make Context services and Effect.fn the default dependency vocabulary

**Effort:** L–M

Large positional factory signatures, option bags, and symbol-slotted operation records currently coexist with `Context.Service`, reducing the value of the Layer graph.

Evidence:

- `packages/core-runtime/src/actions/runtime.ts:443`
- `packages/core-runtime/src/reads/runtime.ts:148`
- `packages/core-runtime/src/actions/repository.ts:822`
- `packages/core-runtime/src/operations/context.ts:185`
- `apps/shell-super-app/api/index.ts:1693`

Promote scoped transaction access, operation scope, collector, clocks, identifiers, repositories, and request identity into explicit services/references. Instrument public operations with `Effect.fn`. Replace module-level mutable memoization with runtime-owned cached effects/resources where lifecycle matters.

---

## B5. Adopt Effect’s ADTs and temporal model consistently

**Effort:** M

The codebase underuses `Option`, `Result`, `Match`, Effect collection helpers, branded values, and DateTime schemas. Closed vocabularies and timestamps are repeatedly re-declared.

Evidence:

- `packages/core-runtime/src/outbox/repository.ts:76`
- `packages/core-runtime/src/auth/principal-management.ts:61`
- `verticals/contacts/src/services/customer-contact-persistence.service.ts:77`
- `apps/shell-super-app/api/modules/shell-resources.ts:114`
- `packages/shared-contracts/src/index.ts:209`

Adopt these where they simplify public semantics; do not mechanically replace every native array or `undefined`. Highest-value targets are service outcomes, persistence absence, closed status vocabularies, timestamps, pagination, and exhaustive error mapping.

---

# C tier — localized cleanup

## C1. Remove remaining hand-owned serialization

**Effort:** S–M

Localized examples remain in API-key metadata, cookie construction, identity/equality keys, JSON-LD embedding, tests, and build injection.

Evidence:

- `apps/shell-super-app/api/auth/api-key-service.ts:150`
- `apps/shell-super-app/api/auth/api-key-service.ts:157`
- `apps/shell-super-app/api/auth/api-key-service.ts:281`
- `apps/shell-super-app/api/auth/impersonation-service.ts:265`

Use `Schema.fromJsonString`, Schema encoders, Effect HTTP Cookies, and explicit stable-key codecs. Do not replace correct Drizzle JSONB or HttpApi serialization.

---

## C2. Replace raw Option, Exit, and `_tag` inspection

**Effort:** S

Use `Option.match`, `Option.isSome`, `Exit.match`, `Exit.isFailure`, `Effect.catchTag(s)`, and exhaustive `Match`. This is mostly readability and exhaustiveness once the A-tier error model is in place.

---

## C3. Remove local side channels and duplicated UI state contracts

**Effort:** S–M

The Contacts edit-success WeakMap is non-reactive and exists outside the query/router state model.

Evidence:

- `verticals/contacts/src/contacts-query-client.ts:9`
- `verticals/contacts/src/contacts-query-client.ts:22`
- `verticals/contacts/src/contacts-query-client.ts:32`
- `verticals/contacts/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]/edit/page.tsx:500`

Put success/invalidation state in the router, mutation result, or QueryClient contract rather than a WeakMap side channel.

---

# D tier — leave or fix opportunistically

These are not migration drivers:

- Line-preserving `.env` rewriting where comments and ordering must survive.
- Promise adapters forced by React, TanStack, Modern.js, Playwright, Drizzle, and Node process entrypoints.
- Deliberately malformed casts in tests proving rejection behavior.
- `JSON.stringify` inside external test fixture APIs that require a body string.
- `Layer.orDie` at a deliberate outer startup boundary—provided the typed cause is logged first.
- Native array/object operations where Effect collection APIs add no semantic value.
- The Rspack injected-global `try/catch` finding was dropped entirely: it has no meaningful Effect-native replacement.

---

# Recommended migration order

1. **Transaction bridge:** remove deep `runPromiseExit` re-entry.
2. **Root composition:** one Layer graph and ManagedRuntime per process/browser host.
3. **Configuration:** ConfigProvider, typed startup config, Redacted secrets.
4. **Persistence seam:** Effect-returning ports and shared database failure decoder.
5. **Schema-first model:** domain entities, contracts, brands, Option/Result, temporal codecs.
6. **Error transport:** contract-owned Problem Details and exhaustive tagged handling.
7. **HTTP/auth middleware:** load verification material once; establish request identity context.
8. **Observability:** activate OTel/Logger Layers, `Effect.fn`, metrics, ambient annotations.
9. **Frontend runtime:** typed query/mutation adapter, route and form schemas.
10. **Generators and gates:** ensure all newly generated code follows the target architecture.
11. **Workers and concurrency:** Stream/Schedule, bounded fan-out, typed retries/timeouts.
12. **Testing:** shared Effect harness, TestClock, in-memory HttpApi clients.
13. **Operational scripts:** migrate only the consequential scripts first.
14. **C-tier cleanup:** serialization, raw tags, side channels, collection idioms.

---

# Existing patterns to preserve

The audit explicitly found these areas healthy:

- Production cast hygiene is strong:
  - no ordinary `as Type` value casts
  - no `as unknown`
  - no production non-null assertions
  - no raw `typeof x === ...` narrowing
- Outbox payloads already use `Schema.Json`, registered payload Schemas, and Drizzle JSONB correctly.
- Production HTTP bodies are largely HttpApi/schema-driven rather than hand-built `Response` objects.
- Production logging is structured through `Effect.log*` and annotations.
- `Context.Service` is established in Core and should become the reference pattern.
- Cookie parsing already uses better-auth and Effect HTTP helpers.
- Several tests already decode responses through Schema.
- ARES uses Effect Cache/Semaphore idiomatically.
- No production `forkDaemon`/fiber-leak pattern was found; the observed `forkScoped` use is correct.
- `satisfies` and production `as const` uses are legitimate contract/literal checks.
- `Array.isArray` in recursive JSON normalization is appropriate.
- Bare `Effect.runPromise` is acceptable at the single outer process or framework adapter seam; the problem is repeated deep re-entry.

The central recommendation is therefore **not** “rewrite everything with Effect syntax.” It is: **stop escaping Effect at ownership boundaries, make Schema authoritative, and ensure generators encode that architecture.**
