# Commerce Application Boundaries

This document is the authoritative app-local implementation boundary for OntOS Commerce application surfaces. It applies with [MicroVertical Architecture](./MICROVERTICALS.md), [OntOS Module Manifests](./MODULE_MANIFESTS.md), [Module Entrypoints](./MODULE_ENTRYPOINTS.md), [Action Execution](./ACTIONS.md), [Outbox Workers](./OUTBOX_WORKERS.md), and [Deployment](./DEPLOYMENT.md).

The accepted product decision is [ADR-0017](../../../docs/adr/0017-commerce-application-boundaries.md). Canonical vocabulary is defined in [`docs/contexts/ontos/CONTEXT.md`](../../../docs/contexts/ontos/CONTEXT.md) and [`docs/contexts/commerce/CONTEXT.md`](../../../docs/contexts/commerce/CONTEXT.md).

## Application inventory

| Application/edge               | Deployment and ownership                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storefront Application**     | External to the standard OntOS Shell deployment. Owns framework, routes, rendering, layout, interaction, branding, assets, and SEO. A customer may have separate B2C/B2B storefronts.  |
| **Storefront-local BFF/proxy** | Deployed with one storefront. Holds its Storefront Client credential server-side, provides a same-origin browser edge, and performs presentation-oriented request shaping/aggregation. |
| **Commerce Storefront API**    | Thin OntOS channel edge over public Commerce module contracts. Authenticates, resolves trusted Commerce Purchasing Context, authorizes, translates, aggregates bounded reads, and invokes governed Actions. |
| **Commerce Operations**        | Purpose-built staff application over published MicroVertical clients and governed entrypoints. Uses staff authentication; owns no canonical commerce facts.                            |
| **Agentic Shopping Adapter**   | Future peer channel adapter over native Commerce contracts, for example MCP or UCP. It is not implemented by this decision.                                                            |

Shell/Core remains business-neutral. Do not add commerce orchestration, Commerce Portal Account lifecycle, Storefront rendering, provider mapping, or Commerce Operations workflows to Shell/Core merely because several modules or channels need them.

## Storefront request boundary

Every Storefront Application receives a distinct tenant-bound Storefront Client service Principal and rotatable credential. The credential stays in the storefront-local BFF/proxy and never enters a browser bundle. A Storefront Client identifies the application only; it never grants customer access.

The Commerce Storefront API independently validates:

1. the Storefront Client and its Tenant/Channel Permissions; and
2. either a Commerce Portal Account session/token resolving to the required Retail Portal Principal or B2B Principal, or a bounded Guest Purchase Context.

A Tenant, Storefront Client, Commerce Portal Account, Party Relationship, selected context, Commerce Customer Profile, or Counterparty ResourceRef alone is not authorization. B2B requests require the exact current Principal-to-Counterparty Commerce Access Permission. Guest Purchase Context cannot read durable portal history or Counterparty-specific commercial facts.

The Commerce Storefront API may:

- resolve trusted Tenant, application, Commerce Purchasing Context or Guest Purchase Context, Channel, locale, market, and correlation context;
- authorize each requested governed read or Action against its exact Principal, subject, Permission, and scope;
- translate a public Channel contract;
- aggregate bounded public reads while retaining provenance and typed partial degradation; and
- invoke Actions only through the same generated/gateway path used by other callers.

It must not:

- own canonical commerce tables or a duplicate read/write model presented as truth;
- import owner registrations, repositories, handlers, migrations, private services, or private schemas;
- execute shared cross-module database transactions or synchronous dual writes;
- own durable workflow, retry, reconciliation, or provider state;
- infer customer identity or Permission from Contact Points, Party Relationships, selected context, or account state; or
- become a universal BFF for staff, integrations, or future agents.

## Native contracts and Medusa compatibility

Native module-owned Commerce contracts are authoritative. A temporary Medusa Store Compatibility Facade may translate only the Store API routes/shapes required by existing `new-engine` hooks.

For every compatibility route, record:

- the native read/Action contracts it invokes;
- supported request/response fields and deliberate semantic differences;
- authentication and error mapping;
- cache and idempotency behavior;
- telemetry identifying compatibility traffic; and
- retirement criteria and the native replacement.

The facade cannot introduce a Medusa runtime, database schema, workflow engine, package/source derivative, administration component, or owner-specific business rule. New native Storefront or Agentic Shopping clients must target native contracts unless a reviewed delivery exception says otherwise.

## Separate BetterAuth realms

Shell owns the staff BetterAuth realm described in [MicroVertical Architecture](./MICROVERTICALS.md): staff accounts, cookies, sessions, Tenant/Legal Entity selection, staff API keys, gateway assertions, and support impersonation.

Commerce owns a separate BetterAuth realm for Commerce Portal Account registration and authentication. It has separate configuration, schema/migrations, cookies, session namespace, signing/secrets, origin, rate limits, account verification/recovery, and lifecycle. Commerce Portal Accounts never enter the staff Auth schema or receive staff session semantics.

Commerce maps a Commerce Portal Account through owner-local bindings to a tenant-scoped Principal and stable Party/Counterparty ResourceRefs. Retail persistent capabilities additionally require an explicit Retail Portal Profile Binding; B2B capabilities require explicit Principal-to-Counterparty Commerce Access. Party Registry remains the shared identity owner; Commerce owns portal enrollment and contextual Commerce profiles. Publish only non-secret lifecycle facts for authorized Contacts, support/ticketing, and analytics projections. Never emit credentials, tokens, cookies, password material, claim secrets, or unrestricted identity payloads.

Registration, matching Contact Points, Party correction/merge, account ownership, or selected context must never silently create a Retail Portal Profile Binding, claim a guest Order, or grant Counterparty Commerce Permission.

## Commerce Operations

Commerce Operations is separate from Shell navigation/layout and from external Storefront Applications, but it uses the staff authentication boundary. It composes focused Order, Purchasing Approval, Fulfillment, Claim, reconciliation, recovery, and Assisted Support workflows through published typed clients and governed entrypoints.

It must preserve owner-local validation, Permission, Business Policy, Action, audit, evidence, and failure semantics. It cannot directly edit module tables, import private implementation, bypass module state/dependency closure, silently impersonate a Commerce Portal Account or customer Principal, or become a second orchestration/fact owner.

## Customer Configuration and implementations

Customer Configuration declaratively selects permitted modules and explicit implementations:

- `moduleId` is the Module Contract Identity and owns public capability semantics.
- `implementationId` identifies one catalogued executable implementation, for example `standard` or `akros`.
- `appId` remains the independently deployable topology identity and exact gateway audience.

Two implementations may share `moduleId` only while public semantics and compatibility contract remain the same. Different semantics require a different `moduleId`. Every implementation records immutable build revision/digest, public-contract hash/version, migration set, owner, health, and readiness. The catalog rejects missing, duplicate, ambiguous, incompatible, or invisible implementation identities.

This identity/selection model is accepted target architecture. The current generated manifest and Installed Module Catalog do not yet implement `implementationId`; they support one implicit `standard` implementation per `moduleId`. Do not hand-author fields or customer branches as a substitute. Extend Codesmith, Effect Schemas, serialized contracts, topology/allowlist validation, Customer Configuration resolution, and tests as one change before adding an alternative.

Prefer shared behavior plus Business Policy. Add an implementation alternative only when an ordinary reusable capability cannot express the required behavior without distorting its contract. Never patch an implementation per customer under the same identity, and never move the exception into Shell/Core.

## Delivery and external systems

Customers do not pin whole-product release lines. OntOS controls continuous mainline promotion of immutable artifacts. Contract compatibility, expand/deploy/contract sequencing, Tenant/client canaries, exact revision evidence, and rollback remain mandatory.

For each External Business System and fact family, configure exactly one Integration Route: One-time Migration, Symmy Route, or Direct Provider Route. Symmy is preferred where it supplies the required business-system integration; owner-local Direct Provider Adapters cover provider families outside Symmy or missing routes. Module-owned workers retain durable delivery, mapping, retry, reconciliation, and evidence. No route becomes a universal gateway or fact owner.

## Required proof

Before production activation, prove:

- Storefront Client credentials are server-held, rotatable, Tenant-bound, and isolated per frontend;
- application identity and Commerce Portal Account/Guest identity are independently validated and audited;
- staff and Commerce Portal Account realms cannot share accounts, cookies, sessions, origins, or bindings accidentally;
- Retail Portal Profile Binding and Principal-to-Counterparty Commerce Access cannot be inferred from registration, Contact Points, Party Relationships, or selected context;
- Guest Order visibility cannot be claimed automatically by registration or identity similarity;
- Guest, B2C, Counterparty Buyer/Approver/Access Administrator, narrower Counterparty Permissions, and Assisted Support checks fail closed;
- Purchase Approval Requests require both current Counterparty Approver Permission and current Approval Route eligibility;
- approved Purchase Proposal Revisions cannot bypass Approval Revalidation or Order Commitment Gate;
- the Medusa facade matches its declared subset and native clients do not depend on it accidentally;
- dependency failures produce typed partial degradation without unrelated outage;
- Customer Configuration resolves one permitted, healthy implementation for every selected contract;
- contract/build skew is rejected and canary/rollback identifies exact artifacts;
- Party/Counterparty linking and lifecycle events contain no credentials or cross-Tenant leakage; and
- every Integration Route demonstrates idempotency, retry, reconciliation, observability, and recovery.
