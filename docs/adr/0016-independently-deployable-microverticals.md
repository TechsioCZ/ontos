# ADR-0016: MicroVerticals preserve independent deployment seams

Status: Accepted on 2026-08-28. Supersedes ADR-0001 and ADR-0002, and supersedes the deployment and registration assumptions in ADR-0008.

## Context

OntOS originally described V0 as one jointly deployed TypeScript modular monolith. The implementation evolved to a stricter boundary: a MicroVertical owns one complete business capability and can be built, deployed, addressed, migrated, operated, and rolled back independently. Keeping the old classification as current guidance would permit private imports, shared repositories, cross-module transactions, and centralized executable registration that the app-local contract now forbids.

The architecture must retain simple co-location where it is operationally useful without making placement an implementation dependency or weakening module ownership.

## Decision

Every OntOS Foundational Module and Business Module is delivered as one independently deployable MicroVertical. The deployment `appId` and business `moduleId` remain distinct identities. Co-location is a Deployment Topology choice only; moving a MicroVertical between a shared host and a separate process or host must require deployment configuration or Adapter selection, not consuming business-logic changes.

Executable registrations, Actions, Policies, migrations, handlers, workers, repositories, routes, search implementations, and report implementations remain private to the owning deployment. Shell/Core and other modules must not import another deployment's manifest source, runtime registration, private code, database, repository, or transaction.

Shell/Core discovers only allowlisted, serialized deployment contracts and invokes governed structured entrypoints. Synchronous module communication uses the provider's published contract-derived typed client. Asynchronous communication uses published Outbox schemas and Core-owned delivery mechanics. No cross-module call may create a shared business transaction or synchronous dual write.

Authentication context, authorization, module-state and dependency-closure checks, typed failures, correlation, and contract validation apply at the same seam whether an Adapter executes locally or over a network. Co-location never implies trust. A dependency or deployment failure degrades only affected entrypoint closures, does not cascade persisted module state, and must leave unrelated healthy closures operable.

Core remains the business-neutral kernel. It owns contract validation, catalogs, gateways, invocation guarantees, delivery mechanics, and shared infrastructure; it does not acquire another module's executable implementation or business meaning.

## Considered options

1. **Keep a modular-monolith contract and extract services later.** Rejected because internal-only boundaries make placement, failure, data access, and release coupling part of business implementations and invite dependencies that cannot later be removed by configuration.
2. **Require every module to run on a separate host.** Rejected because independent deployability is a seam guarantee, not a mandate to pay distributed-runtime cost in every Environment.
3. **Preserve independent delivery seams with topology-neutral placement.** Accepted because it combines owner-local business cohesion with explicit contracts, operationally simple co-location, and reversible placement.

## Consequences

- "Modular monolith", "modulith", and "jointly deployable application" are historical OntOS architecture terms, not current classifications.
- Local and network Adapters must provide equivalent observable contract, identity, authorization, and error behavior.
- Module data and executable migration lifecycles are owner-local even when several modules use one physical Postgres service.
- Application Composition compatibility and transitive dependency closure govern installation, activation, and every entrypoint without weakening independent release boundaries.
- Cross-module workflows must use explicit orchestration, durable messages, compensation, and reconciliation instead of hidden transaction coupling.

## Implemented today versus production acceptance

The current app implements substantial boundary mechanisms: generated module contracts and private registrations, deterministic serialized deployment contracts, topology allowlisting, an all-or-nothing Installed Module Catalog, static private-import and database-boundary checks, structured module entrypoint gateways, module-state enforcement, audience-scoped Shell assertions, contract-derived Effect clients, owner-local schemas and migrations, and module-owned Outbox workers.

These mechanisms establish the code and runtime seam, but they do not by themselves prove production independence. Production acceptance still requires evidence for separate and co-located placement equivalence; compatible independent build, migration, rollout, rollback, and recovery; remote timeout, partition, crash, and backpressure behavior; typed affected-closure degradation with unrelated-module continuity; contract-version skew; observability and health/readiness; and backup/restore and incident runbooks. Foundational Module catalog support and complete Application Composition version/closure enforcement remain implementation work under the accepted composition contract.

## Migration impact

Current root guidance, diagrams, handoffs, and validation reports must either adopt this decision or carry an explicit historical notice. ADR-0001, ADR-0002, and ADR-0008 link here as their replacement. Shell/Core discovery must use serialized allowlisted contracts rather than private runtime-registration imports. Existing owner-local implementations remain valid; any cross-owner private import, shared repository, shared business transaction, centrally imported executable registration, or Core-managed module migration must be removed before the affected module is production-ready.
