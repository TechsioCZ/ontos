# Action Ecosystem

OntOS public backend work should enter through CoreSDK. A MicroVertical may own
the route, API contract, descriptor, handler, and tests, but the invariant
runtime flow belongs to Core.

## Runtime Responsibilities

- BFF adapters receive typed transport input and call CoreSDK. They should not
  run handlers directly, open top-level transactions, call SpiceDB directly, or
  write Core evidence tables directly.
- Action Descriptors declare the public runtime contract: action key, gateway
  audience, module-state access, idempotency rule, audit profile, optional
  SpiceDB requirement, optional Domain Event descriptor, and transport schemas.
- Action Registrations bind descriptors to private handlers and policy checks.
  Registrations are server-only.
- Handlers receive typed input plus Core-owned execution services after CoreSDK
  verifies the trusted operation Actor is an active Principal in the operation
  tenant and the idempotency, module-state, authorization, and policy gates pass.
- A successful required-idempotency Action persists its response with the
  invocation. The same Actor, Action, key, and input replay that exact response;
  different input conflicts. The same identity may atomically claim and retry a
  prior execution failure; an in-flight or rejected invocation is not replayable.
- Data-access registrations use CoreSDK for governed reads, lists, searches,
  exports, and downloads. Metadata-only evidence is the default posture for
  high-volume reads.
- Data-access authorization and policy audit rows use `data_access.*` event
  names so governed reads are distinguishable from write Actions.
- Domain Events are committed facts. Outbox Messages are delivery records
  attached to Domain Events, not independent business commands.
- Outbox Workers subscribe to topics through descriptors and run in the worker
  runtime against per-worker delivery rows.

## Module-State Gates

The shell load gate and CoreSDK operation gates are separate.

- The shell gate protects Module Federation entrypoints with `load` access.
- CoreSDK protects backend action and data-access execution with the
  descriptor-declared access kind.
- Outbox worker execution checks the consumer module's `mutate` access.

Current access matrix:

- `active`: `load`, `read`, `mutate`
- `read_only`: `load`, `read`
- `deprecated`: `load`, `read`, `mutate`
- `inactive`, `suspended`, `quarantined`, `archived`: no access

## Error Status Mapping

Use the CoreSDK status helper when adapting operation outcomes to strict Effect
API schemas.

- Auth/context errors: `401`
- Authorization and module-state denials: `403`
- Missing idempotency key: `428`
- Idempotency conflict, replay unavailable, policy denial, domain rejection:
  `409`
- Persistence and execution failures: `500`

If validation becomes a distinct CoreSDK outcome, map it to `422`.

## Test Fixtures

Use test fixture Actions and data-access registrations to prove ecosystem
behavior without designing product semantics. A good fixture uses a tiny payload
and handler, then verifies observable CoreSDK behavior: typed outcome, handler
invocation or non-invocation, durable evidence, Domain Event and Outbox Message
records, or worker delivery state.

Test through the highest public seam available:

- `runAction` for write Actions and gates.
- `runDataAccess` for governed reads.
- `runOutboxWorkerTick` for worker materialization, claiming, and execution.
- API adapter helpers for transport status mapping.

## Still Out Of Scope

- Concrete business Actions.
- Access-management Actions that mutate SpiceDB relationships.
- External queue systems.
- Full OntOS Module Manifest generation.
