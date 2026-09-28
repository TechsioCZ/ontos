# ADR-0020: Governed runtime Application Composition

Status: Accepted.

## Context

Topology currently enumerates Shell remotes at build time. That couples installing a new compatible
MicroVertical to a Shell deployment and makes delivery placement look like business composition.
OntOS must support independently deployed MicroVerticals on different providers while keeping one
auditable authority for what the Shell may load.

## Decision

OntOS owns a versioned, provider-neutral Application Composition document. Topology remains delivery
inventory; Application Composition is the sole runtime authority for the approved module graph and
exact artifacts. A remote cannot register or promote itself.

Each immutable revision is identified by a SHA-256 value assigned by its publisher and pins:

- deployment `appId` and build identity;
- module and public-contract identity/version;
- exact module-contract URL with SHA-256 evidence and, for a browser module, its Module Federation
  manifest URL with SHA-256 evidence;
- allowed Shell contributions and Module Federation exposes;
- dependency identities;
- required Shell contribution ABI and Core capabilities; and
- strict shared-singleton versions.

A pure validator rejects the complete candidate on schema, identity, ownership, dependency,
contract, expose, ABI, capability, singleton, or observed-digest contradictions. Network collection,
publication, promotion storage, and live Shell loading remain outside this validator. A selected
module admits its complete observed Shell-contribution and Federation-expose surface rather than a
potentially broken subset. Candidate Shell/Core compatibility claims must also match trusted
evidence from the deployed runtime.

Every deployed module is part of the composition, so absence from it is authoritative evidence that a
module is not installed. A browser module (`federation.execution: 'browser'`) pins its complete observed
Module Federation expose surface; every public component its deployment contract declares must be part
of that surface. A server-only module (`federation.execution: 'server'`) ships no browser remote, declares
no public components, and joins no shared browser singleton scope. Core defines the Shell contribution ABI
(`ontos.shell-contributions@1`); a deployed Shell reports it with its Core capabilities at
`/.well-known/ontos-shell-runtime.json`, and its strict shared singletons are observed from its own
Module Federation manifest. Until explicit public-contract versioning exists, a module's public contract
is `{ id: moduleId, version: <deployment contract schema version>, sha256: <digest of the served contract> }`.

Promotion is explicit and audited. Rollback explicitly promotes a previously validated immutable
revision; there is no automatic persistent last-known-good selection. Tenant module state controls
availability and revocation only—it never selects artifact versions.

One browser document is pinned to one composition revision. Routine upgrades take effect on a full
reload or new document and never use Module Federation forced replacement. Remote UI executes only
in the browser. Shell/Core SSR renders stable framing and placeholders; independently deployed
MicroVertical code does not execute inside the Shell/Core Node.js process.

Current MicroVerticals are governed first-party code in the same browser realm. This decision does
not add third-party signing, iframe sandboxing, or another trust tier. A future deployment-provider
adapter, including Zephyr Cloud, may supply immutable artifact evidence, but OntOS remains the
composition authority and portable contracts contain no provider metadata or credentials.

## Current deployment adapter

The stage adapter (`app/scripts/publish-active-application-composition.mts`) observes each deployed
service's served contract, Module Federation manifest, and the Shell runtime contract with bounded
fetches, derives the candidate, validates it, and publishes one snapshot `{ composition, observedAt,
validUntil }` as the Zerops project variable `ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON`.
The revision is the SHA-256 of the canonical composition with its revision zeroed, and publication
rejects different content under an already-published revision. Consumers read the variable at process
start, so every publication restarts them. Because consumers refuse to start without a snapshot, a
deploy publishes the inventory without the consumers it is about to deploy, deploys them, then observes
and publishes the complete inventory. A scheduled workflow re-observes and re-publishes before
`validUntil`; the validity window (24 hours) and refresh cadence (every 6 hours) live only in
`ACTIVE_APPLICATION_COMPOSITION_POLICY`. Binding revisions to immutable executable release records for
rollback remains a follow-up in [TechsioCZ/ontos#374](https://github.com/TechsioCZ/ontos/issues/374).

## Consequences

- A compatible MicroVertical update or new installation can be promoted without rebuilding or
  redeploying Shell.
- Incompatible deployments may exist for inspection but cannot become active composition.
- Runtime integration must degrade a failing remote locally and keep healthy modules visible.
- Current topology allowlisting and generated lazy imports remain compatibility bridges until the
  publisher and Shell loader follow-ups replace them; this ADR does not itself change live loading.
- End-to-end Zephyr compatibility still requires the spike recorded in
  [TechsioCZ/ontos#367](https://github.com/TechsioCZ/ontos/issues/367).

## Rejected alternatives

- **Topology as runtime authority:** rejected because every new remote would continue to require a
  Shell deployment.
- **Tenant-pinned application versions:** rejected because tenants choose available modules and
  configuration, not product artifact lines.
- **Automatic fallback or runtime hot-swap:** rejected because either can silently change the code
  serving an active document.
- **Provider-owned composition:** rejected because deployment placement must not own business
  installation, activation, or revocation.
