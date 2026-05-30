# Context and constraints

TERP is being shaped from a concrete customer delivery and a broader product opportunity. The immediate customer need is a committed ERP for a property/rental business context. The long-term product direction is a reusable ERP and company ontology platform that can serve the internal operator, the current customer’s multiple companies, and future larger customers.

## Delivery context

The customer delivery is framed as a new ERP system for a property/rental operator. The source material describes a company with insufficient software support, no internal system for managing the overall business agenda, and processes split between Booking.com, Excel, paper, and external administration/accounting. The intended outcome is a new ERP system that unifies agendas, improves process management, increases digitalization, and reduces manual error.

The draft module analysis expands that into a holding/asset/property management ERP: multiple SRO/SPV entities, property and unit registry, long-term rentals, short-term reservations, pricing, billing, payments, accounting exports, cost management, service/energy settlement, facility management, CRM, communication templates, document center, reporting, roles/permissions, administration, integrations/API, and future external portals.

The customer delivery materials create hard delivery constraints. The committed scope needs a working ERP by the end of 2026, with enough acceptance evidence to show that the delivered system supports the required business workflows. Delivery documentation will matter: scope evidence, acceptance records, handover materials, operational documentation, and audit-ready records.

## Product context

The broader TERP ambition is not to write a one-off ERP for one customer. The intended long-term category is a temporal company ontology system with ERP MicroVerticals as the first application layer. Important business objects should be addressable entities; relationships should be typed, auditable, and time-aware; and future modules should be easier to add because they plug into the same Core.

This long-term direction must not distort V0. V0 is not the vibemodule, not an AI assistant, not an autonomous-agent platform, and not a full manufacturing/machine-prediction system. V0 must first prove that the Core and MicroVertical architecture can deliver concrete ERP functionality without becoming a fragile bespoke system.

## Team and execution constraints

The near-term implementation capacity is small: one founder prototyping in May/June, a second developer joining fully in June, partial product/UX/UI support, and heavy use of coding agents. That capacity rules out a distributed microservice architecture, a custom workflow engine, a user-facing no-code platform, and deep AI product features in V0.

Heavy coding-agent usage changes implementation throughput but does not remove the need for strong architecture. It increases the importance of precise vocabulary, module boundaries, action conventions, tests, generated scaffolds, and reviewable ADRs. Agents can generate code quickly; they can also generate a large amount of inconsistent code quickly if the architecture is underspecified.

## Current intended stack

The intended PoC stack is UltraModern.js with MicroVerticals, an existing design system, Postgres, Neo4j, SpiceDB, and BetterAuth. This is not yet a final architecture. The PoC should validate the combination and reveal which parts are overkill, unsafe, or misaligned.

The stack division is currently understood as follows. UltraModern.js provides the unified application runtime and MicroVertical structure. The design system provides UI consistency. Postgres is canonical operational storage. Neo4j is a graph projection/read model for ontology exploration and relationship traversal. SpiceDB is the authorization graph. BetterAuth is authentication/session DX.

## V0 non-goals

The following are deliberately not V0 product scope: user-facing AI assistant, autonomous agents, document AI automation, process autodiscovery, vibemodule as a user feature, full manufacturing ERP, machine/PLC integrations, predictive maintenance, full channel manager integrations, portals, and a general low-code builder.

Some of those capabilities must be prepared for architecturally. For example, actions should later be callable by agents, entity relationships should later support AI context, and MicroVertical manifests should later feed a module generator. Preparation does not mean implementation in V0.
