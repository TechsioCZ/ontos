# Outbox Worker Architecture

Outbox Workers are module-owned asynchronous entrypoints for committed Outbox Messages. Core owns matching, delivery state, leases, attempts, retries, dead letters, and checkpoints. A MicroVertical owns only its generated descriptor and private Effect handler.

## Process and dependency ownership

Every consuming MicroVertical exposes its workers as one generated Outbox Worker entry (`src/worker-host/entry.ts`): its claim-owner prefix, its closed worker layer, its private registrations, and their subscriptions. `startOutboxWorkerHost` runs a list of entries in one Node process; each entry keeps its own ManagedRuntime, polling loop, and claim owner, while Core supplies the generic polling and delivery runtime. Worker code therefore stays physically inside its owner and may require the owner's Effect repositories and services. The owner composes those requirements in its worker layer, using the same server-side capabilities available to its Actions; Core never imports or publishes the private implementations.

The same entries deploy two ways, chosen by the deploying environment's required `OUTBOX_WORKER_MODE` GitHub environment variable. The mode is independent of `DEPLOY_TARGET`: the Outbox Workers run on Zerops for both targets.

- `dedicated` (production): each owner's generated `src/worker-host/main.ts` hosts its one entry in its own `<owner>-worker` service, so owners deploy, scale and fail independently.
- `host` (stage, previews, demos): one Zerops service, `outbox-worker-host`, runs every owner's entry from `scripts/outbox-worker-host.generated.mts` in one cheap process. The planner (`--outbox-worker-mode host`) deploys it through `ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID` whenever any hosted owner is impacted, and the composition publisher restarts it instead of the dedicated consumers.

The variable has no default. A configured environment without it fails `deploy-target` before anything deploys, and the publisher fails on it too, so an environment never silently runs the other mode. Switching is one variable change followed by a deploy: set `OUTBOX_WORKER_MODE` on the environment and run its deploy. The deploy sees that the other mode's workers still run, or that this mode's do not (`active-composition:publish worker-mode-drift`), deploys every worker of the new mode, and stops the old mode's workers after the new ones are up. The scheduled composition refresh skips while that drift is pending. The `host` mode needs the `outbox-worker-host` service and its `ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID` variable; the `dedicated` mode needs each owner's worker service and variable.

`scripts/generate-outbox-worker-deployment.mjs` derives the dedicated worker setups, the `outbox-worker-host` setup, and the host entry from topology and worker-entry discovery, so no hand-kept list names the hosted owners.

Matching uses the complete schema-free subscription snapshot from the validated installed-module deployment catalog. Core's matcher receives that complete snapshot explicitly and creates deliveries before independently deployed owner processes claim them. Each hosted loop holds only its own owner's private registrations and must prove they match its deployment descriptors. No generator scans unrelated vertical source or rewrites a shared source-time subscription registry. This split prevents the first polling process from marking a message with only its local handlers and starving other independently hosted consumers.

`scaffold:outbox-worker -- --authorization owner_local_background` creates the owner's worker layer, entry, `main.ts` and `worker:start` script when needed; then run `mise exec -- node scripts/generate-outbox-worker-deployment.mjs --write` to add the owner's dedicated worker and add it to the host. Run the host alone with `mise exec -- pnpm dev:outbox-worker-host`; the normal `mise exec -- pnpm dev` command starts it alongside the applications. The host has one `SIGINT`/`SIGTERM` handler and one `/ready` endpoint on `OUTBOX_WORKER_HEALTH_PORT` that is ready only while every hosted loop has completed a recent successful cycle. If any loop fails, the host interrupts the others, disposes every runtime, and exits non-zero. Each loop performs one cycle immediately and then polls every 1,000 ms. These optional scalar environment values may override the safe defaults for a deployment:

- `OUTBOX_WORKER_POLL_INTERVAL_MS` — interval from 10 through 3,600,000 ms; default `1000`.
- `OUTBOX_WORKER_MAX_DELIVERIES` — maximum deliveries claimed per cycle from 1 through 1,000; default `100`.
- `OUTBOX_WORKER_PROCESS_IDENTITY` — stable process identity; the process derives one from its process ID and a random process nonce by default. It only fills the suffix of each loop's `<owner prefix>:<process identity>` claim owner (at most 200 characters), so hosted loops never share a claim owner.

Invalid values fail process startup instead of silently selecting an unsafe cadence. CI proves the deployable host on every change: `scripts/prove-outbox-worker-host-artifact.sh` materializes it with its `zerops.yaml` build command, runs its real start command against the freshly migrated database until `/ready`, and requires a clean exit on `SIGTERM`. `SIGINT` and `SIGTERM` interrupt every polling fiber and release each loop's scoped PostgreSQL pool. Multiple instances are safe because matching is idempotent and delivery claiming is lease-protected; handler effects remain at-least-once and must still be idempotent.

## Published Contract Boundary

- A producer publishes one schema-only package subpath per exact topic. It contains the Effect payload schema, producer module key, and topic constant—never an Action, factory, repository, handler, transport, database client, or BFF implementation.
- Producer, consumer, and worker ownership use dotted OntOS module IDs. Deployment app IDs are not Outbox business identities.
- A consumer imports that published subpath and its own Core descriptor API. It never deep-imports another MicroVertical's source or executes another MicroVertical's implementation.
- Generate producer messages with `mise exec -- pnpm scaffold:outbox-message` and consumers with `mise exec -- pnpm scaffold:outbox-worker -- --authorization owner_local_background`. Generated worker registries stay server-side and are not Module Federation or BFF surfaces.

## Immutable Matching

An Outbox Message is an immutable broadcast source linked to one committed Domain Event. At first observation, Core matches the message against the complete installed subscription catalog by exact producer module and exact topic. In one transaction it creates at most one delivery per message and worker and sets `matched_at`, including when no workers match. Re-observation is idempotent. Deploying a new worker does not backfill already matched messages in V0. Each process also verifies that every owner-local registration has an identical catalog entry before it can match or claim work.

Each Worker declares a structured tenant `worker`/`background` entrypoint governed by [Module Entrypoints and Tenant State](./MODULE_ENTRYPOINTS.md). Claim eligibility uses the central matrix inside the existing atomic claim query. Only `active` consumers are eligible; every other or missing state leaves work unattempted and retryable. The producer's current module state never authorizes the consumer entrypoint, and handler resolution occurs only after an eligible claim.

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

## Outcomes, Safety, and Observability

Worker execution is at-least-once. Handlers must be idempotent because a process can complete an external side effect and die before durable finalization. OntOS does not claim exactly-once external effects.

- Success finishes the attempt, marks the still-owned delivery `done`, clears claim fields, and advances an eligible checkpoint in one transaction.
- Failure finishes the attempt with bounded sanitized text and either returns the delivery to `pending` after descriptor-derived exponential backoff or marks it `dead` at the maximum attempt count.
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

Checkpoint advancement must not skip an earlier matching delivery in `pending`, `processing`, or `dead` state. Matching, claiming, decoding failure, handler failure, lease expiry, and dead-lettering never create or advance a checkpoint. Delivery finalization and checkpoint advancement are one transaction so neither can be observed without the other.

## Authorization inventory

Generated workers must declare `owner_local_background`; no other authorization class is valid for the `worker` role. The inventory checker reconciles the registered worker, its owner deployment, and its generated descriptor. Worker execution remains independently gated by the active tenant module state and exact owner-local registration. Report-only rollout never turns a missing owner, disabled module, unavailable state check, or foreign deployment into an allow.
