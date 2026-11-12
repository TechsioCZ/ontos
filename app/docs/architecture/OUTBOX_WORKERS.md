# Outbox Worker Architecture

Outbox Workers are module-owned asynchronous entrypoints for committed Outbox Messages. Core owns matching, delivery state, leases, attempts, retries, dead letters, and checkpoints. A MicroVertical owns only its generated descriptor and private Effect handler.

## Process and dependency ownership

Every consuming MicroVertical exposes its workers as one generated Outbox Worker entry (`src/worker-host/entry.ts`): its claim-owner prefix, its closed worker layer, its private registrations, and their subscriptions. `startOutboxWorkerHost` runs a list of entries in one Node process; each entry keeps its own ManagedRuntime, polling loop, and claim owner, while Core supplies the generic polling and delivery runtime. Worker code therefore stays physically inside its owner and may require the owner's Effect repositories and services. The owner composes those requirements in its worker layer, using the same server-side capabilities available to its Actions; Core never imports or publishes the private implementations.

The same entries deploy two ways, chosen by the deploying environment's required `OUTBOX_WORKER_MODE` GitHub environment variable. The mode is independent of `DEPLOY_TARGET`: the Outbox Workers run on Zerops for both targets.

- `dedicated` (production): each owner's generated `src/worker-host/main.ts` hosts its one entry in its own `<owner>-worker` service, so owners deploy, scale and fail independently.
- `host` (stage, previews, demos): one Zerops service, `outbox-worker-host`, runs the reviewed release's worker owners in one cheap process. `scripts/outbox-worker-host.generated.mts` remains the complete source-owned delivery inventory. Materialization validates that inventory, then compiles only entries whose owners belong to the reviewed application release intent. An available entry does not install or activate its owner.

The host materializer reads the workspace-relative `COMPOSITION_INTENT_FILE`, defaulting to `topology/application-release-intent.json`. Custom deployment intents must reach the **remote build**, not only the runner's environment. `zerops:materialize-environment` copies this path into the host setup's `build.envVariables`; deployment supplies the same recorded intent path that selected the complete release. Invalid or missing intent, unknown or duplicate members, and inventory drift fail the build. The source-owned generated inventory is never rewritten for a deployment.

The planner (`--outbox-worker-mode host`) deploys the host through `ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID` whenever any hosted owner is impacted, the selected intent file changes, or host mode needs reconciliation. Planning reads the same `COMPOSITION_INTENT_FILE` path. It conservatively marks all hosted owners for fresh builds before complete release selection, because the host compiles its selected owners at one source revision. Selection still intersects that build impact with reviewed membership, so absent owners do not become installed members. Dedicated mode and unrelated selective owners remain independent. The materialized artifact records only the actually compiled owner identities; it never relabels rebuilt code with a retained marker.

Excluding an entry from a new host does not prove that its old deliveries or completion debt are absent. The existing publication, migration, drain, and claim fences still account for historical work. Every included entry must match the current approved owner artifact and subscription catalog before claims; filtering build membership does not bypass those checks.

Worker execution phases in both modes are limited to reviewed release membership. A full dedicated plan therefore deploys only reviewed owners' worker services, even when conservative build impact includes other topology owners. Switching modes still stops the inventoried workers of the other mode; that stop list is not evidence that excluded owners have no historical work.

The variable has no default, so an environment never silently runs the other mode. Switching is one variable change followed by a deploy: set `OUTBOX_WORKER_MODE` on the environment and run its deploy. The deploy sees that the other mode's workers still run, or that this mode's do not, deploys every worker of the new mode, and stops the old mode's workers after the new ones are up. The `host` mode needs the `outbox-worker-host` service and its `ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID` variable; the `dedicated` mode needs each owner's worker service and variable.

`scripts/generate-outbox-worker-deployment.mjs` derives the dedicated worker setups, the `outbox-worker-host` setup, and the host entry from topology and worker-entry discovery, so no hand-kept list names the hosted owners.

Matching uses the complete schema-free subscription snapshot from the validated installed-module deployment catalog. Core's matcher receives that complete snapshot explicitly and creates deliveries before independently deployed owner processes claim them. Each hosted loop holds only its own owner's private registrations and must prove they match its deployment descriptors. No generator scans unrelated vertical source or rewrites a shared source-time subscription registry. This split prevents the first polling process from marking a message with only its local handlers and starving other independently hosted consumers.

`scaffold:outbox-worker -- --authorization owner_local_background` creates the owner's worker layer, entry, `main.ts` and `worker:start` script when needed; then run `mise exec -- node scripts/generate-outbox-worker-deployment.mjs --write` to add the owner's dedicated worker and add it to the host. Run the host alone with `mise exec -- pnpm dev:outbox-worker-host`; the normal `mise exec -- pnpm dev` command starts it alongside the applications. The host has one `SIGINT`/`SIGTERM` handler and one `/ready` endpoint on `OUTBOX_WORKER_HEALTH_PORT` that is ready only while every hosted loop has completed a recent successful cycle. If any loop fails, the host interrupts the others, disposes every runtime, and exits non-zero. Each loop performs one cycle immediately and then polls every 1,000 ms. These optional scalar environment values may override the safe defaults for a deployment:

- `OUTBOX_WORKER_POLL_INTERVAL_MS` — interval from 10 through 3,600,000 ms; default `1000`.
- `OUTBOX_WORKER_MAX_DELIVERIES` — maximum deliveries claimed per cycle from 1 through 1,000; default `100`.
- `OUTBOX_WORKER_PROCESS_IDENTITY` — stable process identity; the process derives one from its process ID and a random process nonce by default. It only fills the suffix of each loop's `<owner prefix>:<process identity>` claim owner (at most 200 characters), so hosted loops never share a claim owner.

Invalid values fail process startup instead of silently selecting an unsafe cadence. CI proves the deployable host on every change: `scripts/prove-outbox-worker-host-artifact.sh` materializes it with its `zerops.yaml` build command, runs its real start command against the freshly migrated database until `/ready`, and requires a clean exit on `SIGTERM`. `SIGINT` and `SIGTERM` interrupt every polling fiber and release each loop's scoped PostgreSQL pool. Multiple instances are safe because matching is idempotent and delivery claiming is lease-protected; handler effects remain at-least-once and must still be idempotent.

Each entry provides its own `DatabaseConfig` and builds its own PostgreSQL pool, so entries in one process do not share credentials. Every entry uses `DATABASE_URL` (`ontos_runtime`) except Party Registry, whose `worker-host/layer.ts` uses `makeDatabaseConfigLive(PARTY_REGISTRY_WORKER_IDENTITY)` to read `PARTY_REGISTRY_WORKER_DATABASE_URL` (`party_registry_worker`). `outbox-worker-host` therefore holds both URLs, and the dedicated `party-registry-worker` holds only the Party one. The Party worker keeps the global matcher and claim authority: S I U on `core.outbox_deliveries`, `core.outbox_attempts` and `core.worker_checkpoints`, and UPDATE on `core.outbox_messages.matched_at` only. Its other Core privileges are lock-only. PostgreSQL requires UPDATE on every table a `SELECT ... FOR UPDATE` locks, so the role holds UPDATE on one column of `core.domain_events`, `core.tenant_module_states` and `core.tenants`, and their `WITH CHECK (false)` policies make any real `UPDATE` fail. See [Database trust boundaries](./DATABASE_TRUST_BOUNDARIES.md).

## Published Contract Boundary

- A producer publishes one schema-only package subpath per exact topic. It contains the Effect payload schema, producer module key, and topic constant—never an Action, factory, repository, handler, transport, database client, or BFF implementation.
- Producer, consumer, and worker ownership use dotted OntOS module IDs. Deployment app IDs are not Outbox business identities.
- A consumer imports that published subpath and its own Core descriptor API. It never deep-imports another MicroVertical's source or executes another MicroVertical's implementation.
- Generate producer messages with `mise exec -- pnpm scaffold:outbox-message` and consumers with `mise exec -- pnpm scaffold:outbox-worker -- --authorization owner_local_background`. Generated worker registries stay server-side and are not Module Federation or BFF surfaces.

## Immutable Matching

An Outbox Message is an immutable broadcast source linked to one committed Domain Event. At first observation, Core matches the message against the complete installed subscription catalog by exact producer module and exact topic. In one transaction it creates at most one delivery per message and worker and sets `matched_at`, including when no workers match. Re-observation is idempotent. Deploying a new worker does not backfill already matched messages in V0. Each process also verifies that every owner-local registration has an identical catalog entry before it can match or claim work.

Each Worker declares a structured tenant `worker`/`background` entrypoint governed by [Module Entrypoints and Tenant State](./MODULE_ENTRYPOINTS.md). Claim eligibility uses the central matrix inside the existing atomic claim query. Only `active` consumers are eligible; every other or missing state leaves work unattempted and retryable. The producer's current module state never authorizes the consumer entrypoint, and handler resolution occurs only after an eligible claim.

Intrinsic provider eligibility is derived from the same admitted Composition as the hosted owner registration and folded into the existing claim SQL. Handler-side operation requirements use Core's attestation of the actual native returned claim and its revision, not a caller's cycle metadata or a copied claim object. A worker's conditional port call may use the key-only requirement facade only inside this genuine claimed execution. Persisted originating actor IDs are audit context; they do not mint a fresh delegated end-user Principal. Owner-outcome reporting retains its independently authorized service/owner authority and retained-outcome checks.

## Claims and Attempts

Core claims an eligible delivery transactionally with a unique claim identity and expiry, changes it to `processing`, increments its attempt count, and creates one unfinished attempt before handler execution. Concurrent dispatchers use lock-safe selection so only one live claim executes. A later dispatcher may reclaim only an expired lease; reclaiming finishes the abandoned open attempt with a safe error before starting the next attempt. A stale claimant can never finalize a newer claim.

The handler receives decoded payload data and a restricted context containing message, delivery, Domain Event, tenant sequence, producer/topic, correlation, verified originating actor when present, attempt, worker, and claim identities. It receives no raw database executor. Payload decoding and handler execution happen outside the claim transaction.

Tenant-wide maintenance handlers that must observe owner data in every Legal Entity use Core's
verified Legal Entity scope fan-out. Core enumerates every current Tenant-owned Legal Entity,
including suspended and archived entities, and revalidates the exact Tenant, Legal Entity, and
lifecycle row inside one independent transaction per scope. The owner callback receives only the
exact identifiers and a lifetime-bound scoped-routine invoker; it never receives a transaction or
database executor. Callback failure rolls back its scope transaction, an empty or indeterminate
enumeration fails retryably, and at-least-once retries therefore require idempotent owner routines.

### Registered cross-owner effects

A worker that calls a published owner client may acquire a fresh registered-workload assertion through the existing typed Shell delegated gateway. `RegisteredWorkload` accepts only the Core-verified handler context. Shell independently proves the native processing delivery, claim identity, live lease, source module, original succeeded admission and current Composition. The issuer-owned rule names the exact destination operation and scope; the source manifest declares its exact intrinsic or conditional operation contract. The receiving owner independently checks current original and system workload bindings as described in [Authorization](./AUTHORIZATION.md#registered-workload-gateway-authority).

For a conditional call, `readWorkerModuleOperationRequirement(key, context)` exposes a factual contract witness only within the actual registered worker execution. It requires the same handler context object, genuine native claim, active process binding and active handler lifetime. A copied context, another concurrent claim or a closed lifetime cannot borrow that witness. The frozen worker fact identifies the worker, consuming entrypoint, provider, Composition and Tenant; it does not invent a consuming schema version. The shared gateway helper reads this witness before sending `operationRequirementKey` in a current worker subject, including live-worker recovery. Shell still validates the durable claim and exact conditional contract independently.

The assertion carries the claim identity as well as the delivery. The receiver's Core gate checks current lease ownership through a scoped factual trust routine, so a token cannot outlive a completed, expired or replaced claim even though its signed token window remains 300 seconds. Request roles receive no direct dispatch-ledger access. A lost claim cannot acquire or use fresh effect authority.

A worker ledger may remain tenant-only while a remote operation has a separately attested Legal Entity scope. The company comes from the durable original admission, not an arbitrary worker argument. System enrollment is resolved per Tenant and exact workload; a global configured Principal is not a substitute, and multiple active eligible enrollments fail closed. Registered owner-to-owner follow-up calls use `RegisteredAssertion` with an exact approved downstream rule, preserving the original evidence rather than relaying unrestricted system authority.

Persist the original command, effect/idempotency identity and effective executor before attempting the owner write. After an uncertain result, retain those facts and request assertions pinned to that executor; never repeat under a replacement Principal or invent a different ordinary command. Each attempt obtains fresh audience-bound authority. Raw ingress API keys and incoming assertions are never persisted as retry credentials, and rotation of the original key does not itself cancel admitted work. A synchronous operation uses `RegisteredAdmission` only after its real admission Action commits; it does not create a fake worker delivery to obtain this capability.

For reconciliation after original write authority is withdrawn, the worker may use the narrow `RegisteredRecovery` path. Its lifetime-bound original-invocation fact reader checks only the saved permanent command identity and recorded job/run context, returning identity/status or absence. A matched receipt then receives a fresh, exact-input, Read-only assertion under a separately current recovery enrollment. The receiving owner constrains its minimal result to that signed original invocation and applies current Privacy/target rules. Missing facts remain bounded uncertainty; no recovery branch executes an Action, changes the saved command, or substitutes a new executor. See [registered workload gateway authority](./AUTHORIZATION.md#registered-workload-gateway-authority).

Source cancellation and erasure close Core's admission execution fence before purging source state. Registered owner Action transactions require that exact admission fence to remain OPEN and hold its shared lock through commit; cancellation waits under an exclusive lock. A worker claim or request-local continuation cannot outlive cancellation into a new owner effect. Exact authorized receipt Reads do not reopen the fence.

An explicitly enrolled `HistoricalDelivery` recovery Read uses its durable delivery/message/event/admission chain and exact original system job context in any genuine delivery state, including after settlement. This proves history, not a live worker or claim. The versioned public job payload must agree with the event subject and registered subscription. Conditional recovery derives its consuming worker from that native chain and current subscription; synchronous admission derives its consuming Action from the succeeded native admission and current public descriptor. Neither path borrows an ended local execution lease or invents a historical schema version. It never reactivates a claim, substitutes the admission identifier for the delivery run, or grants another write attempt.

The targeted Privacy dispatch consumer uses the separate finite human capability described in [Authorization](./AUTHORIZATION.md#finite-privacy-dispatch-authority). Its genuine handler context and native claim attest the delivery, while the original human and governance company remain the acting identity. A durable coordinator receipt lookup uses its explicit dispatch witness rather than recreating that handler context. Neither mode grants a general human Symmy gateway capability.

## Outcomes, Safety, and Observability

Worker execution is at-least-once. Handlers must be idempotent because a process can complete an external side effect and die before durable finalization. OntOS does not claim exactly-once external effects.

- Success finishes the attempt, marks the still-owned delivery `done`, clears claim fields, and advances an eligible checkpoint in one transaction.
- Failure finishes the attempt with bounded sanitized text and either returns the delivery to `pending` after descriptor-derived exponential backoff or marks it `dead` at the maximum attempt count.
- Only an operator moves a `dead` delivery on. A redrive returns it to `pending` with a fresh attempt budget; a release marks it `released`, which settles its composition completion debt without delivery. Both append to `core.outbox_delivery_resolutions`. See [Dead Outbox deliveries during a composition drain](./DEPLOYMENT.md#dead-outbox-deliveries-during-a-composition-drain).
- Payload decode failures, declared handler failures, unexpected defects, persistence failures, module-state failures, and lost claims remain distinct typed Effect failures. Stored errors and runtime telemetry contain no arbitrary payload, secret, raw Effect cause, stack, or database diagnostic. Core retains unexpected persistence causes only behind its private runtime boundary; they are not part of public failures or routine telemetry.

Runtime telemetry identifies the worker, consumer and producer modules, topic, tenant, message, delivery, attempt, correlation, and outcome. It never logs arbitrary message payloads.

### Durable external-projection completion

An owner may use the narrow worker completion publisher only to finish an external-projection saga
that a previously committed Action explicitly requested. The initiating Action persists the owner
intent and its self-outbox request atomically and reports a pending or reconciliation-required
outcome; it must not perform the external write or publish the terminal business fact.

The self-consuming owner Worker loads the intent by its opaque persisted identity under Core's
verified Legal Entity scope, applies the exact idempotent external mutation, then finalizes owner
state through a scoped routine. A completion definition is immutable and bound to the exact Worker,
owner/producer module, event type, topic, and payload schema. The lifetime-bound publisher accepts
only the persisted mutation UUID as completion identity and verifies that the originating Action is
durably succeeded in the same Tenant and Legal Entity. It persists the terminal Domain Event and
Outbox Message in the same transaction as the owner routine. It cannot publish as another module,
choose an arbitrary topic, receive a raw database executor, or broaden system-principal scope.

The mutation UUID is the idempotent completion Domain Event identity. After an ambiguous external
acknowledgement the Worker repeats only the same exact idempotent mutation. If the process stops
after the external mutation but before transaction commit, the durable pending intent remains. If
delivery acknowledgement is lost after commit, redelivery observes terminal owner state and the
existing identical completion; a different event, topic, scope, source Action, subject, timestamp,
or payload under that identity is a non-retryable conflict. The publisher does not make arbitrary
Worker state changes an Action substitute: it is limited to completing the already authorized,
durably requested external projection.

## Checkpoints

`worker_checkpoints` is mutable cursor state, not audit evidence. Its identity is tenant plus `consumer_name = workerKey` plus a stable producer/topic stream key. The cursor stores the linked Domain Event's `tenant_sequence_no` and advances only after successful delivery finalization.

Checkpoint advancement must not skip an earlier matching delivery in `pending`, `processing`, `dead`, or `released` state. Matching, claiming, decoding failure, handler failure, lease expiry, and dead-lettering never create or advance a checkpoint. Delivery finalization and checkpoint advancement are one transaction so neither can be observed without the other.

## Authorization inventory

Generated workers must declare `owner_local_background`; no other authorization class is valid for the `worker` role. The inventory checker reconciles the registered worker, its owner deployment, and its generated descriptor. Worker execution remains independently gated by the active tenant module state and exact owner-local registration. Report-only rollout never turns a missing owner, disabled module, unavailable state check, or foreign deployment into an allow.
