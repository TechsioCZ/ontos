# Handoff: Files & Media property back to the main ticketing task

## Purpose

Prepare the main ticketing task to consolidate the Files & Media business description into the overall Task Property specification, and later invoke `to-spec` followed by `to-tickets`. Do not implement from this handoff alone and do not invoke those two skills until the user asks in the main task.

No implementation or repository artifacts were changed during this discussion. This handoff is the only new artifact.

## Authoritative source artifacts

- General Task Property baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Files & Media GOLD business description, including acceptance criteria and Gherkin scenarios: `/Users/jiprochazka/.codex/attachments/e8de9ea1-1296-4655-bbac-16564ee777af/pasted-text.txt`
- Repository root: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos`
- Implementation scope: work only in `app/`; treat `mvp/` and `mvp2/` as read-only.

Read both source documents in full. Do not copy their full contents into a future spec; synthesize them and retain the GOLD behavior.

## Outcome of this discussion

- The Files & Media description is compatible with the general baseline. No conflicting business behavior was found.
- The property-level user behavior is sufficiently defined for a later specification.
- The baseline access levels still apply even though the Files & Media description declares roles outside its own scope.
- Shared upload limits and supported-link rules are deliberately deferred product-wide configuration, not missing Files & Media behavior.
- No implementation was requested or started.

## Current codebase state

- `app/verticals/ticketing` is a generated scaffold, not a persisted ticketing domain. Its list/get handlers use a static in-memory item and its create handler returns an unpersisted response.
- The existing Create Ticket action validates a target ID, records the CoreSDK action/outbox activity, and returns acceptance; it does not create a Task domain record.
- Core persistence already includes `core.media_assets` with filename, MIME type, byte size, storage identity, and processing status. It also includes `core.media_links`, but that table links a Core media asset to a target resource; it does not represent an arbitrary external URL.
- The current SpiceDB schema exposes only generic reader/creator relations. It does not yet model Full access, Editor, User, and Viewer.
- No `CONTEXT.md`, context map, or ticketing ADR currently exists.
- There are pre-existing staged workspace changes. Preserve them. In particular, `app/docs/ticketing/task-properties.md` is staged for deletion. Its `HEAD` version is historical context only and must not silently become authoritative.

Useful evidence:

- `app/verticals/ticketing/api/index.ts`
- `app/verticals/ticketing/src/actions/create-ticket.ts`
- `app/packages/core-runtime/src/db/schema.ts`
- `app/scripts/spicedb/schema.zed`
- Historical document, read-only through Git: `HEAD:app/docs/ticketing/task-properties.md`

## Recommended domain and module shape

Use these canonical terms consistently:

- Task
- Task Collection
- Task Property Schema
- Task Property Definition
- Task Property Value
- Files & Media Item
- Uploaded Item
- External Item
- Media Asset

Recommended ownership split:

- The Ticketing module owns Task Collections, Tasks, Task Property Definitions, Task Property Values, Files & Media Item identity/order, schema duplication, schema deletion, and value history.
- The Core media module owns uploaded bytes, storage metadata, processing lifecycle, and authorized preview/download access.
- Ticketing should use a narrow Core media interface and must not manipulate raw storage directly.
- External Items should initially be represented by Ticketing because no shared external-link module or second consumer currently exists.

Recommended Files & Media value representation:

- A value is an ordered collection of stable item identities.
- An Uploaded Item refers to a Core `mediaAssetId`.
- An External Item contains a validated external URL.
- Each item has its own ID and explicit position.
- `Empty` is the domain meaning of zero committed item rows; existing Tasks do not need materialized empty rows.
- Duplicate items are allowed naturally because item identity is independent from filename, URL, or media asset identity.
- Duplicating a property creates new value/item identities. Uploaded copies may reference the same underlying Core Media Asset, so user-visible values are independent without copying bytes. Storage garbage collection must retain the asset while any item references it.

Testing should primarily cross the highest external Ticketing interface (the typed HTTP/action contract). Core media storage should be behind an internal adapter so failure and readiness states can be tested without exposing storage details to Ticketing callers.

## Recommended implementation decisions

- Stage uploads outside the committed Task Property Value. Add an Uploaded Item only after successful finalization; failed/staged items do not make a value non-empty.
- Return a result per file for bulk upload. Valid files may commit while invalid files from the same user operation fail with individual explanations.
- Treat one reorder as one atomic value mutation and one version.
- Calculate property-delete impact as the count of distinct Tasks with at least one committed item.
- Return the schema/value revision with a delete-impact preview. Confirmation should reject and refresh if the relevant revision changed after the dialog was opened.
- Duplicate and delete atomically. If collection size later requires asynchronous duplication, keep the duplicate hidden/pending until all values are copied, then expose it atomically.
- Use short-lived authorized URLs for uploaded-file preview/download.
- Do not validate external-link availability at save time and do not fetch external content solely for validation.
- Map permissions so Full access and Editor can manage schema and values, User can edit values only, and Viewer can only read. Sharing remains Full-access-only.
- Persist a monotonic revision plus timestamp and actor for every schema/value mutation. Generic `updated_at` fields alone are not sufficient to satisfy “every change is versioned.”

## Cross-cutting confirmations before `to-spec`

There are no unresolved Files & Media interaction questions. These broader Task Property decisions should be confirmed in the main task or explicitly adopted as defaults before publishing a spec:

1. Schema anchor: recommended default is that one Task Collection owns exactly one Task Property Schema, and schemas are not reused across Task Collections.
2. Version semantics: recommended default is append-only change history plus optimistic-concurrency revisions; no rollback UI or restorable snapshots unless separately requested.
3. Shared validation policy: recommended default is configurable MIME/size limits and absolute `http://` or `https://` external URLs, with no reachability check.
4. Historical search/sort rule: the staged-deleted document previously said Files & Media is searchable by filename and is not sortable. The GOLD description does not define search or sorting. Exclude both from this property scope unless the user confirms that the historical rule remains part of the overall Task Property model.

## Guidance for later `to-spec`

- Invoke only when the user requests publication in the main task and the cross-cutting defaults above are resolved.
- Synthesize the baseline and GOLD description; do not interview the user again for already-defined behavior.
- Before publication, follow the skill requirement to show/check the proposed test seam with the user.
- Use the typed Ticketing HTTP/action interface as the primary behavioral test seam; use the Core media adapter only as an internal failure-control seam.
- Make the user-story list comprehensive, including shared-schema propagation, mixed item types, ordering, partial bulk success, preview/download, individual removal, duplication both with and without values, deletion impact, permissions, concurrency, and version timestamps.
- Keep security scanning, storage-provider choice, file editing/versioning, external cloud integrations, and media-library behavior out of scope as defined by the GOLD source.
- Confirm that an issue tracker and `ready-for-agent` label vocabulary are configured before publishing. If they are absent, the main task may need `setup-matt-pocock-skills` first.

## Guidance for later `to-tickets`

- Prefer running from the published spec rather than directly from this handoff.
- Draft tracer-bullet vertical slices that each cross persistence, contract, authorization, UI, and behavioral tests.
- A likely dependency order is: persisted Task/Collection baseline; first editable property value with authorization/versioning; Core media upload interface; single uploaded item; external item; multi-item ordering and partial bulk upload; duplication; schema deletion impact/confirmation; previews/downloads and hardening.
- Do not publish tickets until the skill has presented the breakdown, blocking edges, and granularity to the user and the user approves it.
- Keep every ticket within one fresh agent context and avoid horizontal “database-only” or “UI-only” tickets unless a necessary prefactor cannot remain green as a vertical slice.

## Suggested skills

- `domain-modeling`: use if the main task still needs to confirm Task Collection ownership, version terminology, or the canonical glossary. Create/update a glossary only after terms are actually resolved.
- `codebase-design`: use to retain the narrow Ticketing/Core media seam and keep storage details out of the Ticketing interface.
- `to-spec`: use later, when explicitly requested, to synthesize and publish the complete agreed specification. Do not invoke now.
- `to-tickets`: use after the specification exists and the user asks for ticket breakdown/publication. Do not invoke now.
- `implement`: use only after an actionable spec/ticket is selected and the user explicitly requests implementation.
- `techsio-ui-kit-ai:ui-kit-workflow-orchestrator`: use first when a later implementation ticket touches the Ticketing UI, as required by `app/AGENTS.md`.
