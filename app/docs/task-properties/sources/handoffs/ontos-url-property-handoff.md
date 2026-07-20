# Handoff: ticketing URL property

## Purpose of the next session

Bring the completed URL-property discussion back into the main task-ticketing thread. Consolidate it with the shared property baseline and the other datatype handoffs. Do not start implementation unless the user explicitly asks.

This handoff is structured so the main thread can later invoke `to-spec`, followed by `to-tickets`, without re-interviewing the user about the URL property's established business behavior.

## Authoritative references

- Shared task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Full URL-property GOLD business specification: `/Users/jiprochazka/.codex/attachments/7d94d9b9-a0fc-4337-8907-73ad0c386b1e/pasted-text.txt`
- Repository root: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos`
- All implementation work must stay in `app/`; `mvp/` and `mvp2/` are read-only.

Treat the two referenced documents as authoritative; do not copy their full requirements into a new artifact. No conflict was found between the URL specification and the shared baseline.

## Confirmed additions and implementation interpretation

The user explicitly confirmed the proposed ten-point URL implementation profile:

1. Remove leading and trailing whitespace before validation.
2. Treat an empty result as clearing the property.
3. Reject internal whitespace or control characters.
4. Accept only HTTP or HTTPS URLs.
5. Parse as an absolute URL and require a non-empty hostname.
6. Store the user's exact trimmed string, not a parser-normalized serialization.
7. On validation failure, make no persistence change and create no value-version record.
8. On success, update the value and append the version atomically, using a server-generated timestamp.
9. If the post-trim stored value would be unchanged, treat the command as a no-op and do not append a version.
10. Open the exact stored value in a new browsing context with `noopener`/`noreferrer`, and copy the exact stored string.

For point 7, the user additionally required frontend validation and visible feedback:

- Validate on blur/save and show the localized validation message from the GOLD specification.
- Keep the invalid draft visible so the user can correct it.
- Keep the previously persisted valid URL unchanged.
- Repeat the same validation authoritatively on the backend for non-UI callers and defense in depth.
- An empty value is a valid clear operation, not a validation error.

Invalid attempts are not changes and therefore do not enter value history. They may still be captured by the platform's ordinary rejected-action observability/audit behavior if that behavior applies globally.

## Current repository readiness

The ticketing vertical is still a generated scaffold, not a task-property implementation:

- `app/verticals/ticketing/shared/api.ts` models a ticketing item with only `id`, `title`, and build marker data.
- `app/verticals/ticketing/api/index.ts` serves one hard-coded item and synthesizes create responses without persistence.
- There is no ticketing-owned task schema, property-definition model, property-value persistence, URL value module, filtering/sorting implementation, or URL UI.

Therefore URL should not be implemented as an isolated field. The shared task/property foundation described in the baseline must exist first: task schemas, property definitions, sparse task values (`Empty` represented without inventing a URL string), schema lifecycle actions, permission enforcement, persistence, and timestamped value history.

The worktree already contained user-owned changes when inspected, including a deletion under `app/docs/ticketing/` and generated diagnostics changes. Preserve them and do not infer that the deleted document should be restored. This session made no workspace changes.

## Proposed module and test seam

Prefer one high external seam for task property value commands, shared by callers and behavior tests. A set/clear command should accept task identity, property identity, the raw candidate value, actor context, and concurrency/version context; it should return an updated observable value, a no-op result, or a typed validation/authorization/concurrency failure.

URL parsing, exact-value preservation, persistence, version creation, and invalid-update preservation should remain behind that interface. The frontend may reuse a browser-safe validator for immediate feedback, but the backend command remains authoritative. Tests should exercise observable behavior through the command/action interface rather than testing parser helpers or database internals directly.

For end-to-end acceptance, retain the GOLD Gherkin scenarios as the behavior source. Add coverage for the confirmed no-op rule, frontend error visibility, unchanged persisted value after invalid edits, backend rejection of bypassed frontend validation, atomic version creation on valid changes, and absence of a version on invalid/no-op attempts.

The main thread should confirm this seam when running `to-spec`, as required by that skill. It was proposed during this discussion but the user's numbered confirmation was specifically about the ten behavioral rules above, not an explicit approval of the seam shape.

## Shared decisions intentionally outside the URL datatype

The GOLD specification delegates these to common text-property/system behavior and they should remain consistent across datatypes:

- Case sensitivity and collation for `Contains` and `Does not contain`.
- Whether `Empty` matches a negative text filter.
- Placement of `Empty` values during sorting.

Do not invent URL-specific variants of those rules. Resolve them while consolidating the shared filtering and sorting model.

## Unconfirmed, non-blocking recommendations

The following were suggested but not confirmed by the user and must not be presented as decided requirements:

- An 8,192-character URL value limit.
- Rejecting URLs containing embedded username/password credentials.
- Otherwise accepting syntactically valid HTTP(S) hosts such as localhost, IP addresses, non-default ports, and internationalized domains.

The GOLD behavior for its stated examples is implementable without resolving these unusual inputs. If the final specification chooses to constrain them, record that explicitly as a new business rule rather than silently tightening validation.

## Suggested skills

1. `domain-modeling` — when the main thread consolidates task, task schema, property definition, property value, `Empty`, actor/access level, value version, and schema version terminology across datatype handoffs.
2. `to-spec` — only when the user invokes it in the main thread. Use the baseline plus datatype handoffs as sources, prefer the single high command/action seam above, check that seam with the user, and publish the synthesized specification with the configured tracker vocabulary. Do not re-interview the user about URL behavior already confirmed here.
3. `to-tickets` — only after an agreed/published specification and when the user invokes it. Draft narrow, demoable tracer-bullet vertical slices with explicit blocking edges; quiz the user on granularity and edges before publishing. The shared property foundation is expected to block the URL-specific slice unless an earlier slice establishes it end to end.
4. `implement` — only after actionable tickets exist and the user explicitly requests implementation.

Before either publishing skill is used, verify that the issue tracker and `ready-for-agent` triage vocabulary have been configured; use `setup-matt-pocock-skills` if they have not.
