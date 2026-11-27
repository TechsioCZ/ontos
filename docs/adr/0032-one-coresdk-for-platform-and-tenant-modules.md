---
status: proposed
---

# ADR-0032: One CoreSDK for Platform and Tenant Modules

Proposed. It records what the Product Owner has decided so far in the CoreSDK design interview and
the outcome of three four-model design councils. The interview is still open: this ADR gains
decisions round by round and is accepted only when the Product Owner confirms the complete design.
Everything below is target architecture; none of it is implemented yet.

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

Tenant Modules come later, and the Product Owner does not settle their decisions fully now. Wherever
a decision below concerns only Tenant Modules, it is direction, settled when Tenant Modules are
designed: for example decisions 11 and 12, Module Replacement in decision 9, how a Tenant Module is
handled in decision 16, and the Tenant administrator's part of decision 15. All other decisions are
proposed for acceptance when the Product Owner confirms the complete design, except the parts listed
under Open points.

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
   can be supported.
   - A Module Audience exists per Tenant and is isolated: its members are kept apart from staff and
     from every other Module Audience and never gain staff access. The same e-mail address
     registered in two Module Audiences is two separate accounts.
   - Each member is a Principal, so authorization and audit run through the same Core checks as for
     staff. A member never holds a staff Role.
   - Core creates the storage of a Module Audience from one template when the Module is installed. A
     Module writes no migration for it.
   - The declaring Module receives operations and interface primitives with which it can build a
     management interface for its members when it needs one.
   - Accounts stay separate, but a member can be linked to a Party of the same Tenant in the Party
     Registry, so that one real person who belongs to two Module Audiences of that Tenant shows as
     one Party. Members of Module Audiences in different Tenants are never linked to one Party.
     Every Module Audience publishes the same standard Published Events, such as a member
     registering, signing in, or being removed, which any analytics Module can consume.

   The first CoreSDK version includes this capability, and it applies to any Module. Commerce owns a
   separate realm for Commerce Portal Accounts today
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
15. **Several immutable versions of one Module may be live in one deployment, selected through
    Release Channels.**
    - A Release Channel is a named, complete selection of one version of every Platform Module. An
      OntOS operator attaches it to an Environment, a domain, a Tenant, or a group of people and
      changes it at runtime, without a new deployment. An operator can, for example, run a domain on
      which every Platform Module is at its latest version.
    - An operator does not have to select every version by hand. A Release Channel can be defined
      through groups of Modules, for example "every Business Module at its stable version" or "every
      Business Module that depends on a named Module at its beta version". OntOS offers presets, and
      an operator can also define a Release Channel completely on their own.
    - Each Release Channel has a setting that says whether it moves to a newer qualifying version on
      its own or waits until an operator applies it. In the presets, the production channel waits
      and the beta and latest channels follow on their own. Whichever setting a channel has, Core
      first runs the compatibility check of this decision; a version that fails it is not moved into
      the channel, and the operator is warned. A version that needs a further migration always fails
      that check and goes live the other way, by replacing every older version.
    - An operator with permission can select a Release Channel or a single Module version for
      themselves, for testing. Core issues a signed preview that expires and is bound to that
      person, and it applies to browser and server code alike.
    - OntOS must also support A/B tests and gradual rollout, for example to 10 % of customers and
      then to 25 %. They are not part of the first version, and how they are modelled is an open
      point.
    - All of this is built on Module Federation for both browser and server code and on
      MicroVerticals.
    - OntOS operators select versions of Platform Modules, through Release Channels. A Tenant's
      administrators select versions of that Tenant's own Tenant Modules. A Tenant never selects a
      Release Channel or the version of a Platform Module.
    - The Application Composition stays the one authority for what is live. OntOS stores the
      immutable files of every Module version itself, on S3-compatible object storage, and never
      needs Zephyr Cloud to run. The Zephyr build plugin stays optional. Delivery is still Module
      Federation.
    - The selection is data that an operator can change and override at runtime, but only between
      versions that Core admits under the check in the next point. It is never a value pinned in
      code.
    - The build records, for every Module version, the database migrations it needs and its public
      contract. Core lets two versions be live side by side, and lets the selection change between
      them in either direction, only when they need the same migrations and their public operations,
      Published Events, and embedded interface contracts are compatible in both directions. When
      Core cannot prove that, it refuses, and no operator can override the refusal. A version that
      needs a further migration is not selected this way; it goes live by replacing every older
      version.
    - A switch can move a Module's server code as well as its browser code.
    - An open browser document is not simply left on the version it loaded until its next reload,
      because that could lead to serious problems after a breaking change. The person is shown that
      a new version exists, and OntOS replaces the running version inside the open document:
      - A compatible version is offered. The document keeps working, and the new version applies
        when the person accepts it. If they have not accepted it, it applies on its own the next
        time they navigate to another page, as long as no form holds unsaved input.
      - When the new version needs a database migration that the loaded version does not, the
        replacement is mandatory rather than offered, because the old code cannot talk to the
        migrated server. The person is warned first, what they have entered is saved, the running
        version is replaced, and what they entered is restored.
      - What a person has entered in a form is kept because it lives in the form model of the
        CoreSDK, outside the Module's components. Every Module form uses that form model, and a lint
        rule enforces it. State that a component keeps only for itself, such as a scroll position or
        an open menu, is not kept.
      - When a form differs between the two versions, the fields that still exist are restored and
        the person is told which ones were dropped.
      - A new CoreSDK version cannot be taken in place, because the shared foundations of decision
        14 cannot be exchanged inside a live document. The document reloads itself and restores what
        was entered in the same way. Passwords and similar fields are excluded from what is stored
        for that reload.
      - A document moves from one complete selection of versions to another and never runs a mix of
        the two.
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
    the hardest server side: provider notifications, schedules, and recovery. The third is a small
    tagging module, for labels that staff put on other Modules' records. It proves the two extension
    points of decision 10 and attaching to any Module's Resources by ResourceRef.

### Package and migration

22. **The CoreSDK is its own package, `@ontos/sdk`.** It has a small public surface for authoring,
    interface, and testing, apart from Core's internals. A Module imports nothing else from Core,
    and a lint rule enforces that. The package lives in this repository and is published to a
    registry only when the first Module is built outside it.
23. **Modules migrate one at a time.** A migrated Module and one not yet migrated keep talking over
    the same wire contracts, so no Module waits for another. Each earlier form (the Action and
    Outbox Worker definition forms and the generated manifest files) is deleted when its last user
    has migrated. Migrating a Module also turns its direct imports of other Modules into declared
    calls.

### The shape of a Module Definition

Decisions 24 to 26 come from the third council. The Product Owner accepted decision 24, adopted
decision 25 because all three council delegates recommended it, and decided in decision 26 that the
build generates the list. The amendments listed under decision 24 were recommended by all three
delegates and are recorded on that basis, without a separate decision by the Product Owner.

24. **A declaration is a named class in its own file, and its handler is in a separate file.**
    Everything a Module declares is one named class in its own file. The class holds data only: its
    key, its schemas, its typed errors, its access rule, and the lists of what its handler may call,
    use, and publish. The handler is created from that class in a separate file and takes every type
    from it, so an author writes no type annotation. A handler that calls an operation, reads a
    setting, uses an outside dependency, or publishes an event that its declaration does not list
    does not compile. The Module Definition is one class that lists the declarations of the Module.

    For example, the declaration of an Action that assigns a tag names its key, its payload,
    success, and error schemas, its access rule, the one operation it calls, the one setting it
    uses, and the one event it publishes. Its handler can reach nothing else.

    The amendments on which all three delegates agreed belong to this decision:
    - A page or a component is bound to its declaration in the same checked way as a handler, not
      named by a path in a string.
    - A call that writes declares the read through which its outcome is recovered.
    - An Inbound Endpoint verifies a request with one of the named signature schemes that the kernel
      owns.
    - The CoreSDK checks that a Module declares nothing outside the vocabulary of decision 2 and
      that every key carries the identifier of its Module.

    The owning Module of a Resource is part of its type, so a handler that writes a Resource of
    another Module does not compile. This point was not put to the Product Owner and the delegates
    did not all agree on it; it is recorded because it follows from decision 3, which enforces on
    types. The alternative was a lint rule with the runtime check of the kernel.
25. **A provider publishes references, never its declaration classes.** For every public operation,
    Published Event, and public component, the trusted build produces a reference: its schemas as
    runnable code, its types, and a machine-readable description. Another Module imports only
    references. The settings, outside dependencies, and handlers of a provider never leave it; the
    council showed that publishing the declaration classes would expose them. Public error types and
    schemas therefore live in files that import nothing private.
26. **An explicit, checked list binds handlers to declarations, and the build generates it.** The
    build generates that list from the Module Definition and the handlers. A file name never decides
    which handler runs. A missing, duplicated, or orphaned handler fails the build. The list is a
    build output like the registration in decision 4, so a Module keeps one authored list, its
    Module Definition. The alternative, a second authored list to which Codesmith appends a line,
    was rejected. The accepted cost is that type checking needs the generated list, so a fresh
    checkout shows type errors until it has been generated once; the development and check commands
    generate it.

## Open points

These are not decided yet. They are listed so that no reader takes the decisions above as complete.

- How A/B tests and gradual rollout are modelled (decision 15).
- When the Commerce Portal realm moves onto a Module Audience.
- Whether inference from one Module Definition stays fast and readable at the size of the largest
  module. It is measured on a real Module before the current representations are deleted.
- For Tenant Modules, later: where their source lives (the Product Owner leans towards files that
  OntOS itself stores and versions), and which module state a Tenant Module enters when it stops
  under decision 16.

## Considered options

Three councils of GPT-6.2 Astra, GPT-6.1 Sol, Claude Opus 5.5, and Claude Fable 5.2 were held. The
first two each chose the accepted option unanimously. In the third, Claude Fable 5.2 made the
proposal, and the three other seats accepted option 4 only with the two changes named under it.

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

**The shape of a Module Definition.** Three working prototypes of the same Module were built and
compared before the council chose.

1. **Contract first.** Every declaration is a plain value in a contract folder, and handlers are
   bound to those values in a separate implementation folder. Not chosen on its own.
2. **Co-located.** A declaration and its handler are one value in one file, and a build step strips
   the handlers to produce what other Modules import. Not chosen on its own.
3. **A class for every declaration, with separate handlers.** The base of the accepted option.
4. **Named declaration classes with separate handlers, references published for each public
   operation, and an explicit, checked handler list (decisions 24 to 26).** Accepted. The proposal
   put to the council bound handlers by a naming convention and let other Modules import the
   declaration classes of a provider; all three delegates required both to change.

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
- The shape of decision 24 relies on type inference across files, so Module code cannot use
  TypeScript's `isolatedDeclarations` mode. Checking file by file still works.
- When the Product Owner confirms the complete design, this ADR is accepted for everything outside
  the Tenant Module direction, and ADR-0004, ADR-0014, ADR-0017, and ADR-0020 are each marked
  partially superseded by it, naming the exact point that changed. Until then those decisions stand:
  - [ADR-0020](0020-governed-application-composition.md) admits one build per Module in one
    composition revision; decision 15 changes that. It also treats every module as first-party code
    in one browser realm with no further trust tier; that stays in force until Tenant Modules are
    designed. Its strict shared-singleton rule already covers decision 14.
  - Decision 15 must be reconciled with ADR-0020, which rejects Tenant-pinned application versions,
    with [ADR-0017](0017-commerce-application-boundaries.md), which rejects customer-pinned product
    versions, and with the Build Revision term, which is not a customer-selectable product version.
    Decision 15 keeps one part of their intent: a Tenant never selects the version of a Platform
    Module. Attaching a Release Channel to a Tenant or to a group of people, and letting a Tenant
    select the versions of its own Tenant Modules, still contradicts them.
  - ADR-0020 pins one browser document to one composition revision, lets a routine upgrade take
    effect only on a full reload or a new document, never uses Module Federation forced replacement,
    and rejects runtime hot-swap because it can silently change the code serving an active document.
    Decision 15 replaces that rule. The person is shown that a new version exists, and the running
    version is replaced inside the open document: when the person accepts it, at their next
    navigation for a compatible version, and always for a version that needs a further migration.
    Decision 15 keeps one part of ADR-0020's intent: a document never runs a mix of two selections.
  - Decision 8 changes ADR-0017 and ADR-0014, under which Commerce owns its portal realm. Linking a
    member to a Party leaves the Party Registry as the owner of shared identity
    ([ADR-0015](0015-party-registry-owns-shared-identity.md)).
  - Decision 5 allows an exception to [ADR-0004](0004-postgres-canonical-neo4j-projection.md), which
    makes PostgreSQL canonical for operational facts. ADR-0004 is amended before the first Module
    uses that exception.
- [ADR-0007](0007-no-product-ai-in-v0.md) keeps the Vibe Module out of V0 and still does.
  [Product](../PRODUCT.md) is amended in the same change to name Tenant Modules as a target for what
  follows V0.