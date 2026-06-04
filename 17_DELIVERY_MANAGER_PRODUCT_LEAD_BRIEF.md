# Delivery Manager / Product Lead Brief

Date: 2026-06-04
Audience: Delivery Manager / Product Lead

## What We Worked On This Week

This week we clarified how OntOS should move from architecture planning into a controlled 2026 delivery.

The most important correction is the planning terminology:

- **V0** is now treated as the preparation and foundation phase.
- **V1** is the mandatory ERP delivery by the end of 2026.

That means we are not treating the current architecture documents as the finished product specification. We are using them to prepare the Core platform, PoC, delivery controls, acceptance criteria, and customer discovery structure needed to deliver V1 safely.

## Current Architecture Direction

The intended product shape is:

- one application Shell
- shared Core platform services
- separate business modules implemented as MicroVerticals

Core is not a business module. Core provides the runtime guarantees every module needs:

- identity and user/principal resolution
- roles and permissions
- action execution
- audit logging
- outbox/background processing
- tenant and legal-entity isolation
- module activation
- media/documents foundation
- search/reporting foundations
- migration and data contracts

The business modules stay separate and are expected to evolve through direct customer discovery. The module areas are fixed, but the exact features inside them should be validated with the customer instead of specified as a full waterfall plan now.

## Why This Matters For Delivery

The 2026 delivery scope is broad: property management, accounting, finance, reporting/data, shared ERP functions, and data migration/interfaces.

If we start building module features before Core rules are proven, each module may implement permissions, audit, imports, reports, and data rules differently. That would create delivery risk and rework later.

The June focus is therefore to prove the common foundation first, then use customer conversations to shape the exact V1 features.

## What Was Validated

We ran a structured review of the documentation, architecture, schema plan, module plan, and delivery readiness.

Conclusion:

- The architecture direction is mostly sound.
- The docs are not yet enough to start full production feature development.
- We need a short preparation phase to define acceptance criteria, Core contracts, PoC results, and customer discovery questions.

The detailed technical report is in:

- `15_PRE_DEVELOPMENT_VALIDATION_REPORT.md`

The working June handoff is in:

- `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`

## PoC Planned For Next Week

Next week should be a focused PoC, not product feature development.

The PoC should prove:

- the Shell can host multiple MicroVertical modules
- one module action can run through Core
- the action can validate input, check context, and write to the database
- audit and outbox records are created
- user/principal resolution and permission checks can work
- tenant isolation can be enforced
- Effect SQL/Drizzle is suitable for the database layer

The PoC should use a tiny fake property/unit flow only to prove Core. It should not build the real property or accounting product module yet.

## What Product/Delivery Should Help With

The Product Lead / Delivery Manager should help turn the customer delivery table into a V1 acceptance matrix.

For each module area, we need:

- must-have workflows
- negotiable workflows
- required outputs and evidence
- user roles
- data sources
- import/export needs
- acceptance test scenarios
- customer questions

The most important customer discovery topics are:

1. What property/unit data exists today?
2. Which accounting outputs are required for acceptance?
3. Which finance reports or approvals are truly mandatory?
4. Which reports and exports must exist at handover?
5. Which user roles and permissions must be demonstrated?
6. Which historical data must be migrated before go-live?

## Recommended June Outcome

By the end of June, we should have:

1. PoC result and decision notes.
2. Confirmed Core/Shell/MicroVertical architecture.
3. V1 acceptance matrix draft.
4. Customer discovery question set.
5. Core schema and action contracts.
6. Module implementation template.
7. Decision on whether Neo4j is deferred.
8. Clear July implementation starting point.

## Key Message

We are not slowing delivery down by doing this preparation. We are reducing the risk that a small team builds six ERP module areas with inconsistent rules, unclear acceptance criteria, or missing audit/permission/data foundations.

June should make V1 buildable.

