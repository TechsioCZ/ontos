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
- exact module-contract and Module Federation manifest URLs with SHA-256 evidence;
- allowed Shell contributions and Module Federation exposes;
- dependency identities;
- required Shell contribution ABI and Core capabilities; and
- strict shared-singleton versions.

A pure validator rejects the complete candidate on schema, identity, ownership, dependency,
contract, expose, ABI, capability, singleton, or observed-digest contradictions. Network collection,
publication, promotion storage, and live Shell loading remain outside this validator.

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
