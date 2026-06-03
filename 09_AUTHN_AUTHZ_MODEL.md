# Authentication and authorization model

OntOS should separate authentication, principal modeling, relationship authorization, and business policy.

## Authentication

BetterAuth is the proposed authentication/session/API key layer. Its responsibility is login, sessions, authentication methods, API key lifecycle and verification, and developer experience around user authentication. OntOS should not make BetterAuth the only source of business authorization semantics.

An authenticated BetterAuth user, API key, or organization-owned key is resolved through a Core principal auth binding to an OntOS principal. The OntOS principal is the identity used in audit, authorization, and action execution.

## Principal model

A principal is an actor in the system. The principal kind can be internal user, external operator user, guest user, agent, service account, integration, or system. V0 may only use human users and basic integration/service principals in production, but the model should include agent principals as a foundation.

Agent principals do not imply autonomous agent product features in V0. They simply keep the actor model future-proof and make it possible to audit system/non-human actions consistently.

## Principal auth bindings

`CORE_PRINCIPAL_AUTH_BINDINGS` maps an authenticated external subject to an OntOS principal. It is not a credential table. BetterAuth owns user records, sessions, API keys, API key verification, expiration, rate limits, and admin-created impersonation sessions. Core only stores the non-secret binding required to answer: "which OntOS principal is acting now?"

The table should contain stable identity bindings, not runtime credentials. A BetterAuth session, session token, raw API key, or one-off support impersonation session should not be stored here.

Suggested columns:

- `principal_auth_binding_id`: Core primary key for the binding row.
- `tenant_id`: tenant boundary for the binding.
- `principal_id`: the OntOS principal the external subject resolves to.
- `provider`: external authentication namespace, initially `better_auth`. System jobs do not need an auth binding.
- `subject_type`: the kind of stable provider subject. V0 should use `user` and `api_key`.
- `provider_subject_id`: the opaque external id from the provider. For BetterAuth `subject_type=user` this is the BetterAuth user id. For `subject_type=api_key` this is the BetterAuth API key id, never the raw key.
- `status`: whether the binding is active, disabled, or revoked.
- `created_at`, `updated_at`, `revoked_at`: lifecycle timestamps for auditability.

`subject_type=user` means a BetterAuth user account resolves to an OntOS principal. This covers password login, OAuth login, SSO, passkeys, and any other login method that BetterAuth normalizes into the same user. Individual sessions are runtime facts and should be captured on actions/audit only if there is a safe non-secret session id worth keeping.

`subject_type=api_key` means a BetterAuth API key resolves to an OntOS principal. The principal can be a service or integration principal, which is usually cleaner for durable automation, or in simple cases the human principal that created the key. Either way, audit should still record `auth_method=api_key` so an API-driven action is distinguishable from an interactive session.

Organization-owned API keys should still be represented as `subject_type=api_key`; the authenticated credential is the key. The BetterAuth organization owner is provider context, not the OntOS actor by itself. If the organization-owned key represents a shared integration, bind it to a dedicated integration principal.

System jobs should use `CORE_PRINCIPALS.kind = system` or `service` and write `auth_binding_id = null`, `auth_method = system`, and a non-secret `auth_context_ref` such as `job:outbox-dispatcher` or a run id. They should not create fake external auth bindings.

Support/admin impersonation is also not a subject type. BetterAuth can create an impersonation session for the target user; Core should resolve the target user's binding as the effective `principal_id`, and store the original admin in `impersonated_by_principal_id`.

`CORE_ACTION_INVOCATIONS`, `CORE_AUDIT_EVENTS`, and read/access logs should capture the resolved `principal_id`, optional `auth_binding_id`, `auth_method`, non-secret `auth_context_ref`, and optional `impersonated_by_principal_id`. This preserves the difference between the effective actor, the authentication path, and the original authenticated actor when support/admin impersonation is used.

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

Reads need the same seriousness as writes. Resource detail reads can run explicit checks. Search is more difficult because result sets can be large. V0 should use tenant, legal-entity, module, and resource-type scoping for search documents, then authorize candidate results through SpiceDB using `LookupResources` or `CheckBulkPermissions` depending on result shape.

Search authorization should not introduce a separate OntOS sensitivity or visibility abstraction unless a concrete product policy requires it. Start with SpiceDB-backed list filtering; add a materialized permission view only if measured result size, latency, or traffic justifies it.

## View as principal

For debugging and support, the system may later support “view as principal” for admins. This should not be treated as actual login as another user/agent. It should be read-only or explicitly controlled, and it must audit original principal, viewed principal, reason, and timestamp.

## Consistency with SpiceDB

Not every business write should synchronously write to SpiceDB. V0 should keep SpiceDB relationships relatively coarse and should not mirror the whole business ontology. Ordinary resource access can often be evaluated through tenant/legal-entity/module scope plus policy, rather than one SpiceDB tuple per ordinary record.

Role and access changes are security-critical and should fail closed if SpiceDB cannot be updated. Derived or helper relationships can be projected asynchronously if introduced later.
