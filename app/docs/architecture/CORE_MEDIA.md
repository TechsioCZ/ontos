# Core Media

Implementation mechanics of Core Media, the Core-owned system capability that stores one file as a Media Asset and returns the same verified bytes to an authorized caller. The decision (one logical version `V1`, automatically Current, `revision = 1`) is [ADR-0031](../../../docs/adr/0031-core-media-launch-single-version-current.md); authorization is [ADR-0030](../../../docs/adr/0030-granular-authorization.md) and [Granular Authorization](AUTHORIZATION.md). Vocabulary (Core Media, Media Asset, Media Link, ResourceRef, Reconciliation) is defined once in the [OntOS context](../../../docs/contexts/ontos/CONTEXT.md) and is not restated here. Core Media is not a MicroVertical, has no UI, no delete, no version history and no second permission store.

This page describes what is implemented. Rows that have no executed proof against the real object store are named under [Known gaps](#known-gaps).

## Where it lives

| Concern                                                    | Owner                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions, Reads, the byte hop, verification, the S3 adapter | `packages/core-runtime/src/media/`, `modules/actions/*asset*.action.ts`, `generated-reads/asset-*.ts` (Core owner, module id `core.media`, resource type `core.media.asset`, resource id = `mediaAssetId`) |
| Table                                                      | `core.media_assets` (and `core.media_links`); no Core migration was added for Core Media; the storage key is derived from the row identity                                                                 |
| HTTP byte edges and the hosted Current operation           | `apps/shell-super-app` (hand-written streaming routes and the Shell-hosted receiver)                                                                                                                       |

The Shell is the only host that imports the byte surface (`@app/core-runtime/media/edge`). A deployment never imports Core Media tables or private source.

## Entrypoints and declaration keys

Action keys (all `idempotency: required`) and the access declarations they carry:

| Entrypoint                                         | Declaration key                      | Risk and modes                                    | Carrier                                                                                               |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Action `core.media.upload-asset` (reserve)         | `core.media.asset.upload`            | routine, run                                      | human or agent holds the declaration; system, integration and import use workload `core.media.ingest` |
| Action `core.media.confirm-asset`                  | `core.media.asset.confirm`           | routine, run                                      | as above                                                                                              |
| Action `core.media.rename-display-filename`        | `core.media.display-filename.rename` | routine, run/propose/approve, selector `all`      | declaration only, no machine carrier                                                                  |
| Action `core.media.record-asset-integrity-failure` | `core.media.asset-integrity.fail`    | routine, run                                      | workload `core.media.integrity`                                                                       |
| Read metadata                                      | `core.media.asset-metadata.read`     | routine, selector `all`                           | declaration                                                                                           |
| Read download                                      | `core.media.asset-download.read`     | sensitive, selector `all`, access kind `download` | declaration                                                                                           |

The generated descriptors are in `topology/authorization-catalog.json` (`pnpm authorization:catalog:artifact:check`). The origin a caller states (`user`, `system`, `integration`, `import`) is recorded provenance and grants nothing.

HTTP routes (Shell, session authentication, no payload schema for bytes):

- `GET /core/media/assets/:mediaAssetId/content` (and `HEAD`, which answers from the row and reads no provider byte): the verified bytes. `Range` and every conditional header are ignored.

## Reserve, stream, confirm

1. **Reserve** (`core.media.upload-asset`): creates the `core.media_assets` row in `uploaded` under the Action Invocation's own id. The row fixes the declared size, SHA-256, MIME type, display name and origin; the asset id exists from here but is usable only at `ready`. The storage key is a pure function of `(tenantId, mediaAssetId)` under a fixed domain prefix (`core-media/v1/` plus a hex digest): independent of any file name and never a URL or revision.
2. **Confirm** (`core.media.confirm-asset`): seals the row (`ready`, with the actual size and SHA-256) after the stored object is read back and verified against the reserved identity (`StoredMediaObjectVerification`). Only this Action seals the row. A retry after an uncertain end completes the original asset, never a second one.

Each stored object is addressed by its derived key only; the key, provider id, version reference and any URL never reach a response, log or error. A new upload is always a new Media Asset id.

## Verified read and failed versus unavailable

`media/verified-read.ts` is the single place that classifies what a provider returns for a `ready` asset. Outcomes:

- `verified`: the delivered bytes equal the sealed size and SHA-256.
- `unavailable`: this request could not be judged (provider failure, short or doubtful end of stream, object changed while read). Never durable, never promoted by time, never corruption.
- `missing_object`: the provider holds nothing under the key. Neither an absent asset nor proof of corruption.
- `inconsistent_metadata`: the row is not a sealed `ready` identity, or (stream mode) the provider's own stat already disagrees; delivery is refused before a byte.
- `integrity_failed`: proven corruption only: the whole object was read, the stream ended with the length the provider declared, the object did not change meanwhile, and its size or SHA-256 differs from the sealed identity.

Proven corruption is handed to `core.media.record-asset-integrity-failure` (the only writer of `failed`, conditional on the sealed identity). A read never changes status.

## Recovery

Recovery is client or workload driven; there is no scheduler, timer, retry loop, attempt count or deadline in Core Media code (guard test `core-media-recovery-guards`).

- `reconcileUncertainUpload` settles an uncertain upload against the original asset row: `completed`, `closed_failed` (only when the confirm Action proves a mismatch) or `unresolved` (nothing proven; the same client may resend to the same asset).
- A new independent upload may start only after a confirmed failure; `mayStartIndependentUpload` is the check and has no production caller (advisory).
- `cleanup-eligibility.ts` is a check only; nothing removes objects. The S3 adapter's only HTTP `DELETE` aborts its own unfinished multipart upload.
- Recovery logging uses a closed vocabulary and a redacted reference, never keys, bytes, URLs or credentials.

## Download edge

`GET .../content` runs, on every request, the governed `core.media.asset-download.read` (authorization, module state, evidence all fresh), then opens the stored object and streams it through the verifier (`media/download.ts`).

- **Verify while streaming**: the SHA-256 is computed with the platform's native `DigestStream` while streaming; the last chunk is withheld until the verdict. A mismatch or failed read after the first byte aborts the response without a clean end (`MediaDownloadAborted`); the client must treat a body that does not end cleanly as failed.
- **Before the first byte**: `MediaNotReady` (conflict), `MediaUnavailable` (provider or doubtful framing, retryable `503`) or `MediaIntegrityFailed` (`422`).
- **Per-request authorization**: nothing (URL, ticket, token, cache entry, decision) outlives a request. A transfer authorized at its start may finish after the Permission is revoked; the next request or a reconnect is a new decision.
- **Headers** are an allow-list built from the row: `Cache-Control: private, no-store`, `Content-Disposition: attachment` with a sanitized name (control and bidirectional characters and separators replaced, length bounded) and an RFC 5987 UTF-8 form, exact `Content-Length`, `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy`, and `Content-Type` only if the recorded value is a plain `type/subtype`. No provider header, ETag or range support is exposed.

## S3 provider configuration

The adapter is provider-neutral S3 (SigV4, path or virtual-host addressing) in `media/s3-object-storage.ts`, behind the `ObjectStorage` port. Keys (names only; values come from the platform secret and configuration path, never the repository): `CORE_MEDIA_S3_ENDPOINT`, `CORE_MEDIA_S3_BUCKET`, `CORE_MEDIA_S3_REGION`, `CORE_MEDIA_S3_ADDRESSING_STYLE` (`path` or `virtual-host`), `CORE_MEDIA_S3_CONDITIONAL_CREATE` (`supported` or `unsupported`), `CORE_MEDIA_S3_ACCESS_KEY_ID`, `CORE_MEDIA_S3_SECRET_ACCESS_KEY`, and optional `CORE_MEDIA_S3_PART_SIZE_BYTES`, `CORE_MEDIA_S3_REQUEST_TIMEOUT_MS`. One further optional key sits beside them but is not part of the provider identity: `CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS` (see the digest step guard below). The endpoint must be an `https` origin (`http` only on a loopback host). Configuration that fails to parse falls back to an object store that refuses every operation. Credentials are redacted values and appear in no error or log. No retry, backoff or timeout default exists; the timeout applies only when configured.

## Measured limits (facts, not product caps)

No product size limit, MIME allowlist or retry policy is defined by Core Media. Facts and their sources:

| Fact                            | Value                                                                                                                  | Source                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| S3 multipart structure          | minimum part 5 MiB, at most 10,000 parts, all parts but the last equal                                                 | S3 protocol; `s3-config.ts`, `s3-object-storage.ts`            |
| Adapter memory (node, emulator) | peak growth about 114 MiB for 64 MiB and for 1 GiB objects (bounded, not proportional)                                 | measured 2026-11-20, MinIO emulator                            |
| Native digest on workerd        | 64 MiB hashed in 289 ms wall; a JavaScript hash needs about 1.4 s for the same bytes                                   | measured 2026-11-20, local workerd                             |
| Worker CPU class (Shell)        | 200 ms; not measurable on local workerd                                                                                | NOT VERIFIED                                                   |
| Digest step guard               | 5 seconds per digest step (one chunk write or the final close), not per object; a technical guard, not a product limit | `media/content-digest.ts`; `CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS` |
| Cloudflare R2 limits            | documented upstream (for example 1 write per second per key, multipart rules)                                          | provider documentation only; no R2 run                         |

**The digest step guard is not a maximum object size.** `DigestStepTimeout` (default 5 s, a `Context.Reference` read at the moment of each step) wraps exactly two platform calls of `ContentDigest`: `add`, one `writer.write` of one chunk, and `finish`, the `close` plus the digest read. It never spans the object: the unit test `core-media-content-digest` drives six steps of 30 ms under a 100 ms guard and none is stopped, and a step that never answers dies at the guard. Setting it needs `CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS` (a positive integer of milliseconds) provided through `mediaDigestStepTimeoutLayer`; unset keeps 5 s. A step that exceeds the guard is an unexpected defect, never proven corruption: a download whose first chunk is still waiting for its digest step closes without a complete body, and the asset stays as it was (`ready`, never `failed`), so the same request succeeds once the platform answers in time. `openVerifiedMediaStream` carries the guard of its request into the returned body, because the transport runs that body in its own context. For scale only: at the measured 64 MiB in 289 ms (about 221 MiB/s) one step would have to carry roughly 1.1 GiB to need 5 s, and the chunks a transfer hands to the digest are the transport's, not the object's. What is **not** measured and so not claimed: the longest `close` after a very large object on a deployed Worker, any object above the 1 GiB node memory run, and whether `close` waits for queued hashing proportional to the queue. If a product maximum object size is wanted it must be decided by its owner from a measurement on the real Worker and the real provider (the largest object that completes reserve, stream, confirm and a verified download within the deployed CPU and ingress limits); this page proposes no number.

## Known gaps

- **No run against Cloudflare R2 or Wasabi.** Credentials were not supplied; every provider behaviour was executed only against the MinIO S3-compatible emulator, which is never evidence for R2.
- **Existing environments do not receive the capabilities** because the published authorization release is pinned and no code publishes a later one; a fresh database does. This is out of scope for D20 and is raised as its own issue (draft: `release-adoption-issue-draft.md` in the plan folder, not filed).
- **Other owners (UNVERIFIED, nothing here is claimed as checked):** production Privacy and retention assessment and physical deletion belong to their owners. Provider-side backup or replication (Wasabi is the probable backup target) needs a named operations owner; a backup copy extends retention beyond the primary object; and the Privacy owner must define, before production, what erasure means for the primary object and for every backup copy. None of this was configured, run or verified in D20.
