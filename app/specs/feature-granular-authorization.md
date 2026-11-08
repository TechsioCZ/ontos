---
type: feature
status: in_progress
created: 2026-11-03
---

# Feature: Granular authorization (Authorization v2)

## Feature Description

Implement the accepted OntOS Authorization v2 model requested by GitHub issue [#1343](https://github.com/TechsioCZ/ontos/issues/1343): one very granular permission engine hidden behind simple product layers. Modules declare every protected entrypoint in code with a mandatory access declaration. A newly shipped permission is configurable by admins at once but usable by nobody until a person adopts it. Roles are defined once per Tenant and assigned per company (Legal Entity). AI agents are separate actors with less power than the people they act for.

The durable decision is [ADR-0030](../../docs/adr/0030-granular-authorization.md). Product vocabulary is in the [OntOS context](../../docs/contexts/ontos/CONTEXT.md). Implementation rules for module authors and Core are in [Authorization](../docs/architecture/AUTHORIZATION.md). This specification owns the tranche plan and the acceptance criteria.

## User Story

As a Tenant owner or company admin
I want every module permission to be configurable at once, adopted deliberately, and assigned per company through simple roles
So that no new feature is ever left usable by nobody, nothing dangerous is ever granted silently, and people and agents get exactly the access their job needs

## Problem Statement

`main` has explicit, fail-closed Action grants ([ADR-0019](../../docs/adr/0019-explicit-action-authorization.md)) with a global per-key Action identity, no roles in the authorization graph, and no propose/execute split. The demo branch adds company-scoped roles and agent proposals, but its implicit `read_all`/`write_all` inheritance silently lets company admins execute every current and future Action. Neither model guarantees the product owner's hard requirement: a new Action must never end up usable or configurable by nobody, and must never be granted silently. Several parallel mechanisms (`context_permission`, business permissions, `module_access`, Action grants, Tenant/Legal Entity relations, hand-written command lists) decide access today, so no single place can answer "who may do this and why".

## Solution Statement

Layer the model as the issue's research recommends (engine → catalog → levels and switches → roles → presets → product UI):

- **Catalog (L1).** Every protected entrypoint carries an `accessDeclaration` (kind, risk tier, placement, record selectors, modes, optional amount input, field class and lineage). The catalog is derived from those declarations; there is no hand-maintained registry.
- **Engine (L0).** A fixed SpiceDB schema, the reference `schema-v2.2.zed` from the #1343 research, is added next to the legacy definitions, adapted rather than copied (every v2 name gains an `access_` prefix, `company` becomes `access_legal_entity`, and `principal` stays shared with the legacy model). It never changes when a module adds a permission. Core is its only writer: one compiler turns PostgreSQL intent (roles, immutable role revisions, assignment incarnations, delegations, adoptions, mandates) into exact grant cells.
- **Decision.** One decision function resolves person ∩ agent ∩ agent connection for every path (single check, list, field, export, explanation, agent tool list) with one `CheckBulkPermissions` witness chain, and returns ALLOWED, NEEDS_APPROVAL, DENIED or a retryable UNAVAILABLE.
- **Adoption (Novinky).** A catalog change produces Access changes. Admins can configure the new capability at once; nobody uses it until it is adopted into a role, routine items in one batch per release and sensitive or critical items one by one with a named effect.
- **Rollout.** Tranche 1 adds everything next to the legacy model with no change to any authorization outcome and runs the new decision in shadow mode. Later tranches cut over per module, delete the legacy model, migrate demo data and ship the product screens.

## Accepted product decisions

The product owner accepted every recommended default on 2026-11-03 (#1343).

| #   | Decision                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | New routine permissions need adoption, one batch click per release. An opt-in Tenant setting "auto-adopt routine suggestions" may exist; it is off by default.           |
| P2  | "Full access" covers every permission that exists when it is granted. Each later permission is one click ("Add to Full access"); it never follows the future implicitly. |
| P3  | An admin title is management only. Business data access comes from a role or Full access.                                                                                |
| P4  | Agents only propose sensitive and critical actions; a person approves. Agents never approve and never administer.                                                        |
| P5  | Approving means "Approve and execute using my access"; the approver's current rights are checked again at execution.                                                     |
| P6  | Nobody approves their own request for more authority. Confirming an action you can already do follows business policy; one-person companies need an explicit exception.  |
| P7  | A demo clone copies no people by default. "Copy people and roles" and "Generate synthetic personas" are visible options; demo Tenants pre-select personas.               |
| P8  | A delegated access manager never receives future permissions of "their" module automatically; extending a delegation is a new decision.                                  |
| P9  | Limits are set per role by default; per-person limits are an advanced option.                                                                                            |
| P10 | An approval is single use and valid for 24 hours, or 1 hour for critical actions.                                                                                        |
| P11 | The platform operator has no Tenant data access by default. Break-glass access needs owner approval, expires and is audited.                                             |
| P12 | Module authors use three risk tiers, routine, sensitive and critical, combined with the declaration kind.                                                                |

## Guarantees

The new decision satisfies these from tranche 1, proven in shadow mode and in the scenario suite; a module's live decisions satisfy them from that module's cutover. The scenario suite proves each one, including a deliberately broken variant that must fail.

1. A newly shipped permission is never configurable by nobody: there is always a Tenant owner, and company admins cover their company.
2. Nobody uses a permission without an explicit adoption and an assignment that names it. Releases, renames, splits and clones never create use.
3. Access in one company never authorizes anything in another. Owner status gives management only; operational access always requires membership.
4. An agent never exceeds its user, its own profile or its agent connection. Removing the agent or revoking the connection stops it at once.
5. An approval executes at most once, only while the approver still holds the right through the same assignment incarnation. Reassignment, rejoining or re-creating a role never revives it. Agents never approve.
6. Nothing works past the earliest relevant end date: membership, assignment, delegation, agent connection, task or approval.
7. A delegate never grants beyond their envelope or after the delegation is revoked.
8. An uninstalled module does nothing on any path. A reinstall never resurrects something revoked in the meantime.
9. Limits and record scopes from different grants are never combined into more power than any single grant gives.
10. Lists show exactly the records the actor may see: no extras, no gaps, and no leaks through sorting or filtering on hidden fields.

The research design rules D1–D32 (#1343) refine these guarantees and each becomes a named regression scenario.

## Access declaration contract

Protected Action, governed read, field group, export and admin descriptors carry `accessDeclaration`. The field is not named `access`, because `access` already means the module-state access class of an entrypoint. `packages/core-runtime/src/authorization/access-declaration.ts` (new in tranche 1) owns the exact schema and validation, including the dangerous-verb, terminal-verb and sensitive-field-class constants; this is its contract:

```ts
accessDeclaration: {
  key: 'party.registry.party.merge',  // <moduleId>.<resource>.<verb>[.<qualifier>], the full dotted moduleId first, lowercase, unique per module
  kind: 'action' | 'read' | 'field_read' | 'field_write' | 'export' | 'admin',
  risk: 'routine' | 'sensitive' | 'critical',
  placement: { group: 'parties', level: 'basic' | 'extended' | 'manage' }, // a suggestion, never a grant
  selectors: readonly ('all' | 'assigned' | 'entrusted' | 'team')[],      // [] = not record-scoped
  modes: readonly ('run' | 'propose' | 'approve')[],                      // reads: ['run']
  ephemeral?: boolean,   // a short-lived proof that cannot wait for a person
  amountInput?: string,  // path of the money input for amount ceilings (actions only)
  fieldClass?: string,   // field_read/field_write only: 'margins' | 'salaries' | 'personal_data' | ...
  lineage?: { renamedFrom?: readonly string[]; splitFrom?: string },
}
```

- The key starts with the owning module's full dotted `moduleId`, which is matched as one whole prefix, so the verb rules only look at the segments after `<moduleId>.<resource>`.
- `export` and `admin` are at least `sensitive`. A `fieldClass` with a sensitive floor is at least `sensitive`; the floor classes are `personal_data`, `bank_details`, `salaries`, `margins`, `purchase_prices`, `credit_limits`, `financial_amounts`, `tax_identifiers` and `authority_metadata`, while any other lowercase class is allowed and listed for review.
- Modes: reads and field reads use exactly `['run']`. A sensitive or critical Action must include `propose`; `approve` is optional and requires `propose`, so without it only a granted person runs the Action directly. An identity-bound Action, which the original actor must personally run, uses `['run', 'propose']` and never `approve`. An Action that is itself an approval decision declares `['run']` or `['run', 'propose']` with the risk of its own effect. An `ephemeral` Action and a kind `admin` Action may declare `['run']` alone.
- `ephemeral: true` marks a proof whose validity is seconds to minutes and that cannot wait for a person, such as a 30-second commitment confirmation. It must be run-only, and agents never run it when its risk is sensitive or critical.
- Dangerous verbs are never `routine`, in any spelling or case: delete, remove, void, cancel, refund, pay, payout, transfer, export, merge, impersonate, grant, revoke, approve, publish, purge, erase, anonymize, close-period, write-off, credit-note, retire. A terminal state change (`archive`, `close`, `deactivate`) is at least `sensitive`, and `critical` when it has a legal or money effect or cannot be undone.
- `critical` means money movement, irreversible or legal effect, destructive operations, or authority and admin changes. `sensitive` means personal data, financial visibility, exports, bulk changes or external communication.
- Agent use is derived, never declared, and a stricter outcome wins: routine may run when granted, sensitive and critical Actions are propose only, `admin` is never available, and a `read`, `field_read`, `field_write` or `export` that is sensitive or critical is never available to an agent, because a read cannot be proposed. Letting agents run sensitive reads needs its own product decision.
- Public, `authenticated_principal`, `owner_local_background` and `capability_issuance` entrypoints carry no `accessDeclaration`. The existing `authorization` classification is unchanged.
- A declaration never grants anything. It creates a catalog entry that admins can configure at once and that is usable only after adoption.

## Relevant Files

Use these files to implement the feature:

- `../docs/adr/0019-explicit-action-authorization.md` — current fail-closed Action rule. Its fail-closed principle stays; its member default and its global per-key Action identity are superseded per module at cutover.
- `../docs/adr/0030-granular-authorization.md` — the accepted Authorization v2 decision.
- `specs/feature-complete-protected-entrypoint-authorization.md` — the in-progress #173 feature that owns the same protected-entrypoint inventory script (`scripts/check-module-entrypoint-boundaries.mts`) and an earlier report-only compatibility period. The v2 catalog extends both rather than designing them a second time.
- `../docs/contexts/ontos/CONTEXT.md` — Capability, Access declaration, Risk tier, Role, Role revision, Assignment, Delegation, Access change, Adoption, Legacy-default Role, Mandate, Principal and agent, Agent connection and Scope fence.
- `docs/architecture/AUTHORIZATION.md` — rules for module authors and Core.
- `docs/architecture/ACTIONS.md`, `docs/architecture/MODULE_ENTRYPOINTS.md` — the Action lifecycle and entrypoint classification that the new decision plugs into.
- `packages/core-runtime/src/authorization/entrypoint-classification.ts` — existing closed `authorization` classification; it decides which entrypoints may carry a declaration.
- `packages/core-runtime/src/actions/definition.ts`, `packages/core-runtime/src/reads/definition.ts` — Action and governed read descriptors that carry `accessDeclaration`.
- `packages/core-runtime/src/permissions/schema.ts`, `packages/core-runtime/spicedb/bootstrap.yaml` — SpiceDB schema; v2 definitions are additive next to the legacy ones.
- `packages/core-runtime/src/permissions/service.ts` — current permission decision seam that shadow mode compares against.
- `packages/core-runtime/src/db/schema.ts` — Core schema barrel that exports the access tables.
- `scripts/check-module-entrypoint-boundaries.mts` — the single inventory pass that also derives the access catalog.
- `scripts/scaffolding/` — Codesmith generators that must emit `accessDeclaration` for new protected entrypoints.

### New Files

- `packages/core-runtime/src/authorization/access-declaration.ts` — declaration schema, classification rules, derived agent policy and pure catalog collection.
- `packages/core-runtime/src/access/` — Core access model (roles, revisions, assignments, delegations, Access changes, mandates, agent connections, scope fences, decision log) and identifiers.
- `packages/core-runtime/src/db/access-schema.ts` and a new Core migration — PostgreSQL intent tables.
- `packages/core-runtime/tests/integration/access-v2-schema*.test.ts` — schema v2 behaviour against a real SpiceDB.

## Tranche plan

### T1 — Foundation, no behaviour change

Add the new model next to the legacy one. No existing authorization outcome changes, and every new path is either pure, report-only or shadow.

1. **Classification.** `accessDeclaration` contract and validation in Core; scaffolding emits it; every existing protected Action, governed read, field group, export and admin entrypoint is classified from the scout outputs; catalog check and PR catalog diff run report-only.
2. **Core model.** PostgreSQL tables and Effect schemas for catalog snapshots, roles, immutable role revisions with provenance, assignment incarnations, delegations, Access change items and decisions, proposals, mandates, agent connections with consent snapshots, scope fences, operation journals and the decision log.
3. **Schema v2.** The reference engine definitions added to the SpiceDB schema without changing any legacy relation or permission.
4. **Compiler.** Role revisions, levels, switches and templates compile to exact grant cells and tuples; Core is the only writer and serializes per scope through the scope fence and operation journal.
5. **Decision engine.** Actor-context resolver (person ∩ agent ∩ connection), one `CheckBulkPermissions` witness chain, list selectors turned into the owner's SQL predicate contract, field checks that require parent record read, admission deadline as the minimum relevant end date, and the decision log.
6. **Novinky.** Catalog snapshot diff, Access change items, batch adoption of routine items, individual adoption with a named effect for sensitive and critical items, reviewable undo that never restores something revoked.
7. **Approvals.** Proposals, human-only approval as a mandate bound in the graph to the approver's exact execution and approval Assignments and their grants and in Core to the requester's exact Assignment, re-check at execution, single use, P10 lifetimes, permanent lapse.
8. **Lifecycle.** Membership departure and rejoin, last-owner guard, module uninstall and reinstall, delegation envelopes, rename and split continuity.
9. **Shadow mode.** Compute the legacy and the new decision for every request, log differences with reasons, record legacy quirks as observations that v2 never copies, and keep the legacy decision authoritative.
10. **Scenario suite.** S1–S9 and D1–D32 as automated scenarios against a real SpiceDB and PostgreSQL.

### T2 — Legacy-grant import, then cutover per module

Cutover starts with an import, not with one adoption click per release. For each Tenant:

1. **Import the legacy baseline.** Snapshot today's effective legacy access into v2 intent: every ADR-0019 member-default grant (`action#executor@tenant:<tenant>#member` for an Action provisioned with `tenant_membership_default`), the legacy Tenant relations (`identity_admin`, the `party_identity_*` set and `support` impersonation), `business_permission` and `context_permission` grants, `module_access` accessors and the Legal Entity counterparty grants. Each becomes an explicit Role revision and Assignment in the Tenant, under a "Původní přístupy" role with provenance `imported`.
   - It is one reviewed Adoption with a recorded diff per Tenant, never an implicit full grant and never "adopt everything".
   - It runs before any module switches, and nobody loses access on cutover day.
2. **Prove zero unexplained mismatch.** Shadow mode must show no unexplained difference for the module before it switches. Remaining differences belong to named classes, each explained in writing:
   - A legacy grant is global per key, while a v2 grant belongs to one scope, so a company without an Assignment now denies (guarantee 3).
   - Legacy has no propose mode, so agent use of a sensitive or critical Action becomes NEEDS_APPROVAL instead of an execution.
   - Shadow mode records legacy quirks (the `action.restriction` subject-type mismatch, global Action ids) as observations, and the new decision never copies them.
3. **Switch that one module.** Make the new decision authoritative only for it. From then on a newly shipped Action receives no ADR-0019 member default and needs adoption; that is the intentional change to ADR-0019's default rule.

Rollout note for the operators: changing the SpiceDB bootstrap triggers the deployment-impact plan's SpiceDB-first phase and changes the `spiceDbSchemaHash` readiness evidence. Stage applies the bootstrap only to an empty datastore, so the schema reaches stage through the operator-run, additive `writeSchema`. Once v2 tuples exist, renaming or removing a v2 definition makes that write fail.

### T3 — Legacy removal

Delete the legacy relations, permissions, provisioning paths and fields once no module reads them, with no compatibility shims.

### T4 — Demo data migration

Migrate the live demo data through the sealed expand → write → switch → contract → verify procedure, mapping demo roles, bindings, agent operators and grants onto roles, assignments and agent connections.

### T5 — Product screens GA

Ship Lidé, Role (levels, switches, limits, templates), Novinky v oprávněních, Ke schválení and Proč?, plus company presets with clone and rename.

## Testing Strategy

### Unit Tests

Declaration validation (every rule in the contract, including dangerous verbs in collapsed, camel and separator spellings), catalog collection (duplicate keys, cross-module lineage, lineage cycles), Core model schemas (periods, delegation bounds, mandate correlation, scope fence states), compiler cell derivation, and selector-to-predicate translation.

### Integration Tests

Schema v2 against the pinned SpiceDB image, compiler and decision engine against PostgreSQL and SpiceDB, shadow comparison on the existing Action and read paths, and the scenario suite.

### Edge Cases

Last owner removal by any route; rejoin after departure; approval after the approver's role edit (equal or broader keeps it, narrower lapses it); end date passing with no other event; uninstall while a mandate is pending; agent connection revoked mid-run; rename with `renamedFrom` and split with `splitFrom`; a list sorted or filtered by a hidden field; amount limits from two grants; a check without caveat context denying instead of returning an outage; an engine that cannot be reached returning UNAVAILABLE rather than DENIED.

## Acceptance Criteria

### T1

- [ ] Every protected Action, governed read, field group, export and admin entrypoint carries a valid `accessDeclaration`; public, `authenticated_principal`, `owner_local_background` and `capability_issuance` entrypoints carry none; the report-only catalog check lists any gap.
- [ ] Validation rejects routine exports and admin operations, routine dangerous verbs in any spelling (including `retire`), routine sensitive-floor field classes, field classes on non-field kinds, amount inputs and `ephemeral` on non-actions, reads with modes other than `run`, `approve` without `propose`, a sensitive or critical Action that accepts no proposal unless it is `ephemeral` or kind `admin`, an identity-bound Action that declares `approve`, duplicate keys per module, cross-module lineage and lineage cycles.
- [ ] Codesmith generators emit `accessDeclaration` for new protected entrypoints, and generator tests cover it.
- [ ] Core access tables, migration and Effect schemas exist; the database trust manifest covers them; decoding rejects excess properties at untrusted boundaries.
- [ ] Schema v2 definitions validate on the pinned SpiceDB image, and `tests/integration/access-v2-schema-legacy.test.ts` pins the legacy block byte-for-byte so no legacy relation or permission can change unnoticed.
- [ ] The compiler is the only writer of v2 tuples, serializes per scope, and its verification compares the complete projection with PostgreSQL intent.
- [ ] One decision function serves single checks, lists, fields, exports, explanations and agent tool lists, and lists are proven equal to per-record checks.
- [ ] Novinky lists every catalog addition and change; adoption, batch adoption and undo follow P1, P2 and P8; nothing is usable before adoption.
- [ ] Approvals follow P4–P6 and P10 and lapse permanently on loss of the approver's authority.
- [ ] Shadow mode records both decisions for every request without changing the live outcome.
- [ ] The scenario suite covers S1–S9, guarantees 1–10 and D1–D32, each with a broken variant that fails.
- [ ] Every existing authorization test passes unchanged.

### T2

- [ ] The legacy-grant import runs per Tenant before any module switches, creates the "Původní přístupy" Roles with provenance `imported`, is reviewed as one Adoption with a recorded diff, and leaves no member without the access they had the day before cutover.
- [ ] For each cut-over module, shadow mode shows zero unexplained differences before it switches, and every remaining difference is explained in writing as one of the named classes.
- [ ] The new decision is authoritative only for that module, and the loss of the ADR-0019 member default for newly shipped Actions is recorded.

### T3

- [ ] No legacy relation, permission, provisioning path or descriptor field remains, and no code reads one.

### T4

- [ ] The demo data migration runs expand → write → switch → contract → verify, and verification shows the projection equals intent for every demo Tenant.

### T5

- [ ] Lidé, Role, Novinky v oprávněních, Ke schválení and Proč? meet the product scenarios S1–S9, and denied buttons explain what is missing and who can grant it.

## Validation Commands

Run from `app/`:

```sh
mise exec -- pnpm --filter @app/core-runtime test:unit
mise exec -- pnpm --filter @app/core-runtime test:integration
mise exec -- pnpm --filter @app/core-runtime typecheck
mise exec -- pnpm authorization:inventory:check
mise exec -- pnpm check:local --scope generation
mise exec -- pnpm check
```

The SpiceDB schema and decision scenarios live in `packages/core-runtime/tests/integration/access-v2-schema*.test.ts` and need the pinned SpiceDB image; run them through `test:integration` rather than by hand.

## Non-goals

- Changing any live authorization outcome in T1.
- Module-specific schema relations for new permissions; the engine schema is fixed.
- Adopting a second policy engine such as Cedar or Cerbos.
- Production enforcement before the production gate in #369.
- Auto-flowing routine permissions into roles (P1 keeps adoption).
- A platform-operator data bypass (P11).

## Open proof gaps

The research validated the model against a real SpiceDB, TLA+ models and a scale smoke test. These remain to prove during implementation:

- behaviour on the production PostgreSQL datastore and its clocks, including the expiry matrix;
- revocation across independently deployed MicroVerticals under load and crashes;
- the real TypeScript compile-time checks for declarations;
- usability of the product screens;
- the complete migration of today's live demo data.

## Notes

- Tranche 1 must not change a live decision. A lane that seems to need one stops and reports.
- In code the product term "company" is `legal_entity`, and "Tenant" is the organization.
- Re-run the TLA+ models whenever the design changes.
