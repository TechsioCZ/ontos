---
status: accepted
---

# ADR-0031: Core Media Launch uses one Current V1 per Media Asset

Accepted by the Product Owner for [D20 / #1428](https://github.com/TechsioCZ/ontos/issues/1428) and
the [roadmap #253, step 20](https://github.com/TechsioCZ/ontos/issues/253#issuecomment-5661414584).

## Context

OntOS needs a small Core-owned capability to persist and govern access to files. The existing Core
Media Asset is the durable identity of one file intake. Catalog already relies on an owner-issued
Current revision through `CatalogDocumentOwnerRevision`; removing that contract would change an
accepted downstream domain boundary. Implementing an independent Documents owner, stable
multi-version Document aggregate, and revision publication lifecycle would expand D20 beyond
the approved Launch scope.

The considered Launch alternatives were a full versioned Documents model, changing the existing
Catalog Current contract to remove revisions, and preserving that contract with a single
logical revision per Media Asset. The Product Owner chose the last option.

## Decision

For Launch, each independently ingested file is represented by a distinct Core-owned Media Asset,
including when another independent upload has identical bytes. A retry of the same operation
preserves its original committed effect, rather than creating another intended asset.

Every **confirmed, usable** Media Asset has **exactly one logical owner-issued V1** that is
automatically **Current**, with `revision = 1`, for its exact owner-qualified `ResourceRef`.
The Current revision is derived from the authoritative Media Asset; there is no separate
`DocumentVersion` store, persistent Current pointer, revision-publishing operation, V2+, or
replace-in-place for Launch. The provider's object-version reference is technical content
identity, not a business revision or invented `revisionId`.

A Current revision is not Permission or proof of present availability. The owner must not claim
`AVAILABLE` for unconfirmed, corrupt, forbidden, or unavailable content. Governed operations
continue to use the existing Core authorization model in [ADR-0030](0030-granular-authorization.md).

Catalog owns Product/Variant assignments, business purpose, ordering, and their historical
Accepted facts; Core Media owns file content and its identity. A new set of bytes creates
a **new Media Asset**. Using it in place of an earlier asset requires an **explicit business-owner
assignment change**, and does not rewrite historical references. A Core Media Link is not a
transfer of the consuming module's ownership or an authorization grant; this preserves
[ADR-0006](0006-explicit-domain-tables-plus-resource-ref.md).

## Consequences

- The existing Catalog owner-issued Current/revision contract remains compatible at Launch
  without a multi-version Documents domain. The minimal Core owner Current read and its
  production Catalog binding belong to [#1443](https://github.com/TechsioCZ/ontos/issues/1443),
  with actual end-to-end proof in [#1446](https://github.com/TechsioCZ/ontos/issues/1446).
- Core Media stays a Core-owned system capability, not a tenant-optional MicroVertical,
  second canonical Document store, or independent permission system.
- Launch does not support a stable logical document identity spanning multiple Media Assets
  or version switching. Any future V2+ design needs a separately accepted decision on
  document identity, historic `ResourceRef` compatibility, and version lifecycle. It must not
  silently rewrite existing Accepted facts.
- The absence of new Evidence, Retention, Privacy, or physical DELETE workflows does not
  remove pre-existing obligations. Their applicability is assessed by their respective owners.

The closed `not_planned` issues [#1431](https://github.com/TechsioCZ/ontos/issues/1431)
and [#1444](https://github.com/TechsioCZ/ontos/issues/1444) record rejected earlier scope;
they do not supersede this accepted Launch decision and remain closed.
