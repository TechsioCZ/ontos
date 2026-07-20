# Handoff: Last edited time back to task ticketing

## Purpose

Return the completed `Last edited time` datatype discussion to the main task-ticketing thread. The next main-thread session should consolidate this datatype with the other property documents and may later invoke `to-spec`, followed by `to-tickets`. Do not implement from this handoff alone unless the user explicitly requests implementation.

## Source artifacts

- General task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Full `Last edited time` business specification, including business rules, acceptance criteria, and Gherkin scenarios: `/Users/jiprochazka/.codex/attachments/5af25190-edb6-4350-bf4e-0715d10fc407/pasted-text.txt`

Read both artifacts in full. This handoff does not reproduce their content.

## Resolved additions and overrides

The user confirmed the following decisions after comparing the datatype document with the general baseline:

1. **Duplication always copies for this derived datatype.** Duplicating a `Last edited time` property never produces `Empty`. The duplicate immediately exposes the same current task timestamp and continues to expose the same underlying system fact after future edits; this is not a value snapshot. The baseline's copy-or-empty choice is therefore not applicable to `Last edited time`.
2. **Schema operations do not edit tasks.** Adding, deleting, renaming, configuring, or duplicating properties does not update any affected task's `lastEditedAt`, including duplication that copies values and deletion of populated properties. Only an actual mutation of an individual task's own content or values updates it.
3. **Use the viewing user's time zone.** Present the instant using the user's configured IANA time zone and locale. A browser-detected IANA zone may initialize or provide a fallback for the user preference. Localization changes presentation only.

No business questions remain for this datatype.

## Canonical domain distinction

- `lastEditedAt` is a task-level system fact maintained whether or not any corresponding property definition exists.
- `Last edited time` is a derived Task Property that projects that system fact.
- Multiple property definitions of this type are independently renameable/removable schema definitions, but they do not own independent Task Property Values.

This distinction should be preserved when the main thread updates its domain glossary. It also resolves the apparent conflict between independent duplicated property definitions and their necessarily identical derived values.

## Repository findings

- Work is restricted to `app/`; `mvp/` and `mvp2/` are read-only.
- The ticketing vertical is currently a starter, not an implemented task/property system. Its list/get/create API operates on placeholder in-memory data.
- The existing `createTicket` action validates input and emits action/event plumbing but does not persist a Task.
- CoreSDK action handlers receive a database transaction. Business mutation, automatic domain event, outbox messages, action status, and audit event are committed through the existing transaction boundary. This is the appropriate boundary for atomically persisting a task state change and its `lastEditedAt`.
- Core currently stores a tenant default locale but no per-principal time-zone preference. The eventual implementation needs a user-preference source for an IANA time-zone identifier.
- Existing workspace changes are user-owned. In particular, `app/docs/ticketing/task-properties.md` is currently deleted in the index/worktree state; do not restore or overwrite it without explicit direction.

## Implementation guidance for a future specification

- Persist the canonical instant on the Task, initialized to the creation instant.
- Keep the fact current even when the derived property is absent from the Task Collection schema.
- Perform canonical no-op detection before updating `lastEditedAt`.
- Persist the task mutation and timestamp atomically; failures and cancelled changes retain the previous value.
- An idempotent replay must not create a second edit.
- Serialize an unformatted canonical instant through the API. Apply locale and time-zone formatting only at the presentation boundary.
- Sort and filter on the canonical instant, never localized text.
- Enforce system ownership server-side; absence of an editing control is not sufficient authorization enforcement.
- Store sufficient timestamp precision for rapid successive edits. Preserve a task revision/version for concurrency and deterministic sequencing independently of the displayed precision.
- Keep comments, reactions, views, and Task Collection schema commands outside the task-state mutation path so they cannot accidentally touch `lastEditedAt`.
- Historical accuracy requires collecting `lastEditedAt` from the first Task persistence implementation onward. If legacy Tasks are ever imported without trustworthy edit history, that migration policy will require a separate product decision.

## Recommended test seam for `to-spec`

Prefer one high, externally observable seam: execute authenticated Ticketing commands through the Effect/CoreSDK action boundary, then read the Task through the Ticketing query API and assert its canonical `Last edited time` projection. Use a controllable clock and real transactional persistence at this seam.

That seam can cover creation, successful edits, no-op writes, failures/rollback, archive/restore, automation/system actors, absence or duplication of the property, schema mutations, idempotent replay, sorting/filtering, and permission rejection without testing internal helper calls. Presentation-focused tests should separately verify locale, IANA time-zone, and DST conversion from a fixed canonical instant. Per the `to-spec` workflow, confirm this seam with the user before publishing the specification.

## State for later `to-spec`

- The full user-facing behavior and Gherkin scenarios are in the datatype source artifact.
- The three cross-document decisions above are confirmed and should appear under Implementation Decisions.
- Preserve the original document's Out of Scope section.
- Do not include repository file paths in the published spec; translate the repository findings into stable module/interface responsibilities.
- Before publishing, verify that an issue tracker and the `ready-for-agent` label vocabulary have been configured. If not, invoke `setup-matt-pocock-skills` as required by `to-spec`.

## State for later `to-tickets`

- Invoke only after the consolidated specification exists and the user asks for ticketing.
- Use tracer-bullet vertical slices that each deliver observable behavior across persistence, action/API, projection/UI, and tests.
- Likely dependency boundaries are: persisted Task system facts and mutation invariant; derived-property projection and duplication behavior; non-editing schema/comment/view paths; user time-zone presentation; canonical sorting/filtering. Treat these only as inputs to the required ticket-drafting and user-approval process, not as pre-approved tickets.
- Publish blocking edges only after the user approves granularity and dependencies.

## Suggested skills

1. `domain-modeling` — merge this resolved terminology into the main task-ticketing ubiquitous language alongside the other datatype handoffs.
2. `to-spec` — once the datatype documents are ready for consolidation, synthesize and publish the specification. Do not re-interview the user about already resolved behavior; only confirm the proposed test seam as the skill requires.
3. `to-tickets` — after a specification is available and the user requests it, draft user-approved tracer-bullet tickets with blocking edges and publish them to the configured tracker.
4. `implement` — only after an actionable spec/tickets exist and implementation is explicitly requested.

## Work performed in this session

- Read the baseline handoff and the full `Last edited time` business document.
- Cross-checked the proposed domain model against the current `app/` repository.
- Resolved the duplication, schema-mutation, and time-zone questions with the user.
- No workspace files were changed and no implementation, specification, ticket, issue, or ADR was created.
