# Files & media property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-files-and-media-property.md`
- Technical handoff: `../../sources/handoffs/ontos-files-media-main-thread-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

Files & media is a user-editable property whose per-Task value is an ordered collection of zero or more independently identified items. An item is either an uploaded file backed by a Core Media Asset or a public external file/media URL owned as a Ticketing value item.

## Items and ordering

- Uploaded and external items may coexist; duplicates are allowed because item identity is distinct from filename, URL, and underlying asset identity.
- New items append; bulk additions retain received order; users may reorder per Task.
- Removing one item requires no confirmation and preserves others; removing the last item produces Empty.
- Uploaded files are download-only initially. Internal preview, preview conversion, and preview URLs are unsupported for every type under DEC-103.
- External items open at their original location; later unavailability does not remove the stored URL or imply successful opening.

## Validation and upload behavior

- Core Media inspects content. A positive conflict with a meaningful filename extension or client-declared MIME type rejects that file; unknown/inconclusive content is accepted as generic download-only when no positive mismatch exists. A rejected file creates no committed Media Asset or value item.
- Core Media owns deployment-wide `CORE_MEDIA_MAX_UPLOAD_BYTES`, defaulting to exactly `104857600` bytes (100 MiB) per file when absent. It exposes the effective policy to clients/Ticketing; the limit is not configurable per tenant or property. A setting change applies to subsequent uploads without invalidating, deleting, or rewriting committed items.
- Core Media is the authoritative size/type enforcement boundary. Clients and ingress may reject earlier but cannot cause Core to accept a disallowed file.
- External URLs must satisfy the shared URL contract in [DEC-091](../decisions.md#dec-091--url-uses-a-bounded-whatwg-compatible-https-profile). Availability is not checked and content is not fetched solely for validation.
- Bulk upload returns per-file outcomes: valid files may commit while invalid/failed files are individually rejected with explanations.
- Staged/failed uploads are outside the committed value and do not make it non-empty.
- Existing items remain unchanged by a rejected new item.

## Schema operations and duplication

- Duplication assigns the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared) and asks whether to copy all current ordered values.
- The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory); enabling it does not backfill existing zero-item values.
- Copied items receive new Ticketing item identities and preserve type/order. Uploaded copies may reference the same underlying Core Media Asset; storage is not byte-copied.
- Reference-aware garbage collection must retain a Media Asset while any item refers to it.
- Duplication and deletion are atomic; a failed duplicate is not partially visible.
- Whole-property deletion always confirms and counts distinct Tasks with at least one committed item, including zero.

## Query capabilities

- Search matches a case-insensitive, diacritic-sensitive substring of any uploaded display filename or stored external URL; Empty has no searchable text.
- Filters are `Contains`, `Does not contain`, `Is empty`, and `Is not empty` over those displayed labels. `Does not contain` includes Empty.
- Sort compares the displayed-label sequence in stored item order lexicographically using Task Collection locale collation; a shorter exact prefix sorts first, Empty is last in both directions, and Task identity breaks ties.
- Group by displayed filename or external URL membership. A Task appears once in every equal label group it contains; equal labels share a group under Task Collection locale comparison, UUIDs are not group keys, and Empty is separate.
- These operations follow [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics). The historical deleted document remains non-authoritative.

## Permissions

- Full access and Editor manage schema and values.
- User may add/open/download/reorder/remove value items but not mutate the definition.
- Viewer may only read/open/download where Core media authorization permits.

## Confirmed implementation contract

- Ticketing owns value-item identity/order and external URLs; Core owns media assets, bytes, processing, authoritative type/size validation, effective upload-policy reads, and authorized short-lived download URLs.
- Core `media_links` does not model arbitrary external URLs, so external items remain Ticketing-owned initially.
- One reorder is one atomic value mutation/version.
- Delete impact previews carry relevant revision and reject stale confirmation.
- Use monotonic optimistic revisions for concurrency and record every accepted change in both the audit log and domain log under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record).
- A stale Files & media value write, including reorder or item-set mutation, is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed ordered collection remains, a Toast is shown, and the unsaved draft is preserved without automatic merge.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Editing file contents, file-content versioning, annotations/comments, syncing external content, a media library, cloud-storage integrations, all internal previews, automatic Task preview images, per-tenant/per-property upload limits, storage-provider/copy details, security scanning, and datatype-specific permissions.

## Resolved shared policy

The shared upload-type, configurable size-limit, enforcement, download-only, and external-link rules are authoritative under [DEC-093](../decisions.md#dec-093--files--media-uses-a-configurable-shared-upload-limit), [DEC-103](../decisions.md#dec-103--core-media-authoritatively-validates-download-only-uploads), and the durable [Core Media upload contract](../../contracts/core-media-upload.md).
