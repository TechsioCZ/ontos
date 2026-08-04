# Outbox Worker Architecture

Outbox Workers are module-owned asynchronous entrypoints for committed Outbox Messages. Core owns matching, delivery state, leases, attempts, retries, dead letters, and checkpoints. A MicroVertical owns only its generated descriptor and private Effect handler.

## Process and dependency ownership

Each consuming MicroVertical runs its workers in a dedicated Node process. The process imports only
that MicroVertical's generated server-side registry, while Core supplies the generic polling and
delivery runtime. Worker code therefore stays physically inside its owner and may require the
owner's Effect repositories and services. The owner composes those requirements in its worker
layer, using the same server-side capabilities available to its Actions; Core never imports or
publishes the private implementations.

Matching uses the complete schema-free installed subscription catalog generated at
`packages/core-runtime/src/outbox/subscriptions.generated.ts`. Every process reads the same
catalog, while it claims and executes only registrations from its owning MicroVertical. The
Codesmith worker generator updates this catalog atomically with the private worker, and the
workspace contract gate verifies that the catalog exactly matches all generated worker markers.
This split prevents the first polling process from marking a message with only its local handlers
and starving other independently hosted consumers.

`scaffold:outbox-worker` creates the owner-local process host and adds `dev:worker` and
`worker:start` scripts to the consumer package when needed. Run one consumer with
`mise exec -- pnpm --filter @app/<consumer> worker:start`; the normal `mise exec -- pnpm dev`
command starts every generated worker host alongside the applications. Each process performs one
cycle immediately and then polls every 1,000 ms. These optional scalar environment values may
override the safe defaults for a deployment:

- `OUTBOX_WORKER_POLL_INTERVAL_MS` — interval from 10 through 3,600,000 ms; default `1000`.
- `OUTBOX_WORKER_MAX_DELIVERIES` — maximum deliveries claimed per cycle from 1 through 1,000;
  default `100`.
- `OUTBOX_WORKER_CLAIM_OWNER` — stable process identity up to 200 characters; the process derives
  one from the MicroVertical, process ID, and a random process nonce by default.

Invalid values fail process startup instead of silently selecting an unsafe cadence. `SIGINT` and
`SIGTERM` interrupt the polling fiber and release the scoped PostgreSQL pool. Multiple instances
are safe because matching is idempotent and delivery claiming is lease-protected; handler effects
remain at-least-once and must still be idempotent.

## Published Contract Boundary

- A producer publishes one schema-only package subpath per exact topic. It contains the Effect payload schema, producer module key, and topic constant—never an Action, factory, repository, handler, transport, database client, or BFF implementation.
- A consumer imports that published subpath and its own Core descriptor API. It never deep-imports another MicroVertical's source or executes another MicroVertical's implementation.
- Generate producer messages with `pnpm scaffold:outbox-message` and consumers with `pnpm scaffold:outbox-worker`. Generated worker registries stay server-side and are not Module Federation or BFF surfaces.

## Immutable Matching

An Outbox Message is an immutable broadcast source linked to one committed Domain Event. At first
observation, Core matches the message against the complete installed subscription catalog by exact
producer module and exact topic. In one transaction it creates at most one delivery per message
and worker and sets `matched_at`, including when no workers match. Re-observation is idempotent.
Deploying a new worker does not backfill already matched messages in V0. Each process also verifies
that every owner-local registration has an identical catalog entry before it can match or claim
work.

Each delivery belongs to the consuming module. Worker dispatch is allowed only while that tenant's consuming module state is `active`. Missing, inactive, read-only, suspended, quarantined, deprecated, and archived states leave work unattempted and retryable. The producer's current module state never authorizes the consumer entrypoint.

## Claims and Attempts

Core claims an eligible delivery transactionally with a unique claim identity and expiry, changes it to `processing`, increments its attempt count, and creates one unfinished attempt before handler execution. Concurrent dispatchers use lock-safe selection so only one live claim executes. A later dispatcher may reclaim only an expired lease; reclaiming finishes the abandoned open attempt with a safe error before starting the next attempt. A stale claimant can never finalize a newer claim.

The handler receives decoded payload data and a restricted context containing message, delivery, Domain Event, tenant sequence, producer/topic, correlation, attempt, worker, and claim identities. It receives no raw database executor. Payload decoding and handler execution happen outside the claim transaction.

## Outcomes, Safety, and Observability

Worker execution is at-least-once. Handlers must be idempotent because a process can complete an external side effect and die before durable finalization. OntOS does not claim exactly-once external effects.

- Success finishes the attempt, marks the still-owned delivery `done`, clears claim fields, and advances an eligible checkpoint in one transaction.
- Failure finishes the attempt with bounded sanitized text and either returns the delivery to `pending` after descriptor-derived exponential backoff or marks it `dead` at the maximum attempt count.
- Payload decode failures, declared handler failures, unexpected defects, persistence failures, module-state failures, and lost claims remain distinct typed Effect failures. Stored errors and runtime telemetry contain no arbitrary payload, secret, raw Effect cause, stack, or database diagnostic. Core retains unexpected persistence causes only behind its private runtime boundary; they are not part of public failures or routine telemetry.

Runtime telemetry identifies the worker, consumer and producer modules, topic, tenant, message, delivery, attempt, correlation, and outcome. It never logs arbitrary message payloads.

## Checkpoints

`worker_checkpoints` is mutable cursor state, not audit evidence. Its identity is tenant plus `consumer_name = workerKey` plus a stable producer/topic stream key. The cursor stores the linked Domain Event's `tenant_sequence_no` and advances only after successful delivery finalization.

Checkpoint advancement must not skip an earlier matching delivery in `pending`, `processing`, or `dead` state. Matching, claiming, decoding failure, handler failure, lease expiry, and dead-lettering never create or advance a checkpoint. Delivery finalization and checkpoint advancement are one transaction so neither can be observed without the other.
