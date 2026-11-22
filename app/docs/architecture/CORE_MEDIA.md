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

## S3 provider configuration

The adapter is provider-neutral S3 (SigV4, path or virtual-host addressing) in `media/s3-object-storage.ts`, behind the `ObjectStorage` port. Keys (names only; values come from the platform secret and configuration path, never the repository): `CORE_MEDIA_S3_ENDPOINT`, `CORE_MEDIA_S3_BUCKET`, `CORE_MEDIA_S3_REGION`, `CORE_MEDIA_S3_ADDRESSING_STYLE` (`path` or `virtual-host`), `CORE_MEDIA_S3_CONDITIONAL_CREATE` (`supported` or `unsupported`), `CORE_MEDIA_S3_ACCESS_KEY_ID`, `CORE_MEDIA_S3_SECRET_ACCESS_KEY`, and optional `CORE_MEDIA_S3_PART_SIZE_BYTES`, `CORE_MEDIA_S3_REQUEST_TIMEOUT_MS`. The endpoint must be an `https` origin (`http` only on a loopback host). Configuration that fails to parse falls back to an object store that refuses every operation. Credentials are redacted values and appear in no error or log. No retry, backoff or timeout default exists; the timeout applies only when configured.

## Measured limits (facts, not product caps)

No product size limit, MIME allowlist or retry policy is defined by Core Media. Facts and their sources:

| Fact                            | Value                                                                                  | Source                                              |
| ------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| S3 multipart structure          | minimum part 5 MiB, at most 10,000 parts, all parts but the last equal                 | S3 protocol; `s3-config.ts`, `s3-object-storage.ts` |
| Adapter memory (node, emulator) | peak growth about 114 MiB for 64 MiB and for 1 GiB objects (bounded, not proportional) | measured 2026-11-20, MinIO emulator                 |
| Cloudflare R2 limits            | documented upstream (for example 1 write per second per key, multipart rules)          | provider documentation only; no R2 run              |

## Known gaps

- **No run against Cloudflare R2 or Wasabi.** Credentials were not supplied; every provider behaviour was executed only against the MinIO S3-compatible emulator, which is never evidence for R2.
- **Existing environments do not receive the capabilities** because the published authorization release is pinned and no code publishes a later one; a fresh database does. This is out of scope for D20 and is raised as its own issue (draft: `release-adoption-issue-draft.md` in the plan folder, not filed).
- **Other owners (UNVERIFIED, nothing here is claimed as checked):** production Privacy and retention assessment and physical deletion belong to their owners. Provider-side backup or replication (Wasabi is the probable backup target) needs a named operations owner; a backup copy extends retention beyond the primary object; and the Privacy owner must define, before production, what erasure means for the primary object and for every backup copy. None of this was configured, run or verified in D20.
