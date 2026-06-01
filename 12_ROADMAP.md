# Roadmap

This roadmap is intentionally agile. It sets monthly delivery intent and architectural proof points; it is not a waterfall specification.

## End of May 2026 — throwaway PoC

The PoC should validate the stack and the architectural seams. It is expected to be disposable. It should prove UltraModern.js MicroVertical structure, design-system integration, BetterAuth session mapping to OntOS principal, SpiceDB permission checks, Postgres entity registry, relation edges, audit recording, outbox basics, module activation/deactivation, internal dogfood slice, and property/rental stubs. Neo4j can be tested as an optional projection spike, but the PoC should not make V0 depend on it.

The PoC should not implement product AI, full rental workflows, full billing, full accounting integration, or polished UX.

## June 2026 — architecture decision month

June should convert PoC learnings into decisions. Key outputs are a refined glossary, accepted/rejected ADRs, V0 scope lock, MicroVertical manifest shape, Core/MicroVertical boundaries, authz approach, entity model, relation model, outbox model, module activation model, and customer process clarification.

This month should avoid building a large production system before the architecture has been grilled. It should produce enough production skeleton to start safely in July.

## July 2026 — production foundation and property registry start

July should establish the production skeleton, tenant/legal entity model, principal model, BetterAuth integration, SpiceDB checks, module registry, action registry, entity registry, relation registry, audit, timeline basics, and the first `property.registry` slice.

The customer-facing property structure should begin with holding/SRO and property/unit registry skeletons. Internal dogfooding can start once these rails are working.

## August 2026 — property base, documents, search

August should build the property registry, contacts/CRM basics, document center basics, entity linking UX, search basics, module unavailable states, read-only/quarantine behavior, audit hardening, and permission tests. Internal dogfooding should begin to produce real feedback.

## September 2026 — long-term and short-term rental MVPs

September should deliver pilotable long-term rental and short-term reservation slices. Long-term rental should include lease contracts, tenant/contact links, unit links, deposits/basic payment schedules, terms, attachments, and invoice draft links. Short-term rental should include reservations, guests/contacts, reservation state, check-in/check-out basics, cleaning tasks, cancellation/change basics, and invoice draft links.

## October 2026 — billing and accounting workflow

October should deliver billing basics and accounting workflow/export. This includes invoice drafts, issued invoice basics, numbering series, legal-entity billing identity, receivables/payment state basics, client/company accounting workspace, document inbox basics, cost/supplier invoice basics, checklist/status workflow, and accounting export/import baseline.

Any delivery-scope changes should be identified before the late-October change review window.

## November 2026 — stabilization, import, UAT

November should stop adding major scope. Focus should move to real data imports, UAT scenarios, rental fixes, billing fixes, accounting export fixes, permission hardening, audit hardening, search stabilization, basic reports, and handover evidence.

Product AI remains out of scope.

## December 2026 — handover and acceptance evidence

December should deliver production/staging handover, final UAT, documentation, admin guide, user guide, function evidence, screenshots, handover materials, acceptance evidence, and support/hypercare plan.

## 2027 high-level business roadmap

Q1 2027 should focus on hypercare, deeper accounting integration, internal dogfooding, and e-shop connector discovery or first slice. Q2 should focus on e-shop connector and manufacturing discovery with Pulsar boundary definition. Q3 should focus on manufacturing light and Pulsar/machine event PoC. Q4 should focus on workflow automation, reporting/controlling, Forge v1, and product packaging for additional customers.
