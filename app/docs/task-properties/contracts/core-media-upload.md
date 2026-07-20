# Core Media upload contract for Files & media

## Ownership

- Core Media owns upload policy, byte ingestion, content-type detection, Media Asset creation, processing state, authorized download access, and authoritative upload validation.
- Ticketing owns the Files & media value item, its order, and its link to a committed Core Media Asset. Ticketing does not interpret MIME content or read deployment environment variables.

## Configured upload limit

- Core Media reads `CORE_MEDIA_MAX_UPLOAD_BYTES` as one deployment-wide positive integer byte count.
- If the environment variable is absent, the effective limit is `104857600` bytes (100 MiB) per file.
- An empty, non-integer, zero, negative, or out-of-range configured value is invalid runtime configuration and must not silently fall back to a different limit.
- Core exposes a read-only policy result equivalent to `getUploadPolicy() -> { maxBytesPerFile }` so clients and Ticketing can display and pre-check the same effective value without reading the environment directly.
- Changing the runtime configuration affects subsequent uploads only. It does not invalidate, delete, or rewrite committed Media Assets or Files & media items.

## Enforcement boundary and bulk behavior

- Core Media is authoritative. It counts the bytes of each incoming file and rejects an oversized file before committing a Media Asset or Ticketing value item.
- Clients and ingress infrastructure may reject earlier for usability or transport protection, but they may never cause Core to accept a file that exceeds Core's effective limit.
- A request rejected by ingress must expose an equivalent size-limit failure. Core remains authoritative whenever bytes reach it.
- Bulk upload evaluates each file independently. Valid files may commit; each oversized, mismatched, or otherwise failed file returns its own failure reason and produces no committed item.
- Staged bytes and failed attempts are not committed value items and do not make the Task Property non-empty.

## Content-type detection and mismatch handling

- Core Media inspects file content and compares a positive detection result with every meaningful supplied signal: filename extension and client-declared MIME type.
- If detected content conflicts with either meaningful signal, reject the file. Retain no committed Media Asset or Files & media item and report a type-mismatch failure.
- Missing filename extensions and generic `application/octet-stream` declarations are absence of a meaningful signal, not conflicts.
- When detection is unknown or inconclusive and no positive mismatch exists, accept the file as a generic downloadable asset. Preserve its filename metadata but do not claim a more specific effective type.
- A consistent positive detection becomes the effective stored MIME type. Download response headers must use the authoritative effective/generic type rather than blindly echoing the client declaration.

## Preview and download

- Internal preview is unsupported in the initial contract for every media type. Core exposes no safe-preview capability, conversion, viewer, or preview URL for Files & media.
- Every successfully committed asset is download-only, subject to Core authorization and short-lived download access.
- Lack of preview is not an upload failure and does not change the committed Files & media value.

## Acceptance guarantees

- With no environment configuration, a file of exactly `104857600` bytes is within the size limit and a larger file is rejected.
- A PNG payload named `invoice.pdf` or declared `application/pdf` is rejected as a mismatch.
- An unknown proprietary binary with no extension and `application/octet-stream` is accepted as generic download-only content.
- No successful or failed upload exposes an internal Preview action.
- An oversized or mismatched member of a bulk upload fails independently without creating a Media Asset or value item for that file.

## Sources and architecture evidence

- `../sources/product-owner/ontos-files-and-media-property.md` §§F5/J.H1–H2.
- `../sources/handoffs/ontos-files-media-main-thread-handoff.md`.
- [PR-016](../product/product-resolutions.md#pr-016--files--media-uses-a-configurable-shared-upload-limit).
- Existing Core Media ownership/table shape: `packages/core-runtime/src/db/schema.ts` (`mediaAssets`, `mediaLinks`).

