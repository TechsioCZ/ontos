# June 2026 V0 Prep And V1 Delivery Handoff

Date: 2026-06-04
Branch model: trunk-based development on `main`

## Current Planning Correction

Use this framing from now on:

- **V0** is preparation: Core implementation, architecture, ADRs, documentation, PoC, module contracts, schema contracts, and delivery controls.
- **V1** is the mandatory ERP delivery for the end of 2026.

Earlier docs sometimes use "V0" for the production ERP delivery. Treat that as older wording until the docs are fully renamed. The actual product delivery target for 2026 is V1.

## Fixed And Flexible Scope

The V1 module areas are fixed:

1. Property management.
2. Accounting.
3. Finance.
4. Reporting and data.
5. Shared ERP functions.
6. Data migration and data interfaces.

The exact feature details inside those modules are not fixed. They must be discovered directly with the customer through use-case conversations, constraints, current data, acceptance evidence, and operational priorities. Do not turn June into waterfall specification. The goal is to define enough contracts and acceptance structure so agile discovery can proceed safely.

## Core, Shell, And MicroVertical Decision

Core should **not** be a MicroVertical.

Use this model:

- **Shell** is the host application. It owns layout, navigation, tenant/legal-entity selector, shared providers, route composition, module mounting, and module discovery.
- **Core** is the platform/kernel layer used by Shell and all MicroVerticals. It owns identity, principal resolution, authorization adapter, policy hooks, action runtime, audit, outbox, module registry, media, search/report foundations, migrations, tenant isolation, and shared runtime guarantees.
- **MicroVerticals** are business modules. Property, accounting, finance, reporting, migration/import-export, and other business areas are separate MicroVerticals.

Core may be split into packages such as `core.identity`, `core.actions`, `core.authz`, `core.audit`, `core.outbox`, `core.search`, and `core.modules`. Those are system packages, not tenant-activatable business MicroVerticals.

## Core Readiness Assessment

Core is directionally ready for the rough V1 module idea, but it is not implementation-ready until these contracts exist:

1. **Module contract**
   - public module manifest
   - Vertical Runtime Registration and Installed Vertical Registry
   - route and navigation contributions
   - UI contribution guards
   - migrations
   - actions
   - search descriptors
   - report descriptors
   - outbox/projection handlers

2. **Action contract**
   - action key
   - request schema
   - response schema
   - tenant context
   - legal-entity context when applicable
   - principal context
   - idempotency rule
   - authorization requirement
   - policy checks
   - audit profile
   - domain events
   - outbox messages
   - evidence policy

3. **Core schema invariants**
   - tenant-safe composite foreign keys
   - action idempotency unique index
   - domain event tenant sequence
   - outbox claim/retry/dead-letter model
   - module activation state enum
   - media storage identity constraints
   - evidence constraints
   - search projection uniqueness and rebuild metadata

4. **Authz and search rule**
   - tenant membership
   - legal-entity roles
   - module access
   - explicit sensitive-resource grants
   - fail-closed behavior
   - search/list filtering strategy

5. **Module activation behavior**
   Define exact behavior for:
   - active
   - inactive
   - read-only
   - suspended
   - quarantined
   - deprecated
   - archived

Without these contracts, each MicroVertical will make different assumptions and Core will not safely support "any module."

## UltraModern.js Validation

The Tractor Demo validation is accepted as evidence that the shell plus MicroVertical composition pattern works.

Known conclusion:

- Shell plus multiple full-stack verticals is viable.
- Boundaries can be shown and reasoned about.
- The model should work for OntOS modules.

Still unproven for OntOS:

- Core action pipeline.
- Tenant isolation.
- BetterAuth to OntOS Principal resolution.
- SpiceDB authorization checks.
- Audit and outbox writes.
- Effect SQL/Drizzle migrations.
- Installed Vertical Registry and Vertical Runtime Registration contract.

The June PoC must prove these OntOS-specific guarantees.

## Effect SQL And Drizzle Decision

Use Effect for SQL work where practical. `@effect/sql-drizzle` and `@effect/sql-pg` are acceptable candidates for the PoC.

Rules:

- Use Effect schemas and Effects for runtime boundaries and errors.
- Use Drizzle where it improves typed table/query work.
- Keep migrations reviewable.
- Do not let generated or ORM abstractions hide tenant isolation, idempotency, sequence, outbox, or evidence constraints.
- If Drizzle cannot express a critical constraint clearly, use raw SQL migration fragments.

The PoC must answer whether this stack is pleasant and strict enough for production Core.

## Neo4j Decision

Default position: defer Neo4j for V1.

Neo4j is valuable only if V1 needs mandatory multi-hop graph questions that Postgres plus ResourceRefs plus search/report projections cannot answer well enough.

Potential benefits:

- graph exploration across companies, properties, units, contracts, invoices, documents, tasks, and parties
- impact analysis
- visual relationship browsing
- future ontology/AI context

Current problem: no mandatory V1 use case yet justifies the operational cost.

Trigger to reintroduce Neo4j:

- the customer requires a graph-style workflow, for example "show every contract, debt, document, task, unit, and company affected by this ownership or management change"
- Postgres queries become too awkward or slow for a real accepted workflow
- graph visualization becomes part of acceptance evidence

Until then, build Core so Neo4j can be added later as an outbox-fed projection, but do not make V1 depend on it.

## PoC Success Gates

The PoC succeeds only if it proves:

1. Shell loads at least two MicroVertical stubs.
2. Boundaries between MicroVerticals are visible or enforceable.
3. One Action runs through Core.
4. Action input is validated with Effect Schema.
5. Action writes through Effect SQL/Drizzle or a clearly comparable Effect SQL path.
6. Postgres write includes tenant context.
7. Action invocation row is written.
8. Audit row is written.
9. Outbox row is written.
10. BetterAuth user or stubbed equivalent resolves to an OntOS Principal.
11. SpiceDB check or strict mock adapter gates the Action.
12. Module active/read-only/inactive state is checked.
13. A minimal read/list path works.
14. A minimal export/report stub can run.
15. The developer can explain what failed, what was proven, and what must change before production.

The PoC fails if:

- Shell cannot compose multiple MicroVerticals cleanly.
- Module boundaries are unclear or unenforceable.
- Core action runtime becomes too coupled to one module.
- Tenant isolation depends only on developer discipline.
- Authz cannot fail closed.
- Effect SQL/Drizzle cannot express or coexist with required constraints.

## What To Finish This Week

Owner: project lead before being away next week.

### 1. Lock The Core/Shell Decision

Finish and share this decision:

- Core is kernel/runtime, not a MicroVertical.
- Shell hosts MicroVerticals.
- Business modules are MicroVerticals.
- Core system packages are not tenant-activatable modules.

Output:

- This handoff document committed or otherwise present on `main`.

### 2. Prepare The PoC Brief

The next developer must know:

- what the PoC must prove
- what not to build
- which assumptions are already accepted from Tractor Demo
- which OntOS-specific assumptions remain unproven

Output:

- PoC success gates from this document are accepted.

### 3. Draft The V1 Acceptance Matrix

Use the fixed module table and create a first draft with:

- module
- required capability
- customer use case to validate
- expected output/evidence
- must-have vs negotiable
- target month
- open customer questions

Start with the table in this document. It is allowed to be rough. It must be usable in customer discovery.

### 4. Prepare Customer Discovery Questions

For every fixed V1 module, prepare questions that discover:

- real current workflow
- current data sources
- required records
- required roles
- required outputs
- acceptance evidence
- what can be cut
- what cannot be cut

### 5. Mark Forbidden Next-Week Work

The next developer must not build real ERP product scope next week. The only allowed business flow is a fake or minimal property/unit flow used to prove Core.

Forbidden next week:

- full property module
- full accounting module
- finance workflows
- real reporting dashboards
- real migration tooling beyond a spike
- Neo4j integration unless explicitly used as a small optional note
- polishing UI
- customer-specific features before the PoC result

### 6. Define Daily Update Format

Every workday next week, the other developer should report:

```text
Date:
What was attempted:
What was proven:
What failed:
Files changed:
Decisions needed:
Next step:
Risk level: green/yellow/red
```

## Other Developer Plan For Next Week

Goal: prove OntOS Core can host multiple MicroVerticals safely. Do not build V1 features yet.

### Day 1: Setup, Shell, And MicroVertical Stubs

Tasks:

1. Create or prepare the UltraModern.js app shell.
2. Add two dummy MicroVerticals:
   - `property.registry`
   - `accounting.core`
   - use hyphenated folders such as `property-registry` and `accounting-core`, while keeping manifest ids and runtime keys dotted
3. Mount both from Shell.
4. Add a shared layout and module navigation placeholder.
5. Add visible boundary indicators for each MicroVertical.

Acceptance:

- The app runs locally.
- Shell can show both MicroVerticals.
- Each MicroVertical owns its own route/page/component area.
- Each MicroVertical route visibly shows its module id, filesystem folder name, tenant module state, and that the page is rendered from the owning MicroVertical.
- No product feature is implemented beyond placeholders.

Deliverables:

- runnable app
- screenshot or short video
- notes on boundary mechanics and visible boundary markers

### Day 2: Module Manifest And Private Registry

Tasks:

1. Add minimal public manifest shape:
   - module id
   - kind
   - display name
   - activation default
   - dependencies
   - public resource descriptors:
     - `property.unit`
     - `accounting.draft_entry`
   - public component descriptors:
     - `PropertyUnitCard`
     - `AccountingDraftEntryCard`
   - Module Federation exposure metadata or generated wrapper/client wiring for public components so cross-MicroVertical component consumption does not use direct source imports.
   - public API placeholder
   - public Action descriptors placeholder:
     - `property.registry.createUnit`
     - `accounting.core.createDraftEntry`
   - public search descriptors:
     - `property.unit.search_result`
     - `accounting.draft_entry.search_result`
   - public report descriptors:
     - `property.unit.inventory`
     - `accounting.draft_entry.summary`
2. Add Vertical Runtime Registration and Installed Vertical Registry:
   - routes
   - actions
   - migrations
   - handlers
   - search/report descriptors if easy
3. Register both dummy modules.
4. Represent both MVP modules as `active` for the demo tenant using a fixture shaped like `CORE_TENANT_MODULE_STATES`.
5. Add `pnpm check:boundaries` and wire it into `pnpm check`; use UltraModern's generated boundary checker if available, with OntOS-specific rules added as needed.
6. Add one Day 2 proof that a MicroVertical can consume another MicroVertical's public component through Module Federation using the manifest-exposed public component surface. The proof may be inert and UI-only, but it must not import the producer's component source file directly.

Acceptance:

- Shell discovers modules through registry.
- Shell treats both MVP MicroVerticals as active.
- Shell navigation follows the initial module-state visibility rule: show active/read-only/deprecated, hide inactive/suspended/quarantined/archived.
- Public manifest does not contain private implementation paths.
- Both MVP MicroVerticals expose placeholder resource, component, Action, search, and report descriptors; handlers/query implementations are stubbed or explicitly not implemented.
- At least one cross-MicroVertical public component is consumed through Module Federation-generated exposure/remote wiring, with the manifest as the allowlist and no direct import from another MicroVertical's private source path.
- Vertical Runtime Registration exists for each MicroVertical and the Shell-owned Installed Vertical Registry is explicit.
- `pnpm check` runs `pnpm check:boundaries`.

Deliverables:

- manifest example
- registry example
- Module Federation public component consumption example
- short note: what belongs in manifest vs private registry

### Day 1/2 Batch Evidence

When Day 1 and Day 2 are implemented together, completion evidence should include:

- exact UltraModern.js create package version and scaffold commands used
- `pnpm check` passing, including `pnpm check:boundaries`
- local app run command and URL
- screenshots showing Shell navigation and both MicroVertical boundary markers
- changed-file summary with the public manifest files, Vertical Runtime Registration files, Installed Vertical Registry, and boundary-check wiring called out
- notes on any scaffold limitations or places where UltraModern generated behavior shaped the implementation

### Day 3: Database, Context, BetterAuth, SpiceDB, And Policy Gates

Tasks:

1. Add local database setup and one full documented initial SQL schema from the current docs.
2. Spike `@effect/sql-pg`.
3. Spike `@effect/sql-drizzle`.
4. Decide whether Drizzle is usable for Core tables, using raw SQL where constraints must stay explicit.
5. Seed demo tenant, legal entity, principal, principal auth binding, and tenant module states for:
   - `property.registry`
   - `accounting.core`
6. Add BetterAuth stub or minimal BetterAuth integration. Since the current `mvp/` code has no BetterAuth implementation yet, a strict BetterAuth-shaped stub is acceptable if it resolves through `CORE_PRINCIPAL_AUTH_BINDINGS`.
7. Add runtime tenant, legal-entity, and principal context resolution from the seeded database.
8. Add SpiceDB adapter interface.
9. Add real SpiceDB check or strict fake with the same contract.
10. Add module-state write gate.
11. Add trivial policy hook.
12. Add scenario buttons in `accounting.core` to exercise missing context, blocked module state, authorization denied, policy denied, and validation denied without adding extra public Actions.
13. Include tenant-safe constraint evidence.
14. Include idempotency uniqueness or document why it was not implemented yet.

Acceptance:

- Database initializes locally from the full documented PoC schema.
- Demo tenant, legal entity, principal, auth binding, and module states are loaded from the database, not hard-coded at the button call site.
- BetterAuth-shaped subject resolution maps to an OntOS Principal through Core binding logic.
- SpiceDB-shaped authorization fails closed.
- Module active/read-only/inactive state is checked from persisted state.
- Policy hook can allow and deny.
- The developer can explain how tenant isolation will be enforced.
- Critical constraints are not hidden behind unclear ORM behavior.

Deliverables:

- init SQL schema and seed path
- schema notes
- Effect SQL/Drizzle recommendation
- BetterAuth/principal binding stub or minimal integration
- SpiceDB adapter contract or strict fake
- module-state and policy gate demo output

### Day 4: Core Action Runtime And Canonical Write

Tasks:

1. Implement `executeAction` as the Core runtime wrapper.
2. Resolve Action descriptors from the Installed Vertical Registry.
3. Run `property.registry.createUnit` through Core.
4. Validate Action input with Effect Schema.
5. Resolve tenant, legal entity, and principal context through the Day 3 context path.
6. Check module state, authorization, and policy through the Day 3 gates.
7. Execute the private handler only through Core.
8. Have the successful handler write a minimal tenant-scoped canonical row through the selected SQL path.
9. Return a typed result, preferably a ResourceRef-shaped value.
10. Keep `accounting.core.createDraftEntry` as the probe Action for negative-path buttons.

Acceptance:

- Action cannot run without tenant and principal context.
- Action cannot run if module state blocks writes.
- Unauthorized Action fails closed.
- Invalid input is rejected before handler execution.
- Handler does not bypass Core runtime.
- Successful Action writes tenant-scoped canonical data through Effect SQL/Drizzle or the selected SQL path.
- Action has a stable descriptor.

Deliverables:

- action runtime wrapper
- widened Action descriptor shape if needed
- create-unit handler implementation for the proof row only
- demo request/result from button harness and/or test

### Day 5: Action Invocation, Audit, Outbox, Idempotency, And Final Demo

Tasks:

1. Write `CORE_ACTION_INVOCATIONS` lifecycle rows.
2. Enforce or explicitly document idempotency handling for non-idempotent writes.
3. Write audit checkpoints for received/authn/authz/policy/validation/executed/rejected/failed as appropriate for the proof.
4. Write a domain event for successful `property.registry.createUnit`.
5. Write an outbox message for the successful domain event.
6. Run the create-unit demo end to end from button click through Core checks, canonical write, action invocation, audit, domain event, and outbox.
7. Keep failure-path buttons proving context/authz/policy/validation rejection behavior.
8. Write final PoC result note.

Acceptance:

- Successful Action produces canonical row, action invocation, audit event, domain event, and outbox message.
- Rejected Action produces useful action/audit evidence without running the handler.
- Idempotency behavior is enforced or the exception is explicit and bounded.
- PoC result note says proceed/revise/drop for each major decision.

Deliverables:

- runnable demo
- screenshots or short video
- final PoC notes
- list of proven assumptions
- list of failed assumptions
- recommended ADR status updates

## V1 Acceptance Matrix Draft

This is a first working draft. It should be refined with the customer, not treated as final waterfall scope.

| V1 area | Minimum capability | Required evidence | Must-have now? | Open customer questions |
|---|---|---|---|---|
| Property management | Properties, spaces/units, related contracts, clients/service users, accommodation capacity, occupancy, payments/receivables/payables related to properties, operational tasks/requests, import/export in common formats. | Functional module for authorized users, configuration protocol, sample records, user documentation, acceptance test results. | Yes | Which property/unit records exist today? Are units physical, bookable, rentable, or all of these? Which contracts must link to units? Which payments are property-level vs accounting-level? |
| Accounting | Accounting documents, issued and received invoices, numbering series, basic accounting agendas, CZK and VAT support, bank statement or data-file import, export of accounting data/reports, receivables/payables. | Functional accounting agenda, sample documents, numbering setup, import/export samples, test protocol, documentation. | Yes | Is OntOS issuing invoices or preparing documents for external accounting? Which accounting system/export format is required? What VAT scenarios are mandatory? |
| Finance | Cash-flow, payments, financial plans, budgets, cost/revenue items, approval/control workflow for selected operations, management views by center/project if analysis confirms. | Configured financial overviews, approval setup, sample reports, test confirmation. | Yes, but likely thin slice | Which financial approvals are mandatory? What is the minimum useful cash-flow view? Are centers/projects used today? |
| Reporting and data | Reports over key ERP data, XLSX/CSV/PDF export, control dashboards, basic data consolidation, logical links between modules, data sources for company management. | Available reports/dashboards, list of data sources, sample exports, report descriptions, acceptance test results. | Yes | Which reports are acceptance-critical? Which exports must be PDF vs XLSX/CSV? Who consumes each report? |
| Shared ERP functions | Roles and permissions, audit logs for basic operations, user management, backup/recovery or equivalent operational recovery mechanism, secured access, Czech UI or Czech documentation. | Role/permission list, client access credentials, operating model, security documentation, backup/recovery procedure. | Yes | Which roles exist at handover? Who can access which legal entities? What audit records must be shown during acceptance? Czech UI or Czech docs: which is mandatory? |
| Data migration and interfaces | Import of available historical data from customer sources, especially spreadsheets, external exports, and paper records converted electronically. Integrations/import-export toward reservation/accounting/other systems only in analysis-confirmed scope. | Migration plan, migration protocol, migrated dataset list, completeness/correctness check, import/export samples. | Yes | Which source files exist? What data is mandatory for go-live? Which interfaces are actually required before handover? |

## Customer Discovery Question Bank

### Property Management

1. What property, building, unit, room, or space records exist today?
2. Which records are physical structure and which are rental/accommodation capacity?
3. Which contracts must be linked to properties or units?
4. Who are "clients/users of services" in customer language?
5. What does occupancy mean for long-term rental vs short-term accommodation?
6. Which operational tasks or requests must be tracked?
7. What data must be imported first?
8. What export formats are required for acceptance?

### Accounting

1. Which invoices/documents must be created in OntOS?
2. Which invoices/documents are only imported or exported?
3. Which numbering series are required?
4. Which VAT scenarios must work in Czech environment?
5. Which accounting system or export format is mandatory?
6. What bank statement format is available?
7. What counts as accepted accounting handoff?

### Finance

1. Which cash-flow view is used today?
2. Which payment states matter operationally?
3. Which budgets are tracked?
4. Which cost/revenue categories are mandatory?
5. Who approves selected financial operations?
6. Are centers or projects already defined?
7. What is the minimum finance module that is still valuable?

### Reporting And Data

1. Which reports are required for acceptance?
2. Which dashboards are operationally useful vs nice-to-have?
3. Which exports must exist and in which formats?
4. What source data should each report use?
5. How often must reports update?
6. Who signs off report correctness?

### Shared ERP Functions

1. Which user roles exist?
2. Which roles are internal, customer, accountant, admin, external operator, or guest?
3. Which legal entities can each role access?
4. Which operations must be audited?
5. What access evidence must be shown at handover?
6. What backup/recovery procedure is acceptable?
7. Is Czech UI mandatory, or is Czech documentation enough for V1?

### Migration And Interfaces

1. Which source spreadsheets exist?
2. Which external systems export data?
3. Which paper records must be converted?
4. Which data must be migrated before go-live?
5. What can be migrated later?
6. Which import/export samples must be shown at acceptance?
7. Which integrations are mandatory vs optional?

## End Of June Deliverables

By 2026-06-30, the repo should contain:

1. PoC result note.
2. Accepted Core/Shell/MicroVertical decision.
3. Accepted or revised ADR statuses for load-bearing decisions.
4. Core schema invariant checklist.
5. Module manifest plus private registry contract.
6. Action descriptor contract.
7. Module activation behavior matrix.
8. V1 acceptance matrix draft reviewed with customer input if possible.
9. First production module skeleton template.
10. Neo4j deferral decision, unless a mandatory graph use case appears.

## Working Rule

In June, every task must do at least one of these:

- prove or reject a Core architecture assumption
- make V1 delivery safer
- define acceptance evidence
- clarify customer use cases
- create reusable module scaffolding

Everything else waits.
