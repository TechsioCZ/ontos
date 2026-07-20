# Consolidated decisions

Only behavior explicitly settled by the general baseline, a product-owner datatype specification, or its technical handoff belongs here. Missing business behavior is recorded in `conflicts.md`, not converted into an engineering decision.

## DEC-001 — Property deletion confirmation is unconditional

- Decision: Every property removal requires a confirmation dialog, including when the `Is not empty` count is zero. The dialog displays that count.
- Scope: All removable Task Property Definitions.
- Sources: `../sources/handoffs/ontos-task-ticketing-handoff.md` baseline requirements; `../sources/handoffs/ontos-text-property-handoff.md` “Explicit precedence and resolved decisions” item 1.
- Supersedes for Text: `../sources/product-owner/ontos-text-property.md` §F9.3 and deletion BDD scenarios, which condition confirmation on a non-empty value.

## DEC-002 — Text, Number, and Multi-select use revision plus audit evidence

- Decision: For Text, Number, and Multi-select, property-definition and property-value mutations may use internal/monotonic revisions for concurrency and record the accepted change through the shared audit log and domain log. User-facing history, restore, and rollback remain outside scope.
- Scope: Text, Number, and Multi-select under the cross-datatype rule in [DEC-078](#dec-078--audit-and-domain-logs-are-the-shared-version-record).
- Sources: `../sources/handoffs/ontos-task-ticketing-handoff.md` baseline requirement; `../sources/handoffs/ontos-text-property-handoff.md` precedence item 2; `../sources/handoffs/ontos-number-property-handoff.md` confirmed implementation decisions; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md` decisions 1 and 3.
- Reconciles for Text: `../sources/product-owner/ontos-text-property.md` §E excludes “historie verzí” while the general baseline requires timestamped versioning.

## DEC-003 — Schema and value permissions are distinct

- Decision: Full access and Editor may mutate property definitions; User may edit property values but not add, remove, duplicate, rename, reorder, hide, or reconfigure definitions; Viewer is read-only; Full access additionally includes sharing.
- Scope: All user-editable datatypes.
- Sources: `../sources/handoffs/ontos-task-ticketing-handoff.md` access levels; `../sources/handoffs/ontos-text-property-handoff.md` “Business behavior already settled”.

## DEC-004 — Text is inline rich text, not a block canvas

- Decision: Text stores one multiline inline-rich-text document with the supported inline formats and Core References; pasted unsupported blocks are flattened to readable inline content. Unresolved reference presentation follows [DEC-092](#dec-092--unresolved-core-references-degrade-to-searchable-plain-text).
- Scope: Text.
- Sources: `../sources/product-owner/ontos-text-property.md` §§A, D, F2–F4; `../sources/handoffs/ontos-text-property-handoff.md` “Agreed domain language” and “Business behavior already settled”.

## DEC-005 — Text query semantics ignore visual formatting

- Decision: Text search and filter comparison use readable content, independent of visual formatting. Comparison, negative-filter membership, and Empty sorting follow [DEC-082](#dec-082--text-like-queries-share-comparison-and-empty-rules).
- Scope: Text.
- Sources: `../sources/product-owner/ontos-text-property.md` §§F5–F6; `../sources/handoffs/ontos-text-property-handoff.md` “Business behavior already settled”.

## DEC-006 — Text duplication is independent

- Decision: A duplicated Text definition and its future values are independent from the source. The copied configuration and Empty initialization are governed by [DEC-083](#dec-083--text-duplication-copies-definition-configuration-only).
- Scope: Text.
- Sources: `../sources/product-owner/ontos-text-property.md` §§F4.4 and F8; `../sources/handoffs/ontos-text-property-handoff.md` “Business behavior already settled”.

## DEC-007 — Number stores a value independent of its display format

- Decision: Number stores one actual numeric value; Empty and `0` are distinct. `Number`, `Number with separators`, and `Percent` affect presentation only, and Percent displays input `25` as `25 %`.
- Scope: Number.
- Sources: `../sources/product-owner/ontos-number-property.md` §§F “Definice property”, “Povolené hodnoty”, and “Formátování”; `../sources/handoffs/ontos-number-property-handoff.md` “Outcome of this discussion”.

## DEC-008 — Number input and display are locale-aware; storage is not

- Decision: Decimal/group separators follow the active user locale, while persisted and transported values use a locale-independent canonical decimal representation.
- Scope: Number.
- Sources: `../sources/product-owner/ontos-number-property.md` §J.1–3; confirmed by `../sources/handoffs/ontos-number-property-handoff.md` “Outcome of this discussion”.

## DEC-009 — Number persistence is bounded exact decimal

- Decision: Persist Number as PostgreSQL `numeric(38,18)` and cross API boundaries using canonical decimal strings. Reject out-of-bound values, scientific notation, `NaN`, infinity, and leading plus; never persist incomplete editor states.
- Scope: Number implementation contract.
- Source: `../sources/handoffs/ontos-number-property-handoff.md` “Confirmed implementation decisions”.

## DEC-010 — Number comparisons exclude Empty

- Decision: Numeric filters compare stored values. Empty is excluded even from `≠`; `Is empty`/`Is not empty` handle presence explicitly, and `0` is included by `Is not empty`. Numeric sorting places Empty last in both directions.
- Scope: Number.
- Sources: `../sources/product-owner/ontos-number-property.md` §§F “Filtrování” and “Řazení”, §J.5–6; confirmed by `../sources/handoffs/ontos-number-property-handoff.md`.

## DEC-011 — Number invalid paste is rejected atomically

- Decision: Reject an invalid pasted token as a whole and retain the previous valid editor value; do not strip invalid characters into a different number. The server remains authoritative.
- Scope: Number implementation contract.
- Source: `../sources/handoffs/ontos-number-property-handoff.md` “Confirmed implementation decisions”.

## DEC-012 — Number duplicates receive a distinguishable name

- Decision: A duplicated Number definition receives the shared automatically generated `Copy` name defined by [DEC-079](#dec-079--property-naming-and-duplicate-suffixes-are-shared).
- Scope: Number application of the cross-datatype naming rule.
- Sources: `../sources/product-owner/ontos-number-property.md` §J.4; confirmed by `../sources/handoffs/ontos-number-property-handoff.md` “Outcome of this discussion”.

## DEC-013 — Select values reference stable option identities

- Decision: Each non-empty Select value references one stable Select Option ID. Option names and colors may change without changing the value's identity.
- Scope: Select.
- Sources: `../sources/product-owner/ontos-select-property.md` §§F2–F3; `../sources/handoffs/ontos-select-property-handoff.md` conclusions 3 and 17.

## DEC-014 — Select option uniqueness and ordering are deterministic

- Decision: Trim and Unicode-normalize names; enforce case-insensitive, accent-sensitive uniqueness per property. Persist manual positions; derive automatic ordering by normalized name and a stable tie-breaker. Switching to Manual snapshots displayed order.
- Effective locale: The viewer's configured user locale controls automatic ordering under [DEC-096](#dec-096--select-automatic-option-ordering-uses-the-viewers-user-locale). The technical handoff's Task Collection/schema-locale proposal is superseded.
- Scope: Select.
- Sources: `../sources/product-owner/ontos-select-property.md` §§F3, F5, G.7–9, §J.2–4; `../sources/handoffs/ontos-select-property-handoff.md` conclusions 6–8.

## DEC-015 — Inline Select option creation is a schema mutation

- Decision: Creating an option during selection atomically creates shared configuration and selects it. Full access and Editor may do this; User may only select or clear existing options.
- Scope: Select.
- Sources: `../sources/product-owner/ontos-select-property.md` §F4; `../sources/handoffs/ontos-task-ticketing-handoff.md` access levels; `../sources/handoffs/ontos-select-property-handoff.md` conclusion 10.

## DEC-016 — Select option deletion clears affected values after impact confirmation

- Decision: Option deletion always previews the affected-Task count and uses revision-protected confirmation. Confirmed deletion sets affected values to Empty without requiring replacement.
- Scope: Select options.
- Sources: `../sources/product-owner/ontos-select-property.md` §F6 and §J.1; `../sources/handoffs/ontos-select-property-handoff.md` conclusion 15.

## DEC-017 — Select `is not` Empty membership

- Decision: `is not <option>` includes Empty because Empty is not the selected option. `is not empty` selects only Tasks with an option.
- Product authority: Confirmed by [DEC-097](#dec-097--empty-select-values-match-is-not-option) and [PR-018](../product/product-resolutions.md#pr-018--empty-select-values-match-is-not-option).
- Scope: Select filtering.
- Sources: `../sources/product-owner/ontos-select-property.md` §F9; clarified by `../sources/handoffs/ontos-select-property-handoff.md` conclusion 11.

## DEC-018 — Select duplication remaps independent option identities

- Decision: Duplicate the definition and every option with new IDs in one transaction, map copied Task values to those new IDs, place the duplicate after the source, and assign the shared deterministic `Copy` name from [DEC-079](#dec-079--property-naming-and-duplicate-suffixes-are-shared).
- Scope: Select.
- Sources: `../sources/product-owner/ontos-select-property.md` §F7; `../sources/handoffs/ontos-select-property-handoff.md` conclusions 13–14.

## DEC-019 — Multi-select value is a set of option identities

- Decision: A Task value contains zero or more unique option IDs owned by the same Multi-select definition. Empty is zero selections; removing one option preserves all others.
- Scope: Multi-select.
- Sources: `../sources/product-owner/ontos-multi-select-property.md` §§F2–F3; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md` “Important invariants and mechanics”.

## DEC-020 — Multi-select Empty retains version state

- Decision: Model a Multi-select Task value as a versioned envelope with zero or more selection rows so Empty can still carry monotonic version and timestamp state.
- Scope: Multi-select implementation contract.
- Source: `../sources/handoffs/ontos-multi-select-ticketing-handoff.md` “Implementation direction already established”.

## DEC-021 — Multi-select option deletion removes only that selection

- Decision: Preview distinct affected Tasks, then atomically remove the option and its selections while preserving other selections. A Task becomes Empty only if none remain.
- Scope: Multi-select options.
- Sources: `../sources/product-owner/ontos-multi-select-property.md` §F8 and §J.H3; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md` decisions 2 and implementation direction.

## DEC-022 — Multi-select negative membership includes Empty

- Decision: `Does not contain <option>` includes Empty; `Contains` does not. `Is empty` and `Is not empty` test selection-row existence.
- Scope: Multi-select filtering.
- Sources: `../sources/product-owner/ontos-multi-select-property.md` §§F14–F19; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md` implementation direction.

## DEC-023 — Multi-select mutations use identity remapping and atomic transactions

- Decision: Inline option creation, option deletion, whole-property deletion, and duplication are atomic. Duplication creates new option identities and remaps copied selections.
- Scope: Multi-select.
- Sources: `../sources/product-owner/ontos-multi-select-property.md` §§F4, F8–F13; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md` implementation direction.

## DEC-024 — Status has fixed groups and exactly one Default

- Decision: Every Status definition has the three immutable groups To-do, In progress, and Complete, at least one option overall, and exactly one Default option. Group labels are localized; option order is group-local.
- Scope: Status.
- Sources: `../sources/product-owner/ontos-status-property.md` §§F2–F5; `../sources/handoffs/ontos-status-property-handoff.md` resolved decisions 2–3.

## DEC-025 — Status creation distinguishes existing and new Tasks

- Decision: Adding a Status definition leaves existing Tasks Empty. New Tasks receive the current Default of every Status definition; later Default changes do not rewrite existing values or Empty.
- Scope: Status.
- Sources: `../sources/product-owner/ontos-status-property.md` §§F1, F5–F6; `../sources/handoffs/ontos-status-property-handoff.md` resolved decision 1.

## DEC-026 — Deleting a used Status option replaces values with Default

- Decision: After exact-count, stale-protected confirmation, deleting a used non-Default option atomically assigns the current Default to affected Tasks. The current Default must first be replaced before it can be deleted.
- Scope: Status options.
- Sources: `../sources/product-owner/ontos-status-property.md` §§F7–F9; `../sources/handoffs/ontos-status-property-handoff.md` resolved decision 5 and implementation recommendations.

## DEC-027 — Status duplication maps independent option identities and Defaults

- Decision: A duplicate has new property/option identities, its own mapped Default, and optional remapped value copies. Existing Empty remains Empty; future Tasks receive each definition's Default independently.
- Scope: Status.
- Sources: `../sources/product-owner/ontos-status-property.md` §F11; `../sources/handoffs/ontos-status-property-handoff.md` implementation recommendations.

## DEC-028 — Date is date-only and locale-independent in storage

- Decision: Store Date as PostgreSQL `DATE` and expose ISO `YYYY-MM-DD`. Product locale controls manual parsing/display; the current explicit mappings are `cs-CZ` and `en-GB`.
- Scope: Date.
- Sources: `../sources/product-owner/ontos-date-property.md` §§F2, F4 and §J.1; `../sources/handoffs/ontos-task-ticketing-text-handoff.md` “Date localization” and “Date”.

## DEC-029 — Date picker navigation is non-mutating

- Decision: Empty opens the current month without assigning Today, populated values open their month, navigation does not persist, selecting a day replaces the value, and `Today` uses the client-local calendar date.
- Scope: Date.
- Sources: `../sources/product-owner/ontos-date-property.md` §F3 and BDD; `../sources/handoffs/ontos-task-ticketing-text-handoff.md` “Date”.

## DEC-030 — Date rejects invalid calendar input without clearing a valid value

- Decision: Both client and server validate calendar existence using explicit locale parsing; invalid manual input is not persisted and leaves the previous value intact.
- Scope: Date.
- Sources: `../sources/product-owner/ontos-date-property.md` §F4 and edge cases; `../sources/handoffs/ontos-task-ticketing-text-handoff.md` “Date”.

## DEC-031 — Date Range requires distinct ordered dates and complete pairs

- Decision: A persisted value is Empty or has Start date before a different End date, with either no times or both times. Invalid partial/equal/reversed input remains a draft and never overwrites the previous value.
- Scope: Date Range.
- Sources: `../sources/product-owner/ontos-date-rande-property.md` §§F2–F5; `../sources/handoffs/ontos-date-range-property-handoff.md` implementation interpretation.

## DEC-032 — Date Range time support is per definition

- Decision: Time support configures one shared Date Range definition. Enabling preserves dates with Empty times; disabling requires an affected-value count and confirmation, then atomically removes complete time pairs while preserving dates.
- Scope: Date Range.
- Sources: `../sources/product-owner/ontos-date-rande-property.md` §F5 and §J.H1; `../sources/handoffs/ontos-date-range-property-handoff.md` final decision 2 and implementation interpretation.

## DEC-033 — Date Range always copies values on duplication

- Decision: Date Range duplication copies configuration and all current values without presenting the baseline copy-values choice. Empty remains Empty; copies are independent.
- Scope: Date Range exception.
- Sources: `../sources/product-owner/ontos-date-rande-property.md` §F8; `../sources/handoffs/ontos-date-range-property-handoff.md` final decision 1.

## DEC-034 — Date Range duplicate naming uses numbered `Copy`

- Decision: Generate `Name Copy`, `Name Copy 2`, and so on within the schema under [DEC-079](#dec-079--property-naming-and-duplicate-suffixes-are-shared); immutable ID is identity.
- Scope: Date Range application of the cross-datatype naming rule.
- Source: `../sources/handoffs/ontos-date-range-property-handoff.md` final decision 4.

## DEC-035 — Person eligibility is tenant-scoped human membership

- Decision: New Person assignments may target active human members or guests of the current Core tenant only. Cross-tenant, group, external, disabled, archived, and departed identities are rejected.
- Scope: Person.
- Sources: `../sources/product-owner/ontos-person-property.md` §F3; `../sources/handoffs/ontos-task-ticketing-person-handoff.md` confirmed decisions.

## DEC-036 — Person preserves historical ineligible references

- Decision: A stored Principal reference survives later disable/archive/membership loss, renders as inactive/ineligible, and can be copied during duplication, but cannot be newly assigned.
- Scope: Person.
- Sources: `../sources/product-owner/ontos-person-property.md` §§F3, G.4/G.6; `../sources/handoffs/ontos-task-ticketing-person-handoff.md` confirmed decisions.

## DEC-037 — Person cardinality reduction never discards assignments

- Decision: `No limit` → `1 Person` is rejected when any Task has multiple assignments and returns the violating-Task count; no assignment is automatically chosen or removed. `1 Person` replacement is atomic.
- Scope: Person.
- Sources: `../sources/product-owner/ontos-person-property.md` §§F4–F6; `../sources/handoffs/ontos-task-ticketing-person-handoff.md` persistence invariants.

## DEC-038 — Person Directory separates eligible search from historical resolution

- Decision: Core supplies tenant-scoped eligible-person search over visible name/email/login and separate stored-reference resolution that includes now-ineligible Principals.
- Scope: Person/Core boundary.
- Durable contract: [Core Principal, Person Directory, and operation-attribution contract](../contracts/core-principal-attribution.md).
- Source: `../sources/handoffs/ontos-task-ticketing-person-handoff.md` confirmed decisions and module seams.

## DEC-039 — Person value changes do not notify

- Decision: Ordinary Person value mutations emit required audit/domain evidence but no notification solely because the value changed.
- Scope: Person.
- Sources: `../sources/product-owner/ontos-person-property.md` §§F10, G.5; `../sources/handoffs/ontos-task-ticketing-person-handoff.md` confirmed decisions.

## DEC-040 — Files & media separates Ticketing items from Core assets

- Decision: Ticketing owns ordered Files & Media Item identities and external URLs; uploaded items reference Core-owned Media Assets that own bytes, processing, and authorized delivery.
- Scope: Files & media/Core boundary.
- Sources: `../sources/product-owner/ontos-files-and-media-property.md` §§F2–F4; `../sources/handoffs/ontos-files-media-main-thread-handoff.md` recommended domain/module shape.

## DEC-041 — Files & media bulk addition permits per-item success

- Decision: Validate/commit each bulk-added file independently, report each rejection, and preserve prior committed items. Failed/staged uploads never count as committed non-empty content.
- Scope: Files & media.
- Sources: `../sources/product-owner/ontos-files-and-media-property.md` §F5 and edge cases; `../sources/handoffs/ontos-files-media-main-thread-handoff.md` recommended decisions.

## DEC-042 — Files & media duplicates item identity, not uploaded bytes

- Decision: With value copying, create new ordered value-item identities. Uploaded copies may reference the same Media Asset, and asset lifecycle must retain it while referenced. External items copy the validated URL.
- Scope: Files & media.
- Sources: `../sources/product-owner/ontos-files-and-media-property.md` §F7; `../sources/handoffs/ontos-files-media-main-thread-handoff.md` value representation.

## DEC-043 — Files & media deletion counts committed non-empty Tasks

- Decision: Property deletion impact is the number of distinct Tasks with at least one committed item. Preview carries a relevant revision and stale confirmation refreshes.
- Scope: Files & media.
- Sources: `../sources/product-owner/ontos-files-and-media-property.md` §F8; `../sources/handoffs/ontos-files-media-main-thread-handoff.md` recommended decisions.

## DEC-044 — Checkbox is always binary and defaults to false

- Decision: Checkbox has exactly `true` or `false`, never Empty/null. Existing and new Tasks resolve to `false` when the definition applies.
- Scope: Checkbox exception to generic Empty initialization.
- Sources: `../sources/product-owner/ontos-checkbox-property.md` §§BR-03–BR-05; `../sources/handoffs/ontos-checkbox-property-handoff.md` confirmed integration decision 1.

## DEC-045 — Checkbox has no automatic Task side effects

- Decision: Toggling Checkbox does not complete the Task or change Status, Title, another property, or system completion state.
- Scope: Checkbox.
- Sources: `../sources/product-owner/ontos-checkbox-property.md` §§BR-01, BR-06–BR-08; `../sources/handoffs/ontos-checkbox-property-handoff.md` product meaning.

## DEC-046 — Checkbox no-copy duplication defaults to false

- Decision: Duplication still asks whether to copy values; declining initializes every Task to `false`, while accepting copies each Task's boolean.
- Scope: Checkbox exception to generic no-copy Empty behavior.
- Source: `../sources/handoffs/ontos-checkbox-property-handoff.md` confirmed integration decision 2.

## DEC-047 — Every Checkbox value is non-empty

- Decision: Both `true` and `false` satisfy `Is not empty`; therefore property-removal impact equals all Tasks in the schema/collection.
- Scope: Checkbox.
- Source: `../sources/handoffs/ontos-checkbox-property-handoff.md` confirmed integration decision 3.

## DEC-048 — URL stores the exact trimmed HTTP(S) string

- Decision: Trim outer whitespace, accept exactly one absolute HTTP(S) URL with a non-empty hostname and no internal whitespace/control characters, and store the exact trimmed input rather than parser-normalized output. Length, host forms, ports, IDNs, and credential rejection follow [DEC-091](#dec-091--url-uses-a-bounded-whatwg-compatible-https-profile).
- Scope: URL.
- Sources: `../sources/product-owner/ontos-url-property.md` §§F1–F7; `../sources/handoffs/ontos-url-property-handoff.md` confirmed profile 1–6.

## DEC-049 — Invalid and no-op URL commands do not version

- Decision: Invalid input keeps the persisted value and draft feedback visible; backend revalidates. Invalid attempts and unchanged post-trim values create no value-version record. Successful mutation and server timestamp/version are atomic.
- Scope: URL.
- Source: `../sources/handoffs/ontos-url-property-handoff.md` confirmed profile 7–9 and frontend validation additions.

## DEC-050 — URL open/copy uses exact stored value

- Decision: Open the exact stored URL in a new context with `noopener`/`noreferrer`, and copy the exact stored string. Neither action mutates or checks reachability.
- Scope: URL.
- Sources: `../sources/product-owner/ontos-url-property.md` §§F8–F9; `../sources/handoffs/ontos-url-property-handoff.md` confirmed profile 10.

## DEC-051 — Email uses one deterministic practical grammar

- Decision: Apply the confirmed ASCII/punycode length, dot-atom local-part, multi-label domain, and rejection rules identically in client and authoritative server validation; preserve trimmed case for display.
- Scope: Email.
- Sources: `../sources/product-owner/ontos-email-property.md` §F3–F4; `../sources/handoffs/ontos-email-property-handoff.md` clarification 1.

## DEC-052 — Email supports mandatory configuration

- Decision: Email is optional by default and may be made Mandatory without backfill. The next submitted Task edit form with Empty Mandatory Email is rejected until populated; clearing it through that form is rejected.
- Scope: Email application of the cross-datatype rule in [DEC-081](#dec-081--every-task-property-may-be-mandatory).
- Source: `../sources/handoffs/ontos-email-property-handoff.md` clarification 2.

## DEC-053 — Email negative filters include Empty

- Decision: `Is not X` and `Does not contain X` include Empty; comparison/search are literal and case-insensitive. Sorting uses the normalized whole address and Task Collection locale with Empty last in both directions under [DEC-082](#dec-082--text-like-queries-share-comparison-and-empty-rules).
- Scope: Email.
- Sources: `../sources/product-owner/ontos-email-property.md` §§F6–F8; `../sources/handoffs/ontos-email-property-handoff.md` clarification 3 and implementation direction.

## DEC-054 — Email activation is recipient-only `mailto:`

- Decision: Readers may invoke a percent-encoded recipient-only `mailto:` for the stored value; it sends nothing and mutates nothing.
- Scope: Email.
- Sources: `../sources/product-owner/ontos-email-property.md` §F5; `../sources/handoffs/ontos-email-property-handoff.md` implementation direction.

## DEC-055 — Email deletion retains immutable audit history

- Decision: Live Email values are removed with the definition. The corresponding shared audit-log and domain-log records remain under [DEC-078](#dec-078--audit-and-domain-logs-are-the-shared-version-record); Email has no separate historical-value store, event-sourcing, or undo behavior.
- Scope: Email deletion.
- Source: `../sources/handoffs/ontos-email-property-handoff.md` clarification 4.

## DEC-056 — Phone preserves arbitrary non-empty text exactly

- Decision: Unicode-whitespace-only is Empty; otherwise preserve every accepted character exactly, including outer whitespace, without phone validation or normalization. Length and single-line constraints follow [DEC-090](#dec-090--phone-is-bounded-single-line-exact-text).
- Scope: Phone.
- Sources: `../sources/product-owner/ontos-phone-property.md` §§BR-04–BR-09 and §J.H-01; `../sources/handoffs/ontos-phone-property-handoff.md` hypotheses/adopted clarifications 1 and 5.

## DEC-057 — Phone copy/call are reader-safe non-mutations

- Decision: Viewer and higher roles may copy exact stored text or activate a safely encoded `tel:` handoff. Unsupported calling causes no Task/save error or mutation.
- Scope: Phone.
- Sources: `../sources/product-owner/ontos-phone-property.md` §§BR-10–BR-13; `../sources/handoffs/ontos-phone-property-handoff.md` clarification record 3–4.

## DEC-058 — Phone logs changes without historical values

- Decision: Record every accepted Phone change in both the audit log and domain log with privacy-safe actor, identifiers, operation, timestamp, and outcome data. Do not retain prior Phone values as separate property history or emit raw Phone content through generic evidence channels.
- Scope: Phone under the cross-datatype rule in [DEC-078](#dec-078--audit-and-domain-logs-are-the-shared-version-record).
- Sources: `../sources/product-owner/ontos-phone-property.md` §BR-08; `../sources/handoffs/ontos-phone-property-handoff.md` baseline clarification and product clarification record 1–2.

## DEC-059 — Created time is an intrinsic Task fact

- Decision: The server assigns an immutable creation instant when it durably creates the blank Task canvas, before Title/content. Created time definitions project that fact and never own editable value rows.
- Scope: Created time/Task lifecycle.
- Sources: `../sources/product-owner/ontos-created-time-property.md` §§F2–F6; `../sources/handoffs/ontos-created-time-property-handoff.md` confirmed decisions.

## DEC-060 — Created time uses absolute millisecond precision and local presentation

- Decision: Persist/transport an absolute millisecond instant; present by user locale/IANA zone with minutes standard and seconds detail. Sort/filter on the instant, using half-open local calendar ranges and whole-second exact filters.
- Scope: Created time.
- Sources: `../sources/product-owner/ontos-created-time-property.md` §§F7–F10; `../sources/handoffs/ontos-created-time-property-handoff.md` confirmed decisions.

## DEC-061 — Created time duplication projects the same fact without prompting

- Decision: Duplicate the definition without a copy-values prompt; both independent definitions expose the same Task creation instant. Removal/re-addition never changes that fact.
- Scope: Created time exception.
- Sources: `../sources/product-owner/ontos-created-time-property.md` §§F11–F12 and accepted H2–H4; `../sources/handoffs/ontos-created-time-property-handoff.md` confirmed decisions.

## DEC-062 — Created by is intrinsic immutable Task provenance

- Decision: Persist exactly one stable creating Principal on every Task from trusted operation context. No user/value command can edit it, and creation fails when no valid Actor exists.
- Scope: Created by/Task creation.
- Durable contract: [Core Principal, Person Directory, and operation-attribution contract](../contracts/core-principal-attribution.md).
- Sources: `../sources/product-owner/ontos-created-by-property.md` §§BR-01–BR-06 and failure edge case; `../sources/handoffs/ontos-created-by-property-handoff.md` confirmed decisions 1–2.

## DEC-063 — New Task attribution always uses the actual creating Actor

- Decision: Manual, duplication, import, automation, and copied-template creation use the Actor responsible for that new Task. Task duplication never copies source provenance.
- Scope: Created by.
- Sources: `../sources/product-owner/ontos-created-by-property.md` §§BR-07–BR-09; `../sources/handoffs/ontos-created-by-property-handoff.md` recommended implementation shape.

## DEC-064 — Created by resolves current Principal presentation

- Decision: Reference stable Principal identity and display its current name, optionally inactive. Do not snapshot the creation-time display name or substitute another user.
- Scope: Created by/Core Principal boundary.
- Durable contract: [Core Principal, Person Directory, and operation-attribution contract](../contracts/core-principal-attribution.md).
- Sources: `../sources/product-owner/ontos-created-by-property.md` deactivated-author edge case; `../sources/handoffs/ontos-created-by-property-handoff.md` confirmed decision 3.

## DEC-065 — Created by definition duplication projects provenance without prompting

- Decision: Duplicate configuration only, show no copy-values prompt, and project the same provenance through every independent definition. Removal does not delete provenance.
- Scope: Created by exception.
- Source: `../sources/handoffs/ontos-created-by-property-handoff.md` confirmed decision 1.

## DEC-066 — Last edited time tracks only successful actual Task-state mutation

- Decision: Initialize `lastEditedAt` to creation and atomically update it for successful actual Task-state changes. No-op, failed, cancelled, idempotent replay, comment/reaction, view, or schema operations do not update it.
- Scope: Last edited time/Task mutation boundary.
- Sources: `../sources/product-owner/ontos-last-edited-time-property.md` §§BR-02–BR-05 and edge cases; `../sources/handoffs/ontos-last-edited-time-handoff.md` resolved decisions 2 and implementation guidance.

## DEC-067 — Last edited time is one Task fact projected by all definitions

- Decision: Persist `lastEditedAt` on the Task independently of property visibility. Multiple definitions show the same fact; remove/re-add preserves it.
- Scope: Last edited time.
- Sources: `../sources/product-owner/ontos-last-edited-time-property.md` §§BR-06–BR-09; `../sources/handoffs/ontos-last-edited-time-handoff.md` canonical distinction.

## DEC-068 — Last edited time duplication has no value-copy choice

- Decision: A duplicate definition immediately and continuously projects the same live Task fact, not a snapshot, and never offers Empty/no-copy behavior.
- Scope: Last edited time exception.
- Source: `../sources/handoffs/ontos-last-edited-time-handoff.md` resolved decision 1.

## DEC-069 — Last edited time presentation is viewer-local, query is absolute

- Decision: Present using configured IANA zone/locale; sort/filter on the canonical instant. Locale/zone changes affect presentation and local-calendar filter boundaries only. Filter operators and precision follow [DEC-089](#dec-089--system-time-properties-share-one-filter-contract).
- Scope: Last edited time.
- Sources: `../sources/product-owner/ontos-last-edited-time-property.md` §§BR-10–BR-14; `../sources/handoffs/ontos-last-edited-time-handoff.md` resolved decision 3.

## DEC-070 — Last edited by tracks successful Title/property/canvas saves

- Decision: Initialize from Task creator and update once for each committed actual Title, editable property-value, canvas, archive, or restore change. Final successful-save order controls concurrency; no-op/failed/cancelled changes do not update. Archive/restore alignment is specified in [DEC-088](#dec-088--archive-and-restore-update-both-last-edit-facts).
- Scope: Last edited by.
- Sources: `../sources/product-owner/ontos-last-edited-by-property.md` §§BR-03–BR-07 and edge cases; `../sources/handoffs/ontos-task-ticketing-last-edited-by-handoff.md` domain conclusions.

## DEC-071 — Last edited by attributes automation to origin or System

- Decision: Use the originating human Principal when known throughout an automation chain; otherwise use a stable tenant-scoped System Principal.
- Scope: Last edited by/automation context.
- Durable contract: [Core Principal, Person Directory, and operation-attribution contract](../contracts/core-principal-attribution.md).
- Sources: `../sources/product-owner/ontos-last-edited-by-property.md` §§BR-08–BR-09 and edge cases; `../sources/handoffs/ontos-task-ticketing-last-edited-by-handoff.md` domain conclusions.

## DEC-072 — Last edited by definitions project one live Task fact

- Decision: All definitions expose the same retained editor metadata, duplicate without a copy-values prompt, and survive definition removal/re-addition. Schema operations never update attribution.
- Scope: Last edited by exception.
- Sources: `../sources/product-owner/ontos-last-edited-by-property.md` §§BR-10–BR-13; `../sources/handoffs/ontos-task-ticketing-last-edited-by-handoff.md` confirmed cross-spec decisions 1–2.

## DEC-073 — One Task Collection owns one non-reusable schema and ID sequence

- Decision: A Task Collection owns exactly one non-shared Task Property schema and, while an ID definition exists, one independent ID numeric sequence; different collections or newly created post-deletion ID namespaces may reuse the same numbers.
- Scope: Cross-cutting collection/schema model and ID.
- Sources: `../sources/product-owner/ontos-id-property.md` §§BR-01–BR-02; `../sources/handoffs/ontos-id-property-handoff.md` product decision 3.

## DEC-074 — ID activation deterministically backfills retained Tasks

- Decision: Assign existing Tasks from `1` in `(Created time, durable creation ordinal)` order, including retained soft-deleted Tasks; then continue the counter.
- Scope: ID.
- Sources: `../sources/product-owner/ontos-id-property.md` §§BR-03–BR-04; `../sources/handoffs/ontos-id-property-handoff.md` implementation decisions.

## DEC-075 — ID numbers are immutable and never reused

- Decision: While one ID definition/sequence exists, allocate the next collection number atomically for each new Task, preserve it through Task delete/restore, never release it, and allocate a fresh number when duplicating a Task. Full ID property deletion ends that namespace under [DEC-087](#dec-087--id-property-deletion-permanently-removes-its-state).
- Scope: ID/Task lifecycle within one ID definition namespace.
- Sources: `../sources/product-owner/ontos-id-property.md` §§BR-05–BR-10; `../sources/handoffs/ontos-id-property-handoff.md` implementation/test behaviors.

## DEC-076 — ID prefix is presentation configuration

- Decision: Trim and case-preserve an optional shared prefix; render `PREFIX-number` or bare number. Changing prefix never rewrites assignments or advances the sequence.
- Scope: ID.
- Sources: `../sources/product-owner/ontos-id-property.md` §§BR-11–BR-13; `../sources/handoffs/ontos-id-property-handoff.md` implementation decisions.

## DEC-077 — ID definition is singleton and non-duplicable

- Decision: Each collection has at most one ID definition and rejects duplication before any copy prompt. The earlier hide-on-removal behavior is superseded by hard deletion in [DEC-087](#dec-087--id-property-deletion-permanently-removes-its-state).
- Scope: ID singleton and duplication exceptions.
- Sources: `../sources/product-owner/ontos-id-property.md` §BR-14; `../sources/handoffs/ontos-id-property-handoff.md` product decisions 1–2.

## DEC-078 — Audit and domain logs are the shared version record

- Decision: Every accepted Task Property change is versioned in both the audit log and the domain log. Together, those logs are the authoritative retained change evidence; datatypes do not maintain separate historical-value/version stores. Concrete retention, access, privacy, and non-reconstruction behavior follows [DEC-102](#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence).
- Product effect: Live definitions, values, and derived facts remain current-state projections. This rule does not add product-facing history, restore, rollback, or time travel. Removing live data does not erase its audit-log or domain-log records; log payload and access policies still govern sensitive content.
- Scope: All Task Property definition, value, and derived-fact changes.
- Product resolution: [PR-001](../product/product-resolutions.md#pr-001--audit-and-domain-logs-are-the-shared-version-record).
- Original source positions: `../sources/handoffs/ontos-task-ticketing-handoff.md`; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/handoffs/ontos-number-property-handoff.md`; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`; `../sources/handoffs/ontos-phone-property-handoff.md`; `../sources/handoffs/ontos-status-property-handoff.md`; `../sources/handoffs/ontos-task-ticketing-text-handoff.md`; `../sources/handoffs/ontos-task-ticketing-person-handoff.md`; `../sources/handoffs/ontos-url-property-handoff.md`; `../sources/handoffs/ontos-email-property-handoff.md`.

## DEC-079 — Property naming and duplicate suffixes are shared

- Decision: Apply one naming rule to every Task Property datatype. Trim user-entered names, reject Empty results, and enforce uniqueness within the Task Collection schema using a case-insensitive comparison. No other length, character, or reserved-word restrictions apply.
- Duplicate naming: For source `Name`, try `Name Copy`, followed by `Name Copy 2`, `Name Copy 3`, and increasing integers until the first case-insensitively available schema name is found.
- Scope: All Task Property Definitions. ID remains the existing non-duplicable exception.
- Product resolution: [PR-002](../product/product-resolutions.md#pr-002--property-naming-and-duplicate-suffixes-are-shared).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F1.5/J.2; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/product-owner/ontos-number-property.md` §J.4; `../sources/handoffs/ontos-number-property-handoff.md`; `../sources/product-owner/ontos-multi-select-property.md` §J.H1; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`; `../sources/product-owner/ontos-date-property.md` §J.2; `../sources/handoffs/ontos-date-range-property-handoff.md` final decision 4.

## DEC-080 — Query and grouping capabilities are available by default

- Decision: Every Task Property datatype supports filtering, sorting, searching, and grouping unless the datatype explicitly excludes an operation. Missing or unspecified behavior is not an exclusion.
- Existing explicit exclusions: Select Task-row sorting/grouping/search in its accepted initial scope; Multi-select sorting/grouping; Date filtering/sorting/search; Date Range filtering/sorting/search; Checkbox sorting/grouping/search; Phone filtering/sorting/grouping/search; Last edited by filtering/sorting/grouping/search; and ID filtering/sorting/search. Other recorded explicit exclusions remain authoritative.
- Scope: Cross-datatype capability availability. Datatype-specific comparison, matching, ordering, and grouping semantics use the authoritative value model and the concrete default-enabled operation rules in [DEC-104](#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).
- Product resolution: [PR-003](../product/product-resolutions.md#pr-003--query-and-grouping-capabilities-are-available-by-default).
- Original source positions: `../sources/product-owner/ontos-number-property.md`; `../sources/handoffs/ontos-number-property-handoff.md`; `../sources/product-owner/ontos-select-property.md` §§B/F9/H/I; `../sources/handoffs/ontos-select-property-handoff.md` conclusion 18; `../sources/product-owner/ontos-multi-select-property.md` §§B/F9; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`; `../sources/product-owner/ontos-person-property.md`; `../sources/handoffs/ontos-task-ticketing-person-handoff.md`; `../sources/product-owner/ontos-files-and-media-property.md`; `../sources/handoffs/ontos-files-media-main-thread-handoff.md`.

## DEC-081 — Every Task Property may be mandatory

- Decision: Every Task Property Definition may be marked Mandatory, regardless of datatype.
- Existing Tasks: Enabling Mandatory does not backfill or rewrite Empty values. The values may remain Empty until someone next submits an edited Task form; that form cannot be saved until every Mandatory Task Property on the Task is non-empty.
- Datatype effect: Clearing a Mandatory value through an edited Task form is invalid. Intrinsically non-empty datatypes satisfy Mandatory automatically, including Checkbox where `false` is non-empty, derived Task Properties, and ID.
- Scope: All Task Property datatypes.
- Product resolution: [PR-004](../product/product-resolutions.md#pr-004--every-task-property-may-be-mandatory).
- Original source positions: `../sources/product-owner/ontos-checkbox-property.md`; `../sources/handoffs/ontos-checkbox-property-handoff.md`; `../sources/handoffs/ontos-email-property-handoff.md` clarification 2; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/handoffs/ontos-task-ticketing-handoff.md`.

## DEC-082 — Text-like queries share comparison and Empty rules

- Decision: Compare non-empty text case-insensitively but diacritic-sensitively using the Task Collection locale. Canonical Unicode equivalence is delegated to that collation without rewriting stored/displayed text.
- Empty behavior: Empty matches negative text filters, including `Does not contain`, and sorts last in both ascending and descending order.
- Scope: Text, URL, Email, and other text-like Task Property query behavior unless an operation is explicitly excluded or a datatype defines a more specific non-text value model.
- Product resolution: [PR-005](../product/product-resolutions.md#pr-005--text-like-queries-share-comparison-and-empty-rules).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F5–F6/J.4; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/product-owner/ontos-url-property.md` §§F10–F11/J.H4–H5; `../sources/handoffs/ontos-url-property-handoff.md`; `../sources/product-owner/ontos-email-property.md` §§F6–F8; `../sources/handoffs/ontos-email-property-handoff.md` clarification 3.

## DEC-083 — Text duplication copies definition configuration only

- Decision: Text duplication presents a confirmation action, not a copy-values choice. On confirmation, create a new independent Text definition, apply the shared generated `Name Copy` sequence, and copy the Mandatory setting. No other configuration or per-Task values are copied.
- Value effect: Every existing Task is Empty for the duplicate. When Mandatory is copied as enabled, the deferred form-validation behavior in [DEC-081](#dec-081--every-task-property-may-be-mandatory) applies.
- Scope: Text exception to the generic optional value-copy duplication flow.
- Product resolution: [PR-006](../product/product-resolutions.md#pr-006--text-duplication-copies-definition-configuration-only).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F8/J.1; `../sources/handoffs/ontos-text-property-handoff.md`; `../sources/handoffs/ontos-task-ticketing-handoff.md` duplication baseline.

## DEC-084 — Multi-select values display in catalog order

- Decision: Display a Task's selected Multi-select Options in the definition's shared catalog order, never selection-time order.
- Product effect: Catalog reorder changes presentation everywhere but does not change option identity or Task selection membership.
- Scope: Multi-select value presentation.
- Product resolution: [PR-007](../product/product-resolutions.md#pr-007--multi-select-values-display-in-catalog-order).
- Original source positions: `../sources/product-owner/ontos-multi-select-property.md` §J.H2; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`.

## DEC-085 — Multi-select color selection uses ColorSelect

- Status: Superseded by [DEC-098](#dec-098--option-color-editing-uses-colorselect) for current shared application. This entry is retained only as the historical C-019 engineering disposition and is not a separate current rule.
- Engineering decision: Use the existing `@techsio/ui-kit` `ColorSelect` component when an authorized schema editor chooses or changes a Multi-select Option color.
- Business effect: None. This decision does not choose a palette, automatic-assignment algorithm, color serialization, or creation requirement. The original Multi-select business rule continues to assign a supported color automatically and allows later change.
- Shared application: [DEC-098](#dec-098--option-color-editing-uses-colorselect) applies the same component dependency to every option datatype.
- Scope: Multi-select Option color-selection UI only.
- Resolution record: [PR-008](../product/product-resolutions.md#pr-008--multi-select-color-selection-uses-colorselect).
- Original source positions: `../sources/product-owner/ontos-multi-select-property.md` §§F4.5/J.H4; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`.

## DEC-086 — ID deletion impact includes soft-deleted Tasks

- Decision: The ID deletion-confirmation count includes every retained Task with an ID assignment, including soft-deleted Tasks.
- Product effect: The count represents all assignments that will be permanently deleted, rather than only active or currently visible Tasks.
- Scope: ID definition deletion confirmation.
- Product resolution: [PR-009](../product/product-resolutions.md#pr-009--id-deletion-impact-includes-soft-deleted-tasks).
- Original source positions: `../sources/product-owner/ontos-id-property.md`; `../sources/handoffs/ontos-id-property-handoff.md`; `../sources/handoffs/ontos-task-ticketing-handoff.md` deletion-confirmation baseline.

## DEC-087 — ID property deletion permanently removes its state

- Decision: Confirmed ID property deletion permanently deletes the definition, prefix, every Task ID Assignment, and the sequence counter. It is not a hide or soft deletion.
- Re-addition: A later ID addition creates a new definition/sequence and freshly backfills all retained Tasks from `1` in the deterministic order from DEC-074. The new namespace may reuse numbers that existed before deletion.
- Scope: ID property lifecycle; supersedes the removal portion of DEC-077 and `../sources/handoffs/ontos-id-property-handoff.md` product decision 2.
- Product resolution: [PR-010](../product/product-resolutions.md#pr-010--id-property-deletion-permanently-removes-its-state).
- Original source positions: `../sources/handoffs/ontos-task-ticketing-handoff.md` generic removal baseline; `../sources/product-owner/ontos-id-property.md` §BR-14; `../sources/handoffs/ontos-id-property-handoff.md` product decision 2.

## DEC-088 — Archive and restore update both last-edit facts

- Decision: A successful Task archive or restore atomically sets Last edited time to the operation's committed instant and Last edited by to its Effective Editor.
- Projection lifecycle: Both values are retained as Task facts independently of property definitions. Removing/re-adding either definition only hides/reveals its current fact and never resets it.
- Scope: Last edited time and Last edited by trigger alignment.
- Product resolution: [PR-011](../product/product-resolutions.md#pr-011--archive-and-restore-update-both-last-edit-facts).
- Original source positions: `../sources/product-owner/ontos-last-edited-time-property.md` §BR-03, acceptance criteria, and archive/restore BDD; `../sources/product-owner/ontos-last-edited-by-property.md` §§BR-04–BR-05; `../sources/handoffs/ontos-task-ticketing-last-edited-by-handoff.md`.

## DEC-089 — System-time properties share one filter contract

- Decision: Created time and Last edited time support the same operators: exact instant, before, after, on or before, on or after, exact local calendar day, and custom local date range.
- Precision and zone: Exact-second matching covers the full half-open second so hidden milliseconds match. Local day and range boundaries are converted to absolute instants using the viewer's configured IANA time zone; changing zone may change local-calendar results but not exact-instant results.
- Scope: Created time and Last edited time filtering.
- Product resolution: [PR-012](../product/product-resolutions.md#pr-012--last-edited-time-uses-the-created-time-filter-contract).
- Original source positions: `../sources/product-owner/ontos-created-time-property.md` §§F8–F10; `../sources/handoffs/ontos-created-time-property-handoff.md`; `../sources/product-owner/ontos-last-edited-time-property.md` §BR-14; `../sources/handoffs/ontos-last-edited-time-handoff.md`.

## DEC-090 — Phone is bounded single-line exact text

- Decision: A non-empty Phone value is limited to 256 Unicode code points and must be single-line. Reject carriage returns, line feeds, Unicode line/paragraph separators, tabs, NUL, and other control characters.
- Preservation: Preserve every other accepted character exactly. Unicode-whitespace-only is Empty.
- Invalid input: Reject an over-limit or prohibited-character input/paste as a whole without truncating or stripping it; keep the previous persisted value while the invalid draft is corrected.
- Scope: Phone input and persistence validation.
- Product resolution: [PR-013](../product/product-resolutions.md#pr-013--phone-is-bounded-single-line-exact-text).
- Original source positions: `../sources/product-owner/ontos-phone-property.md` §§BR-04–BR-09; `../sources/handoffs/ontos-phone-property-handoff.md`. External standards considered: ITU-T E.164, RFC 3966, and the WHATWG HTML Telephone state.

## DEC-091 — URL uses a bounded WHATWG-compatible HTTP(S) profile

- Decision: Limit a stored URL to 8,000 UTF-8 bytes and require successful WHATWG parsing as one absolute `http` or `https` URL with a non-empty host.
- Accepted hosts: Accept `localhost`, valid IPv4, bracketed IPv6, explicit valid ports, and valid internationalized domain names. Perform no DNS, availability, or reachability check.
- Credentials: Reject any embedded username or password information.
- Preservation: Store exact trimmed input rather than parser-normalized serialization. Reject invalid or over-limit input as a whole and retain the previous persisted value.
- Scope: URL input and persistence validation.
- Product resolution: [PR-014](../product/product-resolutions.md#pr-014--url-uses-a-bounded-whatwg-compatible-https-profile).
- Original source positions: `../sources/product-owner/ontos-url-property.md` §§F1–F7/J.H1–H3; `../sources/handoffs/ontos-url-property-handoff.md`. External standards considered: RFC 3986, RFC 5890/IDNA, RFC 9110 §4.1, and the WHATWG URL Standard.

## DEC-092 — Unresolved Core References degrade to searchable plain text

- Decision: When a Text Mention or Relation target is deleted or cannot be resolved, retain its stable target identity and last display label, and render that label as plain non-clickable text rather than removing the token. For example, clickable `@Alice` becomes plain `@Alice`.
- Search behavior: The fallback label participates in Text search and filters as ordinary readable text.
- Lifecycle effect: A reference that becomes resolvable again may return to active rendering; a permanently deleted target remains a plain-text fallback. Permission denial alone does not trigger fallback: [DEC-099](#dec-099--core-references-span-microverticals-and-authorize-when-opened) keeps resolvable targets clickable and authorizes each open attempt.
- Scope: Core Reference visibility, lifecycle, and Text search projection.
- Product resolution: [PR-015](../product/product-resolutions.md#pr-015--unresolved-core-references-degrade-to-searchable-plain-text).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F4–F5/J.5; `../sources/handoffs/ontos-text-property-handoff.md`.

## DEC-093 — Files & media uses a configurable shared upload limit

- Refined decision: Accept consistent detected types and unknown/inconclusive content with no positive mismatch. Reject a positive conflict between detected content and a meaningful filename extension or client-declared MIME type under [DEC-103](#dec-103--core-media-authoritatively-validates-download-only-uploads). All committed files are initially download-only; no preview capability is in scope.
- Size policy: Core Media owns one deployment-wide environment setting, defaulting to exactly `104857600` bytes (100 MiB) per file. Do not expose a per-tenant or per-property limit. A configuration change applies to subsequent uploads and does not invalidate, delete, or rewrite committed items.
- Link policy: Validate external items using the URL contract in [DEC-091](#dec-091--url-uses-a-bounded-whatwg-compatible-https-profile), without checking availability.
- Scope: Files & media upload and external-link validation.
- Product resolution: [PR-016](../product/product-resolutions.md#pr-016--files--media-uses-a-configurable-shared-upload-limit).
- Original source positions: `../sources/product-owner/ontos-files-and-media-property.md` §§F5/J.H1–H2; `../sources/handoffs/ontos-files-media-main-thread-handoff.md`.

## DEC-094 — Number uses ordinary mathematical order

- Decision: Correct the Number source typo to the ordinary mathematical relation `5 > 0`; positive five is not less than zero.
- Scope: Number source correction only; this does not add a new operator or product capability.
- Sources: `../sources/product-owner/ontos-number-property.md` §G; `../sources/handoffs/ontos-number-property-handoff.md` “Outcome of this discussion”.

## DEC-095 — Core Principal Preferences owns the configured IANA time zone

- Decision: Store the configured IANA time-zone preference against the tenant-scoped Core human Principal, not the Better Auth user/session and not a Ticketing property. Resolve it through a governed Core Principal Preferences read using the authenticated `OperationContext`.
- Read contract: Resolve a persisted configured value first, otherwise a valid browser-supplied IANA identifier as initialization/fallback, otherwise `UTC`. Return both the effective identifier and whether its source is `configured`, `browser_fallback`, or `system_fallback`. A browser value never overwrites an existing configured preference.
- Query effect: Resolve once per request and use the same effective zone for presentation and local-calendar filter boundaries. Absolute stored instants remain unchanged.
- Durable contract: [Core Principal time-zone preference contract](../contracts/core-principal-time-zone-preference.md).
- Scope: Shared Core implementation dependency for Created time and Last edited time; no new Task Property business capability.
- Architecture evidence: `packages/core-runtime/src/db/schema.ts` owns tenant-scoped Principals, `packages/core-runtime/src/operation-context.ts` carries `tenantId` and `principalId`, `packages/core-runtime/src/operation-context-from-session.ts` resolves the Principal, and `packages/core-runtime/src/db/auth-schema.ts` contains replaceable authentication records only.
- Product sources preserved: `../sources/product-owner/ontos-created-time-property.md` §§F7–F10; `../sources/handoffs/ontos-created-time-property-handoff.md`; `../sources/handoffs/ontos-last-edited-time-handoff.md`.

## DEC-096 — Select automatic option ordering uses the viewer's user locale

- Decision: Derive `Alphabetical` and `Reverse alphabetical` Select option order using each viewer's configured user locale. Different viewers may therefore see different automatic orders for the same shared catalog.
- Manual transition: Changing an automatic mode to `Manual` snapshots the exact order displayed to the acting user and persists it as the shared manual order. Subsequent locale changes do not reorder Manual mode.
- Determinism: Reverse alphabetical reverses the locale-derived alphabetical order; stable option identity breaks equal collation results.
- Scope: Select option-catalog presentation and automatic-to-Manual transition, not Task-row sorting.
- Product resolution: [PR-017](../product/product-resolutions.md#pr-017--select-automatic-option-ordering-uses-the-viewers-user-locale).
- Original source positions: `../sources/product-owner/ontos-select-property.md` §J.4; `../sources/handoffs/ontos-select-property-handoff.md` conclusion 8; [DEC-014](#dec-014--select-option-uniqueness-and-ordering-are-deterministic).

## DEC-097 — Empty Select values match `is not <option>`

- Decision: A Task with an Empty Select value matches `is not <option>` because its value is not the named option. A Task selecting another option also matches; a Task selecting the named option does not.
- Operator distinction: `is empty` and `is not empty` remain explicit presence predicates; `is not empty` does not include Empty.
- Scope: Select Task filtering only.
- Product resolution: [PR-018](../product/product-resolutions.md#pr-018--empty-select-values-match-is-not-option).
- Original source positions: `../sources/product-owner/ontos-select-property.md` §F9; `../sources/handoffs/ontos-select-property-handoff.md` conclusion 11; [DEC-017](#dec-017--select-is-not-empty-membership).

## DEC-098 — Option color editing uses ColorSelect

- Engineering decision: Select, Multi-select, and Status use the existing `@techsio/ui-kit` `ColorSelect` component wherever an authorized schema editor chooses or changes an Option color.
- Business effect: None. This decision does not define a shared palette, automatic-assignment algorithm, persistence representation, uniqueness rule, or new creation flow. Existing datatype rules remain authoritative.
- Component boundary: The application supplies `ColorSelect` with its available colors and selected state and handles the selected color through the component callback. Those integration details do not become Task Property business behavior.
- Scope: Select, Multi-select, and Status Option color-selection UI.
- Resolution record: [PR-019](../product/product-resolutions.md#pr-019--option-color-editing-uses-colorselect).
- Durable contract: [ColorSelect integration contract](../contracts/option-color.md).
- Subsumes: [DEC-085](#dec-085--multi-select-color-selection-uses-colorselect) without changing its engineering-only classification.
- Original source positions: `../sources/product-owner/ontos-select-property.md` §F4; `../sources/handoffs/ontos-select-property-handoff.md`; `../sources/product-owner/ontos-multi-select-property.md` §§F4.5/J.H4; `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`; `../sources/product-owner/ontos-status-property.md`; `../sources/handoffs/ontos-status-property-handoff.md`.

## DEC-099 — Core References span microverticals and authorize when opened

- Decision: A Text Mention or Relation may target any Business Entity exposed by any registered microvertical in any tenant. Store an opaque Core Reference identity and last resolved label rather than a locally interpreted raw target ID.
- Discovery: Core federates picker search, but each target microvertical controls which entities it exposes as discoverable. A known Core deep link or opaque token may be pasted even if the entity was not discoverable; a raw guessed ID is insufficient.
- Resolution and authorization: A resolvable target remains clickable regardless of the viewer's permission. The owning microvertical performs a fresh authorization check immediately before opening; denial prevents navigation and does not mutate the reference.
- Lifecycle: Rename refreshes the active label without changing identity. Deleted or unresolvable targets use DEC-092 plain-text fallback and may become active again if resolution recovers. Permission denial alone never causes fallback.
- Scope: Text Mention/Relation eligibility, cross-tenant selection, active resolution, opening, authorization, and lifecycle.
- Product resolution: [PR-020](../product/product-resolutions.md#pr-020--core-references-span-microverticals-and-authorize-when-opened).
- Durable contract: [Core Reference contract](../contracts/core-reference.md).
- Original source positions: `../sources/product-owner/ontos-text-property.md` §§F4–F5/J.5; `../sources/handoffs/ontos-text-property-handoff.md`; [DEC-092](#dec-092--unresolved-core-references-degrade-to-searchable-plain-text).

## DEC-100 — Stale Task Property value writes are rejected with the draft preserved

- Decision: Reject an ordinary editable Task Property Value write when its submitted value version is stale. Preserve the currently committed value; perform no last-write-wins overwrite or automatic merge.
- User-visible result: Show a Toast that the value changed elsewhere and the attempted change was not saved. Keep the user's unsaved draft in the editor rather than replacing or discarding it.
- Retry behavior: Retrying the unchanged stale write remains a conflict. Force overwrite, silent retry, and automatic merge are outside the current rule.
- Scope: Editable values for Text, Number, Select, Multi-select, Status, Date, Date Range, Person, Files & media, Checkbox, URL, Email, and Phone. This does not govern derived values, schema/configuration mutations, or deletion-impact confirmation.
- Product resolution: [PR-021](../product/product-resolutions.md#pr-021--stale-task-property-value-writes-are-rejected-with-the-draft-preserved).
- Original source positions: `../sources/handoffs/ontos-phone-property-handoff.md` “Deferred shared platform decisions”; affected datatype briefs; `../sources/handoffs/ontos-task-ticketing-handoff.md` shared value-mutation baseline.

## DEC-101 — Deletion impact includes every retained Task without lifecycle filtering

- Decision: Compute every generic property and option deletion-confirmation count over all retained Tasks. Do not filter by active, archived, soft-deleted, visible, permitted-in-a-list, or current-view status.
- Count and effect: Whole-property counts use the datatype's non-empty predicate; option counts use current option membership. Confirmed deletion affects that same retained population using the datatype's existing delete/clear/remove/replace behavior.
- Boundary: Archived and soft-deleted Tasks participate. Hard-deleted Tasks are no longer retained and do not participate.
- ID alignment: ID's previously settled retained-assignment count in DEC-086 is consistent with this shared rule; DEC-087 still governs its special hard deletion.
- Scope: All Task Property Definition deletion and Select, Multi-select, and Status Option deletion.
- Product resolution: [PR-022](../product/product-resolutions.md#pr-022--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).
- Original source positions: `../sources/handoffs/ontos-task-ticketing-handoff.md`; all datatype deletion sections; [DEC-086](#dec-086--id-deletion-impact-includes-soft-deleted-tasks).

## DEC-102 — Task Property logs are indefinite internal metadata evidence

- Decision: Persist Task Property change evidence in the existing `core.audit_events` and `core.domain_events` tables indefinitely. Do not expire, purge, compact, or cascade-delete it with live product data; do not add a datatype history or snapshot store.
- Access: Provide no product-facing UI, export, or application read API. Task Collection roles confer no access; only governed internal services and database/operations personnel may read the tables.
- Payload: Populate the current native actor/action/subject/outcome/timestamp/sequence columns and metadata-only JSON. Never log raw or formatted before/after property values, drafts, file content/names/URLs, reference labels, signed URLs, secrets, or failed raw inputs.
- Guarantee: The records establish that operations occurred, their subjects, actors, outcomes, order, and resulting revisions where recorded. They do not guarantee prior-state reconstruction, replay, history comparison, restore, rollback, undo, or time travel.
- Scope: Every Task Property datatype and all definition, configuration, option, and value mutations.
- Product resolution: [PR-023](../product/product-resolutions.md#pr-023--task-property-logs-are-indefinite-internal-metadata-evidence).
- Durable contract: [Task Property audit-log and domain-log contract](../contracts/audit-domain-log.md).
- Sources and architecture evidence: `../sources/handoffs/ontos-task-ticketing-handoff.md`; `../sources/handoffs/ontos-phone-property-handoff.md`; [DEC-078](#dec-078--audit-and-domain-logs-are-the-shared-version-record); `packages/core-runtime/src/db/schema.ts`; `packages/core-runtime/src/core-sdk.ts`.

## DEC-103 — Core Media authoritatively validates download-only uploads

- Decision: Core Media performs content detection and rejects a file when a positive detected type conflicts with a meaningful filename extension or client-declared MIME type. Unknown or inconclusive content is accepted as a generic download-only asset when no positive mismatch exists.
- Preview: Internal preview is unsupported for every type initially. Core exposes no safe-preview capability, conversion, viewer, or preview URL; every committed asset remains available only for authorized download.
- Configuration: Core Media reads deployment-wide `CORE_MEDIA_MAX_UPLOAD_BYTES`; absence yields `104857600` bytes (100 MiB). Core exposes the effective read-only policy to clients/Ticketing, which do not read the environment directly.
- Enforcement: Core Media is authoritative per file. Clients and ingress may reject earlier but cannot override Core acceptance. Oversized/mismatched files create neither Media Assets nor Files & media items; bulk upload reports independent per-file outcomes.
- Scope: Files & media uploaded items and the shared Core Media/configuration boundary. External URL items remain governed by DEC-091.
- Product resolution: [PR-024](../product/product-resolutions.md#pr-024--core-media-authoritatively-validates-download-only-uploads).
- Durable contract: [Core Media upload contract](../contracts/core-media-upload.md).
- Original source positions: `../sources/product-owner/ontos-files-and-media-property.md` §§F5/J.H1–H2; `../sources/handoffs/ontos-files-media-main-thread-handoff.md`; [DEC-093](#dec-093--files--media-uses-a-configurable-shared-upload-limit). Architecture evidence: `packages/core-runtime/src/db/schema.ts`.

## DEC-104 — Default-enabled query operations use datatype-aware semantics

- Search: Use a datatype-aware searchable projection. Textual fields use case-insensitive, diacritic-sensitive substring matching and Empty contributes no text. Number searches canonical decimal text, so `1250` matches `25`. Multi-select/Status search selected option names; Person/Created by search Principal display names; Files & media searches display filenames/external URLs; URL searches the stored string. Created/Last edited time parse viewer-locale temporal input in the configured IANA zone, with date-only input matching the whole local day and date-time input matching supplied precision.
- Scalar grouping: Text, Number, Status, URL, Email, Created by, and ID use existing equality/stable-identity semantics plus an Empty group where applicable. A case-insensitive group heading deterministically uses the spelling from the lowest stable Task identity.
- Temporal grouping: Created/Last edited time use viewer-local calendar day; Date uses exact stored date; Date Range uses the complete stored range including configured times; Empty is separate.
- Multi-valued grouping: Person fans a Task into every assigned Principal group. Files & media fans a Task into every displayed filename/URL group; equal labels use Task Collection locale comparison, not UUID identity. Duplicate equal labels place a Task in that group once. Empty is separate.
- Files & media filters: `Contains`, `Does not contain`, `Is empty`, and `Is not empty` over displayed labels; negative matching includes Empty.
- Sorting: Files & media compares its displayed-label sequence in stored item order lexicographically. Person compares the locale-sorted sequence of Principal display names. Created by sorts by current Principal display name. Empty is last in both directions; stable identities break remaining ties.
- Scope: Only operations made available by DEC-080 that previously lacked semantics. Existing explicit operation exclusions and already-defined datatype query semantics remain unchanged.
- Product resolution: [PR-025](../product/product-resolutions.md#pr-025--default-enabled-query-operations-use-datatype-aware-semantics).
- Original source positions: [DEC-080](#dec-080--query-and-grouping-capabilities-are-available-by-default); C-051's affected original datatype sources and briefs; `../sources/handoffs/ontos-task-ticketing-handoff.md`.
