# Task Property product resolutions

This document records authoritative product answers for unresolved Task Property conflicts and explicitly identified engineering-only dependency closures in the [conflict register](../analysis/conflicts.md). Each resolution preserves the original source positions, states whether it has a business effect, and links to the resulting consolidated decision.

## Focused-session progress

- Resolved in the focused product-resolution session: 27 of 27 conflict records originally placed in scope.
- Remaining from that session: none.
- A later independent consistency audit identified additional conflicts outside that 27-record interview scope. They remain tracked in the [conflict register](../analysis/conflicts.md) and are not silently answered by this ledger.
- Resolved after that audit: 5 business behaviors, 3 business dependencies, and 2 engineering dependencies. Later corrections C-064 and C-065 also have final dispositions. No specified conflict remains Open.
- Interview rule: one consolidated product question at a time; no unanswered option is treated as a decision.

## Resolutions

### PR-001 — Audit and domain logs are the shared version record

- Affected conflict: [C-021](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Every accepted Task Property change is versioned by both the audit log and the domain log. Together, those logs are the authoritative change record; Task Property datatypes do not maintain separate historical-value/version stores.
- Product effect: Live definitions, values, and derived facts remain current-state projections. The shared versioning rule does not itself introduce a product-facing history, restore, rollback, or time-travel feature. Removing live property data does not remove the corresponding audit-log or domain-log records. Retention, access, privacy-safe payload, and non-reconstruction guarantees are concrete in [PR-023](#pr-023--task-property-logs-are-indefinite-internal-metadata-evidence).
- Effective decision: [DEC-078](../analysis/decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record).
- Original source positions: `../sources/handoffs/ontos-task-ticketing-handoff.md`; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/handoffs/ontos-number-property-handoff.md`; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`; `../sources/handoffs/ontos-phone-property-handoff.md`; `../sources/handoffs/ontos-status-property-handoff.md`; `../sources/handoffs/ontos-task-ticketing-text-handoff.md`; `../sources/handoffs/ontos-task-ticketing-person-handoff.md`; `../sources/handoffs/ontos-url-property-handoff.md`; `../sources/handoffs/ontos-email-property-handoff.md`.

### PR-002 — Property naming and duplicate suffixes are shared

- Affected conflicts: [C-004, C-005, C-009, C-017, C-022, and C-025](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: The rule is identical for every Task Property datatype. Trim a user-entered property name; the result must not be Empty and must be unique within the Task Collection schema under a case-insensitive comparison. There are no other length, character, or reserved-word restrictions.
- Duplicate naming: Given `Name`, generate `Name Copy`; if that case-insensitive name is occupied, try `Name Copy 2`, then `Name Copy 3`, increasing the integer until the first available name is found.
- Exception: ID remains non-duplicable under its existing lifecycle rule, so no duplicate name is generated for ID.
- Effective decision: [DEC-079](../analysis/decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F1.5/J.2; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/product-owner/ontos-number-property.md` §J.4; `../sources/handoffs/ontos-number-property-handoff.md`; `../sources/product-owner/ontos-multi-select-property.md` §J.H1; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`; `../sources/product-owner/ontos-date-property.md` §J.2; `../sources/handoffs/ontos-date-range-property-handoff.md` final decision 4.

### PR-003 — Query and grouping capabilities are available by default

- Affected conflicts: [C-010, C-014, C-020, C-026, and C-028](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Filtering, sorting, searching, and grouping are available for every Task Property datatype unless that datatype explicitly excludes the operation. Silence or missing detail does not exclude a capability.
- Effect on the affected datatypes: Number search is included. Select retains its explicit initial-scope exclusion of Task-row sorting, grouping, and search. Multi-select retains its explicit sorting/grouping exclusion but includes standalone search. Person includes Task search, sorting, and grouping in addition to directory lookup. Files & media includes filtering, searching, sorting, and grouping.
- Effective decision: [DEC-080](../analysis/decisions.md#dec-080--query-and-grouping-capabilities-are-available-by-default).
- Original source positions: `../sources/product-owner/ontos-number-property.md`; `../sources/handoffs/ontos-number-property-handoff.md`; `../sources/product-owner/ontos-select-property.md` §§B/F9/H/I; `../sources/handoffs/ontos-select-property-handoff.md` conclusion 18; `../sources/product-owner/ontos-multi-select-property.md` §§B/F9; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`; `../sources/product-owner/ontos-person-property.md`; `../sources/handoffs/ontos-task-ticketing-person-handoff.md`; `../sources/product-owner/ontos-files-and-media-property.md`; `../sources/handoffs/ontos-files-media-main-thread-handoff.md`.

### PR-004 — Every Task Property may be mandatory

- Affected conflicts: [C-033 and C-037](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Every Task Property Definition, regardless of datatype, may be marked Mandatory.
- Existing Tasks: Enabling Mandatory succeeds without backfilling or rewriting existing Empty values. Those Tasks may remain Empty until someone next submits an edited Task form; validation then prevents the form from being saved until every Mandatory Task Property on that Task is non-empty.
- Datatype effect: A Mandatory value cannot be cleared through an edited Task form. Datatypes that are intrinsically non-empty, including Checkbox (`false` is non-empty), derived Task Properties, and ID, satisfy Mandatory automatically.
- Effective decision: [DEC-081](../analysis/decisions.md#dec-081--every-task-property-may-be-mandatory).
- Original source positions: `../sources/product-owner/ontos-checkbox-property.md`; `../sources/handoffs/ontos-checkbox-property-handoff.md`; `../sources/handoffs/ontos-email-property-handoff.md` clarification 2; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/handoffs/ontos-task-ticketing-handoff.md`.

### PR-005 — Text-like queries share comparison and Empty rules

- Affected conflicts: [C-006, C-034, and C-035](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Non-empty text is compared case-insensitively but diacritic-sensitively using the Task Collection locale. The collation's canonical Unicode equivalence governs comparison without rewriting the stored/displayed value.
- Empty behavior: Empty matches negative text filters such as `Does not contain`; Empty sorts last in both ascending and descending order.
- Scope: Text, URL, Email, and other text-like Task Property query behavior unless a datatype explicitly excludes the operation or defines a more specific non-text value model.
- Effective decision: [DEC-082](../analysis/decisions.md#dec-082--text-like-queries-share-comparison-and-empty-rules).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F5–F6/J.4; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/product-owner/ontos-url-property.md` §§F10–F11/J.H4–H5; `../sources/handoffs/ontos-url-property-handoff.md`; `../sources/product-owner/ontos-email-property.md` §§F6–F8; `../sources/handoffs/ontos-email-property-handoff.md` clarification 3.

### PR-006 — Text duplication copies definition configuration only

- Affected conflict: [C-003](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Text duplication asks for confirmation but does not present a copy-values choice. On confirmation it creates a new Text Task Property Definition, assigns the next shared `Name Copy` name, and copies the Mandatory setting. That is the complete copied configuration.
- Value effect: No per-Task Text values are copied. Every existing Task is Empty for the duplicate; if the copied Mandatory setting is enabled, the deferred validation rule in [DEC-081](../analysis/decisions.md#dec-081--every-task-property-may-be-mandatory) applies.
- Effective decision: [DEC-083](../analysis/decisions.md#dec-083--text-duplication-copies-definition-configuration-only).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F8/J.1; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/handoffs/ontos-task-ticketing-handoff.md` duplication baseline.

### PR-007 — Multi-select values display in catalog order

- Affected conflict: [C-018](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Display selected Multi-select Options in their shared catalog order, not in the order in which a user selected them.
- Product effect: Reordering the shared catalog changes the displayed order of selected options for every Task without changing selection membership or identity.
- Effective decision: [DEC-084](../analysis/decisions.md#dec-084--multi-select-values-display-in-catalog-order).
- Original source positions: `../sources/product-owner/ontos-multi-select-property.md` §J.H2; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`.

### PR-008 — Multi-select color selection uses ColorSelect

- Affected conflict: [C-019](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Engineering disposition: Use the existing `@techsio/ui-kit` `ColorSelect` component for Multi-select Option color choice and editing.
- Business effect: None. The original product behavior remains authoritative: every Option has a color, a newly created Multi-select Option receives one automatically, and an authorized editor may change it later. The available palette, automatic-selection algorithm, color serialization, and component props are not Task Property business behavior.
- Effective status: [PR-019](#pr-019--option-color-editing-uses-colorselect) extends the same component dependency to Select and Status. It does not replace C-019 with a new palette rule.
- Engineering decision: [DEC-085](../analysis/decisions.md#dec-085--multi-select-color-selection-uses-colorselect); shared application decision [DEC-098](../analysis/decisions.md#dec-098--option-color-editing-uses-colorselect).
- Original source positions: `../sources/product-owner/ontos-multi-select-property.md` §§F4.5/J.H4; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`.

### PR-009 — ID deletion impact includes soft-deleted Tasks

- Affected conflict: [C-050](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: The ID deletion-confirmation count includes every retained Task with an ID assignment, including soft-deleted Tasks.
- Product effect: The displayed impact count represents all assignments that will be permanently deleted, not only currently active/visible Tasks.
- Effective decision: [DEC-086](../analysis/decisions.md#dec-086--id-deletion-impact-includes-soft-deleted-tasks).
- Original source positions: `../sources/product-owner/ontos-id-property.md`; `../sources/handoffs/ontos-id-property-handoff.md`; `../sources/handoffs/ontos-task-ticketing-handoff.md` deletion-confirmation baseline.

### PR-010 — ID property deletion permanently removes its state

- Affected prior conflict: [C-049](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Deleting the ID Task Property permanently deletes its definition, prefix, every Task ID Assignment, and its sequence counter. It is not a reversible hide or soft deletion.
- Re-addition: Adding ID later creates a new definition and sequence, then freshly backfills all retained Tasks from `1` using the established deterministic backfill order. Numbers from the deleted ID namespace may therefore appear again in the new namespace.
- Effective decision: [DEC-087](../analysis/decisions.md#dec-087--id-property-deletion-permanently-removes-its-state), superseding the removal portion of DEC-077 and the earlier ID handoff decision.
- Original source positions: `../sources/handoffs/ontos-task-ticketing-handoff.md` generic removal baseline; `../sources/product-owner/ontos-id-property.md` §BR-14; `../sources/handoffs/ontos-id-property-handoff.md` product decision 2.

### PR-011 — Archive and restore update both last-edit facts

- Affected conflict: [C-046](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: A successful Task archive or restore updates both Last edited time and Last edited by as one aligned attribution change. Last edited time becomes the operation's committed instant and Last edited by becomes its Effective Editor.
- Projection lifecycle: Removing and re-adding either property definition does not reset its underlying Task fact; it only hides and reveals the same current value.
- Effective decision: [DEC-088](../analysis/decisions.md#dec-088--archive-and-restore-update-both-last-edit-facts).
- Original source positions: `../sources/product-owner/ontos-last-edited-time-property.md` §BR-03, acceptance criteria, and archive/restore BDD; `../sources/product-owner/ontos-last-edited-by-property.md` §§BR-04–BR-05; `../sources/handoffs/ontos-task-ticketing-last-edited-by-handoff.md`.

### PR-012 — Last edited time uses the Created time filter contract

- Affected conflict: [C-045](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Last edited time supports exactly the same temporal filter operators, precision, and time-zone behavior as Created time.
- Operators: exact instant, before, after, on or before, on or after, exact local calendar day, and custom local date range. Exact-second matching covers the full half-open second so hidden milliseconds match; local day/range boundaries are converted using the viewer's configured IANA time zone.
- Effective decision: [DEC-089](../analysis/decisions.md#dec-089--system-time-properties-share-one-filter-contract).
- Original source positions: `../sources/product-owner/ontos-created-time-property.md` §§F8–F10; `../sources/handoffs/ontos-created-time-property-handoff.md`; `../sources/product-owner/ontos-last-edited-time-property.md` §BR-14; `../sources/handoffs/ontos-last-edited-time-handoff.md`.

### PR-013 — Phone is bounded single-line exact text

- Affected conflict: [C-038](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: A non-empty Phone value may contain at most 256 Unicode code points and must be single-line. Reject carriage returns, line feeds, Unicode line/paragraph separators, tabs, NUL, and other control characters.
- Preservation: Preserve every other accepted character exactly, including spaces, punctuation, letters, international formatting, and extension labels. Unicode-whitespace-only remains Empty.
- Invalid input: Reject an over-limit or prohibited-character input/paste as a whole; never truncate or strip it into a different persisted value. Preserve the previous persisted value while the invalid draft is corrected.
- Effective decision: [DEC-090](../analysis/decisions.md#dec-090--phone-is-bounded-single-line-exact-text).
- Original source positions: `../sources/product-owner/ontos-phone-property.md` §§BR-04–BR-09; `../sources/handoffs/ontos-phone-property-handoff.md`. External standards considered for the product resolution: ITU-T E.164, RFC 3966, and the WHATWG HTML Telephone state.

### PR-014 — URL uses a bounded WHATWG-compatible HTTP(S) profile

- Affected conflict: [C-036](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: A stored URL may contain at most 8,000 UTF-8 bytes and must parse under the WHATWG URL rules as one absolute `http` or `https` URL with a non-empty host.
- Accepted hosts: `localhost`, valid IPv4, bracketed IPv6, explicit valid ports, and valid internationalized domain names are accepted. No DNS, availability, or reachability check is performed.
- Credentials: Reject every URL containing embedded username or password information.
- Preservation: Continue storing the exact trimmed input rather than parser-normalized serialization. Reject invalid or over-limit input as a whole and retain the previous persisted value.
- Effective decision: [DEC-091](../analysis/decisions.md#dec-091--url-uses-a-bounded-whatwg-compatible-https-profile).
- Original source positions: `../sources/product-owner/ontos-url-property.md` §§F1–F7/J.H1–H3; `../sources/handoffs/ontos-url-property-handoff.md`. External standards considered: RFC 3986, RFC 5890/IDNA, RFC 9110 §4.1, and the WHATWG URL Standard.

### PR-015 — Unresolved Core References degrade to searchable plain text

- Affected conflict: [C-007](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Updated authoritative answer: When a stored Mention or Relation target is deleted or cannot be resolved, retain the reference's stable target identity and last display label but render the label as plain, non-clickable text. For example, clickable `@Alice` becomes the string `@Alice`.
- Search behavior: The fallback label participates in Text search and filters exactly like ordinary readable text.
- Lifecycle effect: If the retained target becomes resolvable again, it may render as an active reference again; a permanently deleted target remains in the plain-text fallback state. Permission denial alone no longer produces fallback: under [PR-020](#pr-020--core-references-span-microverticals-and-authorize-when-opened), a resolvable target remains clickable and is authorized immediately before opening.
- Effective decision: [DEC-092](../analysis/decisions.md#dec-092--unresolved-core-references-degrade-to-searchable-plain-text).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F4–F5/J.5; `../sources/handoffs/ontos-text-property-handoff.md`.

### PR-016 — Files & media uses a configurable shared upload limit

- Affected conflict: [C-029](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Refined authoritative answer: Files & media accepts content whose type is consistent with supplied meaningful type signals, plus unknown/inconclusive content with no positive mismatch. PR-024 directly refines the former unconditional “every file type” wording: a positive content/extension/client-MIME mismatch is rejected, while unknown content is accepted as generic download-only.
- Size policy: The maximum upload size is a deployment-wide Core Media environment setting with a default of exactly 100 MiB (`104857600` bytes) per file. It is not configurable per tenant or property. Changing it affects subsequent uploads and does not invalidate, delete, or rewrite committed items.
- Preview: PR-024 defines no internal preview capability initially; all committed assets are download-only.
- Link policy: External items use the shared URL contract in [DEC-091](../analysis/decisions.md#dec-091--url-uses-a-bounded-whatwg-compatible-https-profile). Availability is not checked as part of validation.
- Effective decision: [DEC-093](../analysis/decisions.md#dec-093--files--media-uses-a-configurable-shared-upload-limit).
- Concrete dependency: [PR-024](#pr-024--core-media-authoritatively-validates-download-only-uploads), [DEC-103](../analysis/decisions.md#dec-103--core-media-authoritatively-validates-download-only-uploads), and the [Core Media upload contract](../contracts/core-media-upload.md).
- Original source positions: `../sources/product-owner/ontos-files-and-media-property.md` §§F5/J.H1–H2; `../sources/handoffs/ontos-files-media-main-thread-handoff.md`.

### PR-017 — Select automatic option ordering uses the viewer's user locale

- Affected conflict: [C-052](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior), superseding the unresolved locale portion of C-012.
- Authoritative answer: In `Alphabetical` and `Reverse alphabetical` modes, each viewer sees the Select option catalog collated using that viewer's configured user locale. Automatic order is therefore not a single shared order and may differ between users.
- Manual snapshot: When a user changes an automatically ordered catalog to `Manual`, persist the exact automatic order currently displayed to that acting user as the shared manual order. Later viewer-locale changes do not alter that persisted manual order.
- Stable behavior: Reverse alphabetical reverses the locale-derived alphabetical order. The existing stable option-identity tie-breaker makes equal collation results deterministic.
- Effective decision: [DEC-096](../analysis/decisions.md#dec-096--select-automatic-option-ordering-uses-the-viewers-user-locale).
- Original source positions: `../sources/product-owner/ontos-select-property.md` §J.4; `../sources/handoffs/ontos-select-property-handoff.md` conclusion 8; [DEC-014](../analysis/decisions.md#dec-014--select-option-uniqueness-and-ordering-are-deterministic).

### PR-018 — Empty Select values match `is not <option>`

- Affected conflict: [C-053](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior), superseding the unresolved Empty-membership portion of C-013.
- Authoritative answer: `is not <option>` matches every Task whose Select value is not the named option, including a Task whose Select value is Empty. Empty is not the named option.
- Operator distinction: `is not empty` continues to match only Tasks that have a selected option. `is empty` continues to match only Empty values.
- Example: For `is not Done`, `In progress` and Empty match; `Done` does not.
- Effective decision: [DEC-097](../analysis/decisions.md#dec-097--empty-select-values-match-is-not-option).
- Original source positions: `../sources/product-owner/ontos-select-property.md` §F9; `../sources/handoffs/ontos-select-property-handoff.md` conclusion 11; [DEC-017](../analysis/decisions.md#dec-017--select-is-not-empty-membership).

### PR-019 — Option color editing uses ColorSelect

- Affected conflict: [C-054](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Engineering dependency: Select, Multi-select, and Status use the existing `@techsio/ui-kit` `ColorSelect` component wherever an authorized schema editor chooses or changes an Option color.
- Business effect: None. The component decision does not define a Task Property palette, random or deterministic assignment, color serialization, uniqueness rule, or new creation flow. Existing datatype business rules continue to govern the presence, automatic assignment where explicitly specified, editing, propagation, and duplication of colors.
- Effective decision: [DEC-098](../analysis/decisions.md#dec-098--option-color-editing-uses-colorselect).
- Durable shared contract: [ColorSelect integration contract](../contracts/option-color.md).
- Original source positions: `../sources/product-owner/ontos-select-property.md` §F4; `../sources/handoffs/ontos-select-property-handoff.md`; `../sources/product-owner/ontos-multi-select-property.md` §§F4.5/J.H4; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`; `../sources/product-owner/ontos-status-property.md`; `../sources/handoffs/ontos-status-property-handoff.md`.

### PR-020 — Core References span microverticals and authorize when opened

- Affected conflict: [C-055](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior). It directly refines the permission-loss portion of C-007/PR-015.
- Eligible targets: A Mention or Relation may target any Business Entity exposed by any registered microvertical in any tenant.
- Selection: Core federates picker search, while each owning microvertical controls which entities are discoverable to the acting user. A known Core deep link or opaque reference token may be pasted even when its target was not discoverable. Raw guessed entity IDs are not sufficient.
- Authorization: Selection grants no access. A resolvable target remains clickable even when the viewer lacks permission; the owning microvertical performs a fresh authorization check immediately before opening and prevents navigation when denied.
- Lifecycle: Rename refreshes the active label without changing identity. Deleted, unknown, or currently unresolvable targets retain their last label as searchable, non-clickable plain text. Temporary resolution failure may recover. Permission denial alone does not trigger fallback.
- Effective decision: [DEC-099](../analysis/decisions.md#dec-099--core-references-span-microverticals-and-authorize-when-opened).
- Durable shared contract: [Core Reference contract](../contracts/core-reference.md).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F4–F5/J.5; `../sources/handoffs/ontos-text-property-handoff.md`; [PR-015](#pr-015--unresolved-core-references-degrade-to-searchable-plain-text).

### PR-021 — Stale Task Property value writes are rejected with the draft preserved

- Affected conflict: [C-056](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: When an ordinary editable Task Property Value write is based on a stale value version, reject the attempted write. Keep the currently committed value unchanged; do not merge or overwrite it.
- User-visible result: Show a Toast explaining that the value changed elsewhere and the attempted change was not saved. Preserve the user's unsaved local draft so it can be reviewed or reapplied; do not silently replace it with the newly committed value.
- Retry behavior: A repeated submission against the same stale version remains rejected. There is no automatic merge, force-overwrite, or silent retry in this scope.
- Scope: Text, Number, Select, Multi-select, Status, Date, Date Range, Person, Files & media, Checkbox, URL, Email, and Phone value writes. Derived values, schema/configuration concurrency, and deletion-impact confirmation use their existing separate contracts.
- Effective decision: [DEC-100](../analysis/decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved).
- Original source positions: `../sources/handoffs/ontos-phone-property-handoff.md` “Deferred shared platform decisions”; datatype briefs that already require optimistic versions or stale protection; `../sources/handoffs/ontos-task-ticketing-handoff.md` shared value-mutation baseline.

### PR-022 — Deletion impact includes every retained Task without lifecycle filtering

- Affected conflict: [C-063](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Authoritative answer: Compute property and option deletion-confirmation counts across every retained Task. Apply no active/archive/soft-delete, visibility, permission-derived list, or current-view condition to the count.
- Count rule: For whole-property deletion, count each retained Task whose affected value is non-empty. For option deletion, count each retained Task currently using the affected option. Archived and soft-deleted Tasks participate; hard-deleted Tasks do not exist in retained state and cannot participate.
- Deletion effect: Confirmed deletion applies to the same retained population represented by the count. It deletes property values, clears Select values, removes Multi-select membership, or replaces Status selections according to the datatype's existing deletion rule.
- ID alignment: ID already follows the same retained-Task population under DEC-086; its hard-delete lifecycle remains governed by DEC-087.
- Effective decision: [DEC-101](../analysis/decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).
- Original source positions: `../sources/handoffs/ontos-task-ticketing-handoff.md`; affected datatype deletion sections; [DEC-086](../analysis/decisions.md#dec-086--id-deletion-impact-includes-soft-deleted-tasks).

### PR-023 — Task Property logs are indefinite internal metadata evidence

- Affected conflict: [C-058](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Retention: Write Task Property audit and domain records to the existing Core database tables and retain them indefinitely. There is no expiry, purge, compaction, or deletion cascade from live product data.
- Access: No product-facing UI, export, or application read API is in scope. Task Collection roles grant no log access; only governed internal services and database/operations personnel may access the tables.
- Privacy-safe payload: Store actor/action/subject/outcome/timestamp/version and other change metadata, but no raw or formatted before/after Task Property values, drafts, file content/names/URLs, reference labels, signed URLs, or secrets in either JSON payload.
- Reconstruction: The tables evidence that operations occurred and their order, but do not guarantee reconstruction of historical values or state. No history, comparison, restore, replay, rollback, undo, or time travel is promised.
- Existing storage: Use `core.audit_events` and `core.domain_events`; create no Task Property history or snapshot store.
- Effective decision: [DEC-102](../analysis/decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence).
- Durable shared contract: [Task Property audit-log and domain-log contract](../contracts/audit-domain-log.md).
- Original source positions: `../sources/handoffs/ontos-task-ticketing-handoff.md`; `../sources/handoffs/ontos-phone-property-handoff.md`; [PR-001](#pr-001--audit-and-domain-logs-are-the-shared-version-record). Architecture evidence: `packages/core-runtime/src/db/schema.ts` and `packages/core-runtime/src/core-sdk.ts`.

### PR-024 — Core Media authoritatively validates download-only uploads

- Affected conflict: [C-059](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior), refining C-029/PR-016.
- Type detection: Core Media inspects content. A positive conflict with a meaningful filename extension or client-declared MIME type rejects that file and commits no Media Asset or Files & media item. Unknown/inconclusive content is accepted as generic download-only when no positive mismatch exists.
- Preview: Skip internal preview initially. Every committed file is download-only; there is no safe-preview capability, conversion, viewer, or preview URL in scope.
- Configuration: Core Media owns deployment-wide environment variable `CORE_MEDIA_MAX_UPLOAD_BYTES`. When absent, use exactly `104857600` bytes (100 MiB) per file. Ticketing and clients read Core's effective policy rather than the environment.
- Enforcement: Core Media is authoritative. Clients and ingress may reject earlier, but cannot make Core accept an oversized file. Bulk uploads return independent per-file outcomes and failed files create no committed asset or value item.
- Effective decision: [DEC-103](../analysis/decisions.md#dec-103--core-media-authoritatively-validates-download-only-uploads).
- Durable shared contract: [Core Media upload contract](../contracts/core-media-upload.md).
- Original source positions: `../sources/product-owner/ontos-files-and-media-property.md` §§F5/J.H1–H2; `../sources/handoffs/ontos-files-media-main-thread-handoff.md`; [PR-016](#pr-016--files--media-uses-a-configurable-shared-upload-limit). Architecture evidence: `packages/core-runtime/src/db/schema.ts`.

### PR-025 — Default-enabled query operations use datatype-aware semantics

- Affected conflict: [C-051](../analysis/conflicts.md#conflicts-and-unresolved-business-behavior).
- Search principle: Search uses each datatype's meaningful searchable projection rather than one generic storage representation. Textual projections use case-insensitive, diacritic-sensitive substring matching; Empty contributes no searchable text.
- Number search: Search the canonical decimal text, independent of display separators and Percent formatting. Substrings match, so `1250` matches `25`.
- Catalog/reference/media search: Multi-select and Status search current selected option names; Person and Created by search current Principal display names; Files & media searches uploaded display filenames and external URLs; URL searches its stored string. Any matching member makes a multi-valued property match.
- System-time search: Created time and Last edited time parse viewer-locale date/time input in the configured IANA zone. Date-only input matches the whole local calendar day; date-time input matches the precision supplied.
- Scalar grouping: Text, Number, Status, URL, Email, Created by, and ID group by their existing equality or stable-identity semantics, with one Empty group where Empty is possible.
- Temporal grouping: Created time and Last edited time group by viewer-local calendar day. Date groups by exact stored date. Date Range groups by its complete stored range, including configured times. Empty remains its own group.
- Multi-valued grouping: Person uses membership grouping, so a Task appears in every assigned Principal group. Files & media uses membership grouping by displayed filename or external URL; equal labels share a group under Task Collection locale comparison and UUIDs are not group keys. Empty values form one Empty group.
- Files & media filters: Support only `Contains`, `Does not contain`, `Is empty`, and `Is not empty` over displayed item labels. Negative matching includes Empty.
- Sorting: Files & media compares its displayed-label sequence in stored item order, lexicographically. Person compares the locale-sorted sequence of current Principal display names. Created by sorts by current Principal display name. Empty is last in both directions and stable identities break remaining ties.
- Non-significant presentation detail: When equal case-insensitive values retain different spellings, the group heading uses the spelling contributed by the lowest stable Task identity (and lowest item position within that Task). This deterministic heading rule does not alter group membership.
- Effective decision: [DEC-104](../analysis/decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).
- Original source positions: [DEC-080](../analysis/decisions.md#dec-080--query-and-grouping-capabilities-are-available-by-default); all affected original datatype sources and briefs enumerated in C-051; `../sources/handoffs/ontos-task-ticketing-handoff.md`.
