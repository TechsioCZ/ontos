# Module Entrypoints and Tenant State

Entrypoint `tenant`/`system` scope is independent from the descriptor's required/optional/forbidden
legal-entity scope. Both must be explicit. Missing, malformed, denied, or indeterminate operation
context fails closed before private implementation resolution as defined by
[Governed Data Access and Operation Scope](./DATA_ACCESS.md).

This document defines the Core-owned invariant for loading or dispatching OntOS Business Module
entrypoints. It applies to Actions, pages, public components, module APIs, search providers,
reports, and Outbox Workers. The gate is separate from authentication, SpiceDB authorization, and
business Policy; passing module state never grants another kind of access.

## Structured entrypoints

Every entrypoint is an immutable Effect Schema-backed value containing a stable entrypoint key,
owning module key, role, access class, and explicit scope.

| Role                                 | Permitted access                                             |
| ------------------------------------ | ------------------------------------------------------------ |
| `action`                             | `write`                                                      |
| `worker`                             | `background`                                                 |
| `page`, `public_component`, `search` | `read` or an explicit `historical_read`                      |
| `api`, `report`                      | an explicitly selected `read`, `historical_read`, or `write` |

Tenant entrypoints are created only with the tenant constructor. Core capabilities use the system
constructor explicitly; a `core.*` prefix does not imply a bypass. A system entrypoint bypasses
tenant module-state acquisition only and still passes every applicable authentication,
permission, Policy, transaction, and evidence control.

Descriptors and private implementations are different surfaces. Public descriptors may be
imported through approved package exports. Private handlers, routes, Worker registrations,
search/report implementations, and vertical tables remain owner-local. A gateway accepts a
deferred Effect or loader thunk; it never receives an eagerly resolved private implementation.

## Authoritative matrix

| Tenant state  | `read` | `historical_read` | `write` | `background` |
| ------------- | -----: | ----------------: | ------: | -----------: |
| `active`      |  allow |             allow |   allow |        allow |
| `read_only`   |  allow |             allow |    deny |         deny |
| `deprecated`  |  allow |             allow |    deny |         deny |
| `inactive`    |   deny |             allow |    deny |         deny |
| `suspended`   |   deny |             allow |    deny |         deny |
| `quarantined` |   deny |              deny |    deny |         deny |
| `archived`    |   deny |             allow |    deny |         deny |
| missing row   |   deny |              deny |    deny |         deny |

This is the only matrix. Runtime adapters call the Core decision function instead of maintaining
local state lists. `historical_read` is explicit and never a fallback from a denied normal read.
Normal Shell navigation includes installed, authorized `active`, `read_only`, and `deprecated`
modules. The latter two remain readable and visibly non-writable. Definite permission denial omits
normal navigation; authorization uncertainty preserves an otherwise eligible item as disabled.

Missing state is a definite denial. An unavailable database read, malformed persisted state,
undeclared snapshot key, absent trusted tenant context, or other indeterminate check is a
sanitized typed unavailable failure. Core is transport-neutral. Public BFFs normally map definite
denial to declared `403` Problem Details and check unavailability to a retryable declared `503`.

## Request snapshots and query budget

At a trusted Shell, SSR, route, or BFF boundary, collect every descriptor the request may use,
deduplicate and sort its tenant module keys, read them in one indexed query, decode each state once,
and create an immutable request snapshot covering the exact key set. Every later decision is pure
in-memory evaluation. Undeclared keys fail closed without an implicit lookup. Empty and system-only
compositions perform no state query.

| Runtime composition                                                    | Module-state database work                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| One Shell/SSR/page composition with any number of declared entrypoints | At most one batch query for all distinct tenant module keys  |
| Repeated decisions from one request snapshot                           | Zero additional queries                                      |
| Explicit Core system entrypoints                                       | Zero tenant-module-state queries                             |
| One independently deployed BFF request                                 | At most one batch query for that request composition         |
| One business Action attempt                                            | One early indexed read plus one transaction-aware recheck    |
| One Outbox Worker claim cycle                                          | Zero additional queries beyond the existing claim query/join |

Snapshots are request-scoped, never process-global, browser-authoritative, TTL-based, or
distributed caches. The next independent request observes state again. A Shell decision does not
replace the independent BFF or Action check at the next trust boundary. Telemetry may contain batch
size, acquisition duration, snapshot reuse, scope, access, and outcome, but not payloads,
credentials, raw persistence causes, or private implementation identifiers.

## Runtime ordering

Actions validate payload and trusted context, acquire/check state, and only then hash the request,
create an invocation, call SpiceDB, evaluate Policies, or resolve the handler. A business Action
rechecks `write` under the Core transaction after locking its invocation and tenant and before
collector creation or handler resolution. A pre-invocation denial creates no evidence. A locked
recheck failure rolls back and leaves the invocation open for existing retry semantics. The
explicit system entrypoint for `core.modules.change-tenant-module-state` remains recoverable.

Outbox claim eligibility evaluates the consumer with `background` semantics inside the existing
atomic claim query. Producer state never authorizes a consumer. Ineligible or missing state leaves
delivery pending with no claim or attempt. Private Worker handler resolution follows a successful
eligible claim.

Page/public-component composition uses the approved Shell lazy adapter: collect the full descriptor
set, prepare one snapshot, evaluate every load, then call loader thunks. Raw `loadRemote(...)`
strings, eager remote imports, and one state request per component are forbidden. Module APIs need
verified trusted tenant context and the server gateway; write APIs delegate to registered Actions.

The Shell first establishes exactly one trusted tenant and active legal entity. Composition then
uses one tenant-state batch and one module-permission batch. Every direct target independently
rechecks installation/reference, selected context, lifecycle, and permission before a generated
lazy registry is consulted. Only a `resolved` outcome may execute a remote thunk.

Generated exact page routes may use safe canonical named-parameter templates such as
`/projects/customers/:id/edit`; their owner and Shell filesystem routes use `[id]`. Dynamic templates are
not normal navigation items. The generated connector selects only its declared parameter names and
bounds each string value before calling the generic page loader. The generic loader keeps that plain
record separate from the resolved target and never adds it to the module contract, target-resolution
BFF input, trusted principal context, tenant/legal-entity context, module-state gate, or permission
decision. Only after authentication, legal-entity selection, exact page resolution, lifecycle and
permission success, approved lazy-client lookup, and successful remote loading may the Shell pass
the record to the owner component. The owner treats every value as untrusted business input and
validates it again before any domain read or Action.

Search filters safe providers through the same context/state/module checks, then bulk-filters
ResourceRefs by resource permission. Core repeats result-level resource authorization before a
generated provider response can leave the receiving BFF. Zero providers/results is successful,
mixed provider success is partial `200`, and total provider failure is retryable. Resource detail
and timeline providers run only after catalog/type/state/module/resource gates and a fresh
audience-scoped assertion for each attempt. Media attachment remains unavailable even when declared
in a manifest until Codesmith generates and registers its Action; no provider mutation callback is
part of the read gateway.

## Generator and registration enforcement

Codesmith output is the starting point for Actions, MicroVertical pages, and Workers and includes
the governed descriptor. Worker catalogs and route manifests preserve it. Vertical Runtime
Registration reserves private lazy bindings for public components, search, and reports beside
direct typed public descriptors.

API, public-component, search, and report business artifacts may not be introduced until an
approved generator can patch registration atomically and an approved gateway adapter exists.
Extend Codesmith first with disposable compile, overwrite, traversal, and no-partial-write tests.
Repository checks reject missing/mismatched registration, raw remote loads, private cross-vertical
imports, direct private handler access, and public exports of private implementations.
