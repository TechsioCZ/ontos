# URL property analysis

## Sources

- Product-owner specification: `../../sources/product-owner/ontos-url-property.md`
- Technical handoff: `../../sources/handoffs/ontos-url-property-handoff.md`
- General ticketing baseline: `../../sources/handoffs/ontos-task-ticketing-handoff.md`

## Product definition

URL is a user-editable property containing Empty or one absolute HTTP(S) URL. It stores the user's exact trimmed string, exposes it as an openable/copyable link, and performs no reachability, status, preview, or content fetch.

## Input and validation

- Trim leading/trailing whitespace; an empty result clears the value.
- Reject internal whitespace/control characters, multiple URLs, relative values, missing hostname, and every scheme except `http`/`https`.
- Parse as an absolute URL with a non-empty hostname, but do not persist parser-normalized serialization.
- Limit the trimmed value to 8,000 UTF-8 bytes and require successful WHATWG parsing under [DEC-091](../decisions.md#dec-091--url-uses-a-bounded-whatwg-compatible-https-profile).
- Accept `localhost`, valid IPv4, bracketed IPv6, explicit valid ports, and valid internationalized domain names. Reject embedded username or password information.
- Preserve exact meaningful path case, encoding, query, fragment, scheme, and trailing slash as entered after trimming.
- Do not add a missing protocol, upgrade HTTP, or otherwise rewrite.
- Frontend validates on blur/save, keeps the invalid draft and shows localized feedback; backend repeats validation authoritatively.
- Invalid input preserves the prior value and creates no value version. A post-trim unchanged value is a no-op with no version.

## Open and copy behavior

- Open the exact stored string in a new browsing context with `noopener`/`noreferrer`; opening never changes data and does not require a reachability check.
- Copy returns the exact stored string.
- Empty offers neither action.

## Query capabilities

- Filters: `Contains`, `Does not contain`, `Is empty`, `Is not empty` over the stored string.
- Compare case-insensitively but diacritic-sensitively using the Task Collection locale; Empty matches `Does not contain` under [DEC-082](../decisions.md#dec-082--text-like-queries-share-comparison-and-empty-rules).
- Sort the entire stored string, not parsed domain/scheme/content, using the same collation; Empty is last in both directions.
- Standalone search performs case-insensitive, diacritic-sensitive substring matching on the exact stored string; Empty contributes no text.
- Grouping uses the same whole-string equality semantics, with Empty separate, under [DEC-104](../decisions.md#dec-104--default-enabled-query-operations-use-datatype-aware-semantics).

## Schema operations

Generic baseline lifecycle applies: shared creation, rename, optional-value duplication, independent values, and unconditional count-bearing deletion. Duplication assigns the next available shared `Copy` name under [DEC-079](../decisions.md#dec-079--property-naming-and-duplicate-suffixes-are-shared). The definition may be Mandatory under [DEC-081](../decisions.md#dec-081--every-task-property-may-be-mandatory) without backfilling existing Empty values.

## Permissions and versioning

- Full access and Editor manage schema and values; User edits values; Viewer may read/open/copy.
- A successful change and its audit-log/domain-log records are atomic under [DEC-078](../decisions.md#dec-078--audit-and-domain-logs-are-the-shared-version-record). Invalid/no-op attempts do not create change versions, though rejected-action observability may still apply.
- A stale URL value write is rejected under [DEC-100](../decisions.md#dec-100--stale-task-property-value-writes-are-rejected-with-the-draft-preserved): the committed URL remains, a Toast is shown, and the unsaved draft is preserved without automatic merge.

## Shared audit and domain evidence

- Accepted changes use the existing Core audit/domain tables indefinitely under [DEC-102](../decisions.md#dec-102--task-property-logs-are-indefinite-internal-metadata-evidence) and the [durable shared contract](../../contracts/audit-domain-log.md). The JSON payload is metadata-only, has no product read surface, contains no raw before/after property values, and does not guarantee state reconstruction.

## Retained-Task deletion population

- Whole-property deletion counts and affects every retained Task whose value is non-empty, including archived and soft-deleted Tasks. No lifecycle, visibility, permission-derived list, or current-view filter applies under [DEC-101](../decisions.md#dec-101--deletion-impact-includes-every-retained-task-without-lifecycle-filtering).

## Out of scope

Multiple links, relations, metadata/favicons/previews, reachability/status checks, content fetch, authentication, URL shortening, click tracking, scheme auto-completion, and non-HTTP(S) schemes.

## Unresolved business behavior
