---
status: proposed
---

# ADR-0032: One CoreSDK for Platform and Tenant Modules

Proposed. It records what the Product Owner has decided so far in the CoreSDK design interview and
the outcome of two four-model design councils. The interview is still open: this ADR gains decisions
round by round and is accepted only when the Product Owner confirms the complete design. Everything
below is target architecture; none of it is implemented yet.

## Context

OntOS modules are written in several styles. A neutral kernel exists (`@app/core-runtime/sdk`:
`call` and `transaction`), but only governed reads use it; Actions and Outbox Workers use earlier
forms. A module states one fact in several generated files, and a module has no way to declare an
inbound endpoint, a schedule, or an external connector, so those live in the Shell or as private
loops.

Two requirements now shape the boundary. Modules will be delivered through Module Federation for
both browser and server code. Tenants will later author their own modules, mostly through the Vibe
Module, and those modules must be created, versioned, reverted, and deleted without a product
release. V0 is close to complete; this decision shapes what follows it.

## Decision

### Authoring

1. **One CoreSDK.** Platform Modules and Tenant Modules are authored against the same CoreSDK, the
   same kernel (`call`, `transaction`), and the same Module Definition. Actions and Outbox Workers
   move onto the kernel, and the earlier authoring forms are removed as their callers migrate. A
   Tenant Module differs from a Platform Module in what it is granted, never in how it is written.
2. **A closed vocabulary.** A Module declares only what the CoreSDK vocabulary names. What it
   publishes: Resources, Actions, reads, Published Events, interface contributions, Interface Slots,
   and search. What it receives and runs: Outbox Workers, schedules, and Inbound Endpoints. What it
   needs: other Modules' public operations, settings, a Module Audience, and its outside
   dependencies. Any Module may call another Module's public operations and embed its public
   interface contributions through the same contracts. Adding a vocabulary item is a Core change.
3. **Enforce on types, with Effect, from declared values.** The CoreSDK reuses Effect Schema, Layer,
   requirements, and typed errors so that a Module that violates its own declarations does not
   compile. Each outside dependency (a datastore, an external host, a secret) is declared once as a
   value in the Module Definition, by Platform Modules too. Types are derived from those values and
   check the wiring, and the Module Runtime enforces the declaration from outside the Module's code.
   A type-only declaration is not sufficient: types are erased at build and cannot see what a
   dependency does internally.
4. **Codesmith stays; rules, blueprints, and derived outputs are kept apart.**
   - Rules every Module must keep (authorization, idempotency, recovery, audit, revision checks,
     delivery) are CoreSDK code that the kernel applies. They are never generated into a Module, so
     they cannot fall behind.
   - A Module Blueprint generates business structure once: schemas, handlers, pages, and the
     declarations that name them. The author owns that code afterwards and regeneration never
     overwrites it. A blueprint change reaches an existing Module only as a codemod with a
     reviewable diff. The first Module Blueprints are a Resource with its standard reads, an Action,
     a Published Event with its Outbox Worker, and a list-and-detail page.
   - The manifest, the runtime registration, the provider contract package, and the Module
     Federation exposes are build outputs derived from the Module Definition. They are not checked
     in and not hand-edited, and the generator's marker comments go.
   - Only the trusted build produces what ships. No author, human or AI, supplies a manifest, a
     registration, or a contract.
   - Every Codesmith operation can be called by a program and changes the Module Definition
     directly. This makes it possible to limit an AI author to Codesmith operations for a Module's
     structure and to free writing for the bodies of handlers and pages. Whether the Vibe Module
     applies that limit is decided with the Vibe Module.

   Each Action, read, Published Event, and page is its own exported value in its own file, and the
   Module Definition lists them. Type checking with tsrs and linting with oxlint can then scale
   their parallelism across those files, and the layout is chosen to support that. Database
   migrations are authored source and immutable once applied. The source of every immutable Module
   version is retained so that the version can be rebuilt.

### Data and outside systems

5. **The governed PostgreSQL store is the default.** A Module may call an external service directly,
   so that Core is not the path for all load. Owning a datastore other than the governed store is a
   capability the design allows for; supporting other databases is not planned now. Either is a
   declared and justified exception, not a standard choice.
6. **Canonical facts stay in the governed store.** Resources that other Modules reference and
   Published Events are committed there, where the kernel commits state, event, and audit together.
   A Module's own datastore holds data that no other Module references.
7. **Inbound Endpoints, Published Events, and Outbound Webhooks are vocabulary items.** A request
   from outside OntOS arrives at an Inbound Endpoint that the owning Module declares, not at a
   handler in the Shell. A Module reacts to another Module's Published Event through an Outbox
   Worker it declares. An Outbound Webhook is Tenant configuration over a Published Event and needs
   no Module code.
8. **A Module Audience is a CoreSDK capability.** A Module that serves people outside the staff
   Shell, such as a game with a minimal registration, declares a Module Audience: who may register,
   which details are collected, and which login methods are offered. Core runs registration, login,
   sessions, and account recovery for it on BetterAuth, so that the login methods BetterAuth offers
   can be supported. Each Module Audience is isolated: its members are kept apart from staff and
   from every other Module Audience and never gain staff access. The declaring Module receives
   operations and interface primitives with which it can build a management interface for its
   members when it needs one. The first CoreSDK version includes this capability, and it applies to
   any Module. Commerce owns a separate realm for Commerce Portal Accounts today
   ([ADR-0017](0017-commerce-application-boundaries.md),
   [ADR-0014](0014-authenticated-principal-session.md)); it moves onto a Module Audience later.

### Platform and Tenant Modules

9. **Platform Modules are closed to per-Tenant modification.** A Tenant builds a Tenant Module on a
   Platform Module's public contract or, where the Platform Module is marked replaceable, uses a
   Module Replacement. Dependants bind to a Module Contract Identity, not to its implementation. The
   first CoreSDK version makes that identity explicit; Module Replacement itself is not available
   until a later version.
10. **A Platform Module can be extended in exactly two ways in the first CoreSDK version.** Another
    Module reacts to its Published Events, or shows a public component in an Interface Slot the
    Platform Module offers. Custom fields on a Platform Module's Resources come later.
11. **A Tenant Module's server code runs in its own Module Runtime**, apart from Core, the Shell,
    and every other Module. How a Tenant is charged for it is outside this decision.
12. **Isolation of a Tenant Module's interface in the browser is deliberately not designed now**,
    because the Vibe Module is still far away. Running that interface in a sandboxed frame on its
    own origin was proposed and rejected. Isolation is revisited before Tenant Modules ship.

### Runtime and delivery

13. **Module code is runtime-neutral.** The CoreSDK does not assume Node.js. Node.js, Bun, and
    Cloudflare Workers are intended targets and other serverless hosts are not excluded, with Module
    Federation for browser and server code.
14. **One version of the shared foundations.** One CoreSDK version pins exactly one version of
    Effect, React, and the design system. Each is a Module Federation shared singleton, and
    admission to the Application Composition rejects a Module built against another version. Inside
    one runtime that is one shared instance; between runtimes it is the same pinned version.
15. **Several immutable versions of one Module may be live in one deployment.**
    - Which version serves a request is selected without a new deployment: by Environment, by
      domain, and by a rule over Tenants or people, such as a beta group or a share of traffic in an
      A/B test. An OntOS operator can, for example, run a domain on which every Platform Module is
      at its latest version.
    - OntOS operators select versions of Platform Modules. A Tenant's administrators select versions
      of that Tenant's own Tenant Modules. A Tenant never selects the version of a Platform Module.
    - The Application Composition stays the one authority for what is live. An artifact store,
      Zephyr Cloud included, only stores immutable files.
    - The selection is data that can be changed and overridden at runtime. It is never a value
      pinned in code.
    - Each version states which database migrations it needs applied. Versions are live side by side
      only when they need the same migrations, and a version that needs a further migration replaces
      every older version.
16. **A Tenant Module never blocks a CoreSDK upgrade.** Every Platform Module builds and passes on a
    new CoreSDK version before an Environment moves to it. A Tenant Module that still fails after
    the automatic codemod does not hold the Environment back. Its Tenant receives a highly visible
    warning, before the Environment moves, that the Module will stop on the new CoreSDK version
    unless OntOS repairs it with an agent. A Module still failing when the Environment moves stops,
    because decision 14 admits no Module built against another version.

### Interface

17. **The design system is the only interface surface.** The CoreSDK re-exports `@techsio/ui-kit`,
    so that one version is enforced and shared correctly through Module Federation, and a Module
    imports interface components only through the CoreSDK. There is no separate administration
    interface package: a piece generic enough for every Module belongs in the design system or in
    the CoreSDK itself.
18. **Themes are runtime data attached to a Tenant.** A theme is never hardcoded into a build: it is
    applied at runtime and can be swapped without a rebuild or a redeployment. It provides a light
    mode, a dark mode, or both. A Module follows its Tenant's theme. A Module may optionally alter
    that theme or bring its own for its interface; this is supported but not configured by default.
19. **The staff Shell is the first interface host.** Channel Applications later become Modules; they
    are out of scope for the first CoreSDK version.
20. **One Business Module remains one MicroVertical**
    ([ADR-0016](0016-independently-deployable-microverticals.md)), and every Module publishes its
    Resources under the one ResourceRef
    ([ADR-0006](0006-explicit-domain-tables-plus-resource-ref.md)).

### Proving the first version

21. **Three Modules move to the CoreSDK first and prove it before the others migrate.** They are
    chosen to differ as much as possible. `projects` is small and has an interface. `payment` has
    the hardest server side: provider notifications, schedules, and recovery. The third is an open
    point.

## Open points

These are not decided yet. They are listed so that no reader takes the decisions above as complete.

- The third Module of decision 21. A new tagging module was proposed and not accepted. What the
  third Module must prove, and which Module it is, is asked again.
- The names Module Audience and Interface Slot. They are proposed and the Product Owner has not
  confirmed them.
- What overriding the selection in decision 15 covers beyond an operator changing it, for example
  one person previewing another version.
- Where the source of a Tenant Module lives. The Product Owner leans towards files that OntOS itself
  stores and versions.
- Which module state a Tenant Module enters when it stops under decision 16.
- When the Commerce Portal realm moves onto a Module Audience.
- Whether inference from one Module Definition stays fast and readable at the size of the largest
  module. It is measured before the current representations are deleted.
- The exact shape of the Module Definition, how the CoreSDK is packaged for a Module built outside
  this repository, and the migration order of the remaining Modules.

## Considered options

Two councils (GPT-6.2 Astra, GPT-6.1 Sol, Claude Opus 5.5, Claude Fable 5.2) each chose the accepted
option unanimously.

**One SDK or two.**

1. **One SDK whose customer tier is only a smaller grant.** Rejected as the whole answer: it
   standardizes primitives but leaves every pattern choice to each author, which is where
   AI-authored modules diverge.
2. **A separate, restricted customer SDK.** Rejected: two contracts drift, a Tenant Module cannot
   graduate into a Platform Module without a rewrite, and composition stops being symmetric.
3. **Declarative-first modules interpreted by Core.** Rejected: the interpreter becomes the limit of
   what a module can do, and it puts module behavior inside Core.
4. **One kernel with layered authoring through Module Blueprints.** Accepted.

**Codesmith's role.**

1. **Generate once and derive the rest, with no library layer.** Rejected: rules such as
   authorization and idempotency would be copied into every Module, and each CoreSDK upgrade would
   need a codemod across all of them.
2. **Keep checked-in generated files guarded by a drift gate.** Rejected: it keeps files that mix
   generated and authored content, which is today's problem.
3. **Patterns only as library code.** Rejected: it reduces Codesmith to creating a folder and leaves
   structure to each author.
4. **Rules as CoreSDK code, structure generated once, the rest derived at build (decision 4).**
   Accepted.

The second council split on one point: whether an AI author must change declared structure only
through Codesmith operations, or whether the trusted build alone decides what ships. Decision 4
takes both: the trusted build is the rule for every author, and Codesmith operations make the limit
possible.

## Consequences

- A CoreSDK upgrade is a rebuild of every Module, Tenant Modules included, because the shared
  foundations move together. This is why decision 4 retains the source of every version and decision
  16 says what happens to a Tenant Module that fails the rebuild.
- What crosses a boundary between two runtimes is a serialized contract: operation schemas, typed
  outcomes, ResourceRefs, events, and interface contribution contracts. Live Effect values, Layers,
  and transactions do not cross it.
- Types prove that a Module's wiring matches its declarations. They do not confine code that ignores
  the CoreSDK. Confinement of a Tenant Module is the job of its Module Runtime.
- The contract check stops comparing generated files with their source. It compares a candidate
  public contract with the released one and reports what changed.
- Accepted decisions that the points above contradict need a superseding decision before those
  points ship:
  - [ADR-0020](0020-governed-application-composition.md) treats every module as first-party code in
    one browser realm with no further trust tier, and one composition revision admits one build per
    Module. Its strict shared-singleton rule already covers decision 14.
  - Decision 15 must be reconciled with ADR-0020, which rejects Tenant-pinned application versions,
    with [ADR-0017](0017-commerce-application-boundaries.md), which rejects customer-pinned product
    versions, and with the Build Revision term, which is not a customer-selectable product version.
    Decision 15 keeps one part of their intent: a Tenant never selects the version of a Platform
    Module. Selecting by a rule over Tenants, and letting a Tenant select the versions of its own
    Tenant Modules, still contradicts them. ADR-0020 also pins one browser document to one
    composition revision and rejects runtime hot-swap; whether a changed selection may take effect
    inside an open document is part of the same reconciliation.
  - Decision 8 changes ADR-0017 and ADR-0014, under which Commerce owns its portal realm.
  - Decision 5 allows an exception to [ADR-0004](0004-postgres-canonical-neo4j-projection.md), which
    makes PostgreSQL canonical for operational facts. ADR-0004 is amended before the first Module
    uses that exception.
- [ADR-0007](0007-no-product-ai-in-v0.md) keeps the Vibe Module out of V0 and still does.
  [Product](../PRODUCT.md) is amended in the same change to name Tenant Modules as a target for what
  follows V0.
