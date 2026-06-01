# Authentication and authorization model

OntOS should separate authentication, principal modeling, relationship authorization, and business policy.

## Authentication

BetterAuth is the proposed authentication/session layer. Its responsibility is login, sessions, authentication methods, and developer experience around user authentication. OntOS should not make BetterAuth the only source of business authorization semantics.

An authenticated BetterAuth user is mapped to an OntOS principal. The OntOS principal is the identity used in audit, authorization, and action execution.

## Principal model

A principal is an actor in the system. The principal kind can be internal user, external operator user, guest user, agent, service account, integration, or system. V0 may only use human users and basic integration/service principals in production, but the model should include agent principals as a foundation.

Agent principals do not imply autonomous agent product features in V0. They simply keep the actor model future-proof and make it possible to audit system/non-human actions consistently.

## Tenant and legal-entity context

Every action and read should execute inside a tenant context. Many actions also execute inside a legal-entity context. Tenant is the top-level isolation boundary. Legal entity is the managed accounting or operating company scope inside the tenant. External managers, guests, accountants, suppliers, and other counterparties are Parties or Principals with scoped access; they are not automatically tenant legal entities.

Tenant leakage is a critical defect. It should be tested explicitly.

## Relationship-based authorization

SpiceDB is the fine-grained authorization system. In V0 it should stay coarse and security-critical: tenant membership, legal-entity roles, module access, admin/support powers, accounting/export powers, and explicit grants to sensitive resources.

SpiceDB should not mirror every business ontology edge. Business relationships and authorization relationships overlap but are not the same thing.

## OntOS Policy Layer

The Policy Layer handles conditions that are not pure relationship authorization. Examples: module suspended, module read-only, accounting period locked, invoice already exported, document sensitivity, amount threshold, approval required, action disabled by feature flag, or tenant over package limit.

The normal write path is authentication, principal resolution, context resolution, module state check, SpiceDB permission check, policy check, command execution.

## Read and search authorization

Reads need the same seriousness as writes. Entity detail reads can run explicit checks. Search is more difficult because result sets can be large. V0 should use tenant/legal-entity/module/access-class scoping for search documents and explicit authorization checks for sensitive results.

A naive search implementation that calls SpiceDB once per result can become a latency and cost problem. The architecture should include permission projections or coarse prefilters for common searches.

## View as principal

For debugging and support, the system may later support “view as principal” for admins. This should not be treated as actual login as another user/agent. It should be read-only or explicitly controlled, and it must audit original principal, viewed principal, reason, and timestamp.

## Consistency with SpiceDB

Not every business write should synchronously write to SpiceDB. V0 should keep SpiceDB relationships relatively coarse and should not mirror the whole business ontology. Business entity access can often be evaluated through tenant/legal-entity/module scope plus policy, rather than one SpiceDB tuple per ordinary entity.

Role and access changes are security-critical and should fail closed if SpiceDB cannot be updated. Derived or helper relationships can be projected asynchronously if introduced later.
