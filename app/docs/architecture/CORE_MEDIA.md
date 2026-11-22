# Core Media

Implementation mechanics of Core Media, the Core-owned system capability that stores one file as a Media Asset and returns the same verified bytes to an authorized caller. The decision (one logical version `V1`, automatically Current, `revision = 1`) is [ADR-0031](../../../docs/adr/0031-core-media-launch-single-version-current.md); authorization is [ADR-0030](../../../docs/adr/0030-granular-authorization.md) and [Granular Authorization](AUTHORIZATION.md). Vocabulary (Core Media, Media Asset, Media Link, ResourceRef, Reconciliation) is defined once in the [OntOS context](../../../docs/contexts/ontos/CONTEXT.md) and is not restated here. Core Media is not a MicroVertical, has no UI, no delete, no version history and no second permission store.

This page describes what is implemented. Rows that have no executed proof against the real object store are named under [Known gaps](#known-gaps).

## Where it lives

| Concern                                                    | Owner                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions, Reads, the byte hop, verification, the S3 adapter | `packages/core-runtime/src/media/`, `modules/actions/*asset*.action.ts`, `generated-reads/asset-*.ts` (Core owner, module id `core.media`, resource type `core.media.asset`, resource id = `mediaAssetId`) |
| Table                                                      | `core.media_assets` (and `core.media_links`); no Core migration was added for Core Media; the storage key is derived from the row identity                                                                 |

## Entrypoints and declaration keys

Action keys (all `idempotency: required`) and the access declarations they carry:

| Entrypoint                                  | Declaration key                      | Risk and modes                               | Carrier                                                                                               |
| ------------------------------------------- | ------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Action `core.media.upload-asset` (reserve)  | `core.media.asset.upload`            | routine, run                                 | human or agent holds the declaration; system, integration and import use workload `core.media.ingest` |
| Action `core.media.confirm-asset`           | `core.media.asset.confirm`           | routine, run                                 | as above                                                                                              |
| Action `core.media.rename-display-filename` | `core.media.display-filename.rename` | routine, run/propose/approve, selector `all` | declaration only, no machine carrier                                                                  |
| Read metadata                               | `core.media.asset-metadata.read`     | routine, selector `all`                      | declaration                                                                                           |

The generated descriptors are in `topology/authorization-catalog.json` (`pnpm authorization:catalog:artifact:check`). The origin a caller states (`user`, `system`, `integration`, `import`) is recorded provenance and grants nothing.

## Reserve, stream, confirm

1. **Reserve** (`core.media.upload-asset`): creates the `core.media_assets` row in `uploaded` under the Action Invocation's own id. The row fixes the declared size, SHA-256, MIME type, display name and origin; the asset id exists from here but is usable only at `ready`. The storage key is a pure function of `(tenantId, mediaAssetId)` under a fixed domain prefix (`core-media/v1/` plus a hex digest): independent of any file name and never a URL or revision.
2. **Confirm** (`core.media.confirm-asset`): seals the row (`ready`, with the actual size and SHA-256) after the stored object is read back and verified against the reserved identity (`StoredMediaObjectVerification`). Only this Action seals the row. A retry after an uncertain end completes the original asset, never a second one.

Each stored object is addressed by its derived key only; the key, provider id, version reference and any URL never reach a response, log or error. A new upload is always a new Media Asset id.

## Known gaps

- **Existing environments do not receive the capabilities** because the published authorization release is pinned and no code publishes a later one; a fresh database does. This is out of scope for D20 and is raised as its own issue (draft: `release-adoption-issue-draft.md` in the plan folder, not filed).
