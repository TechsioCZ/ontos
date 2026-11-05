---
status: accepted
---

# Granular authorization behind simple product layers

Accepted by the PO on 2026-11-03 for [#1343](https://github.com/TechsioCZ/ontos/issues/1343), with every recommended default P1–P12. The implementation rules are in [Granular Authorization](../../app/docs/architecture/AUTHORIZATION.md).

## Context

OntOS has two authorization models. `main` uses explicit, fail-closed Action grants ([ADR-0019](0019-explicit-action-authorization.md)) with a global per-key Action identity and no roles in the authorization graph, so it cannot give one person different rights in different companies. The demo branch scopes Actions and roles per company and separates agent proposals from execution, but its implicit `read_all`/`write_all` lets company admins silently execute every current and future Action. Six mechanisms decide access in parallel.

The product owner requires extreme granularity underneath and simplicity on top, an admin who can get everything, and one hard rule: a new Action must never end up usable or configurable by nobody, and must never be granted silently. Pure engines (SpiceDB, OpenFGA, Cedar, Cerbos, OPA) deny a new Action to everyone, so it is orphaned. Wildcards and live groups grant it silently. No product meets the rule by itself; it needs an explicit platform layer.

## Decision

Build one granular engine and hide it behind product layers: engine, permission catalog, levels and switches, roles, presets, product UI.

- **Modules declare, the engine stays fixed.** Every protected entrypoint carries an `accessDeclaration` with kind, risk tier (routine, sensitive, critical), placement, record selectors and modes. The SpiceDB schema is fixed and never changes for a new permission; each declared permission becomes a capability per scope.
- **Configure is structural, use is explicit.** Scope admins can configure every capability in their own scope, installed or not, and a delegate only within its live envelope, so nothing is orphaned. Use comes only from an adopted grant in a role assigned to the actor. A new permission appears in Novinky (Access changes) and is usable only after adoption: routine items in one batch per release, sensitive and critical items one by one with a named effect.
- **Admin is management, not data.** Owner and admin titles configure; business access comes from a role or Full access. Full access covers what exists when it is granted, and each later permission is one click.
- **Roles are defined once and assigned per company.** A role has immutable revisions. An assignment is one holder × role revision × scope × period and is never reused, so approvals and history bind to an exact incarnation.
- **Agents are separate, weaker actors.** Effective access is person ∩ agent ∩ agent connection. Agents run only routine grants, only propose sensitive and critical actions, and never approve or administer. Approval is a single-use mandate that re-checks the approver's current authority at execution.
- **Core is the only writer.** PostgreSQL holds intent; SpiceDB is a projection written only by the Core compiler, serialized per scope and verified against intent.
- **One decision function** answers single checks, lists, fields, exports, explanations and agent tool lists, with ALLOWED, NEEDS_APPROVAL, DENIED or a retryable unavailable outcome.

The replacement is direct. There is no environment running the earlier model and no data to migrate, so this decision has no backwards-compatibility path: the legacy relations, the global per-key Action identity, the member-default provisioning, the rollout contract and every parallel permission mechanism are deleted in the same change that introduces the v2 path. Nothing reads both models, nothing writes both, and no feature flag selects the old one.

This ADR supersedes ADR-0019. Its member-default rule (an Action provisioned for a Tenant's members was executable by every member of that Tenant) and its global per-key Action identity (one grant per key, valid in every scope) no longer exist. A permission is usable only through an adopted grant in an assigned Role within one scope, and a newly shipped Action receives no member default. ADR-0019's fail-closed rule remains in force: absent, incomplete or indeterminate configuration denies.

## Rejected alternatives

- **Risk-tier auto-flow.** Letting routine permissions flow into roles that follow a template makes safety depend on module authors labelling risk correctly; one mislabelled dangerous action would be granted silently. Adoption costs one batch click per release. A Tenant may opt into auto-adopting routine suggestions; it is off by default.
- **Live inheritance for owners and admins.** Having owners or admins automatically use every current and future permission (the demo's `read_all`/`write_all`, wildcards, live groups) is exactly the silent escalation the hard rule forbids, and it mixes who configures with who sees data.
- **One schema relation per action.** Generating SpiceDB relations or definitions per declared permission ties every module release to a schema migration, multiplies the schema with the catalog, and makes the engine depend on module code. Declared permissions are data (capability objects per scope) over a fixed schema instead.
- **Cedar or Cerbos now.** A policy engine would add a second decision system next to SpiceDB without solving orphaned or silently granted permissions, which needs the platform adoption layer anyway. Relationship checks, per-company scope and list filtering are already served by SpiceDB; conditions are covered by caveats and domain rules. A policy engine can be reconsidered later behind the same decision function.
- **An additive or shadow rollout.** Keeping the earlier model beside v2, importing legacy grants or running a shadow comparison would keep two answers to the same question alive. With no running environment and no data, direct replacement is simpler and cannot leave a stale path behind.

## Consequences

- Every protected Action, governed read, field group, export and admin entrypoint must declare `accessDeclaration` or `accessWorkload`. Validation rejects `routine` risk for exports, admin operations, dangerous verbs and the field classes that carry a sensitive floor, rejects `approve` without `propose`, and rejects a sensitive or critical Action that cannot accept a proposal, except the identity-bound, `ephemeral` and kind `admin` cases the contract names. It never rewrites a declaration to make it valid.
- Core gains PostgreSQL access tables, a v2 SpiceDB schema, a compiler, a decision engine, Novinky, approvals and lifecycle handling.
- Behaviour changes by design, in named classes rather than one:
  - A legacy grant was global per key; a v2 grant belongs to one scope, so a company without an assignment denies.
  - Legacy has no propose mode, so agent use of a sensitive or critical Action becomes an approval request instead of an execution.
  - A newly shipped Action no longer inherits a member default; it needs adoption.
- The legacy relations, the global per-key Action identity and the parallel permission mechanisms are deleted, without compatibility shims.
- Behaviour on the production PostgreSQL datastore, revocation under load and crashes, the TypeScript compile-time checks and screen usability remain to prove during implementation.
