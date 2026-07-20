# Handoff: task ticketing Email property

## Purpose

Return the completed Email-property discussion to the main task-ticketing thread. The main thread should consolidate this datatype with the other property handoffs, then may later invoke `to-spec` and `to-tickets`. Do not implement from this handoff alone.

## Authoritative inputs

- General task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Final Email business specification, including acceptance criteria and Gherkin scenarios: `/Users/jiprochazka/.codex/attachments/725ec851-8c49-410a-8f0b-09e6598223e5/pasted-text.txt`

Treat those documents as authoritative and do not reproduce them into another planning artifact. This handoff records only the implementation clarification delta and repository findings.

## Resolved clarifications

There are no remaining Email-specific business questions.

1. **Normative validator:** Use one deterministic practical ASCII/punycode grammar, shared by server and client, while preserving the trimming and examples in the business specification. The server remains authoritative.
   - Maximum stored address length: 254 ASCII characters.
   - Local part: 1–64 ASCII characters using a practical dot-atom form. Allow letters, digits, ``!#$%&'*+/=?^_`{|}~-``, and dots only between non-empty atoms. Reject leading, trailing, and consecutive dots.
   - Domain: 1–253 ASCII characters, at least two non-empty labels, each label 1–63 characters, containing letters, digits, or interior hyphens. Reject leading/trailing hyphens. ASCII punycode labels such as `xn--...` are supported.
   - Reject internal whitespace/control characters, quoted local parts, comments, domain literals, raw non-ASCII local parts/domains, and multiple addresses.
2. **Mandatory configuration:** Email follows the general editable-property rule. It is optional by default but can be configured as mandatory.
   - Making it mandatory does not invent or backfill values.
   - A task whose mandatory Email is Empty cannot be saved until populated.
   - Clearing a mandatory Email is rejected rather than persisting Empty.
3. **Negative filters:** `Is not X` and `Does not contain X` include tasks whose Email value is Empty. `Is empty` and `Is not empty` remain available explicitly.
4. **History:** “Versioned with a timestamp” means immutable, informational history snapshots. The live projection is the source of current state; history is not event sourcing and does not imply undo. Removing a property deletes its live values while retaining static history for audit.
5. **Invalid-edit UX:** Keep the invalid draft visible with an inline explanation. Do not replace the previously persisted valid value. Cancel/reload returns to the persisted value.

## Implementation direction already discussed

- Put parsing, trimming, validation, and normalization behind one deep Email-value module interface so callers cannot implement different rules.
- Model Empty as absence of a live value row rather than materializing an empty row for every task.
- Keep the trimmed, case-preserved address for display and an invariant lowercase comparison/search representation for case-insensitive behavior.
- Treat search and `Contains` operands as literal substrings, not SQL wildcard syntax.
- Sort on the normalized address with Empty last for both directions and use a stable task identifier as a tie-breaker.
- Create a percent-encoded recipient-only `mailto:` activation; it performs no mutation and is available to readers, including Viewer access.
- Make property duplication and deletion transactional across the property definition and all live task values.
- The deletion confirmation count is a live `Is not empty` count. An implementation may use a separate numeric revision for optimistic concurrency; if the property changes between count and confirmation, refresh the count and request confirmation again.
- Enforce generic permissions at two distinct seams: shared-schema mutation versus task-value mutation. Email introduces no special role rules.

## Repository state and architectural consequences

Repository constraint: work solely in `app/`; `mvp/` and `mvp2/` are read-only.

No implementation or workspace artifact was created during this discussion. The ticketing vertical is currently a scaffold:

- `app/verticals/ticketing/api/index.ts` serves an in-memory sample.
- `app/verticals/ticketing/src/actions/create-ticket.ts` is a placeholder action and performs no task persistence.
- `app/packages/core-runtime/src/db/client.ts` and its Drizzle migration configuration currently register only core/auth schemas, not ticketing-owned tables.
- `app/scripts/spicedb/schema.zed` contains only coarse generic resources and cannot yet express Full access, Editor, User, and Viewer distinctions for shared-schema versus task-value operations.
- CoreSDK already provides the useful transaction/action seam and automatic domain-event/audit machinery.

Consequently, Email is not an isolated form-field change. The implementation needs a ticketing-owned shared task schema, property definitions, task values, immutable history, persistence/migrations, query behavior, and finer authorization. Keep that foundation inside the ticketing microvertical; avoid leaking datatype rules into CoreSDK.

The worktree already contained unrelated/user-owned changes, including an edited `app/AGENTS.md`, deletion of `app/docs/ticketing/task-properties.md`, and generated diagnostics changes. Preserve them; do not restore or overwrite them.

## Testing seams for `to-spec` to propose

Prefer existing high seams and confirm these with the user before publishing the spec, as required by `to-spec`:

1. **Primary behavior seam:** the ticketing Effect BFF contract executed through CoreSDK action/data-access registrations against PostgreSQL. Validate create/configure/set/change/clear, server rejection, permissions, history, search, filter, sort, duplication, and deletion here. This exercises the production transaction and authorization path.
2. **UI seam:** the Email editor and activation behavior. Validate invalid-draft preservation, inline error, mandatory feedback, absence of an action for Empty, and recipient-only `mailto:` activation.
3. **Focused module seam:** table-driven tests through the public Email parser interface for the full accepted/rejected grammar. Do not test parser internals.

PostgreSQL integration tests are necessary for case-insensitive comparisons, literal substring escaping, Empty semantics, ordering, transactionality, and stale deletion confirmation. External behavior matters; do not assert table layouts or helper calls.

Existing repository prior art includes CoreSDK action/policy/data-access tests under `app/tests/`, but there is not yet production ticketing-domain test coverage.

## Preparation for a later `to-spec`

- Invoke only when the main thread is ready to publish the consolidated specification.
- Synthesize the baseline, the full Email business specification, and the resolved clarifications above; do not re-interview about Email behavior.
- Use the agreed task-schema, property-definition, property-value, Empty, and access-level vocabulary consistently.
- Include the extensive user stories and acceptance behavior from the authoritative Email artifact without introducing broader email communication features.
- Include the proposed testing seams above and obtain only the seam confirmation required by the skill.
- Do not include repository file paths or code snippets in the published spec.
- Verify that an issue tracker and the `ready-for-agent` triage vocabulary are configured. Invoke `setup-matt-pocock-skills` first only if they are missing.

## Preparation for a later `to-tickets`

- Invoke after the consolidated spec exists and only when the user requests ticket creation.
- Use the published spec as the source and follow the skill's required breakdown review with the user before publishing.
- Produce tracer-bullet slices that each cross persistence, contract, authorization, UI where applicable, and tests. Do not create horizontal database-only, API-only, or UI-only tickets.
- A likely dependency shape to evaluate—not an approved ticket list—is:
  1. a narrow end-to-end shared-schema/task/property foundation demonstrating an optional Empty Email property;
  2. set/change/clear, deterministic validation, and mandatory behavior;
  3. case-insensitive search/filter/sort with defined Empty semantics;
  4. reader-safe Email activation and editor UX;
  5. duplication/deletion, live impact count, immutable history, and stale-confirmation handling.
- Authorization and history acceptance criteria belong within every affected slice rather than being postponed to horizontal cleanup tickets.
- Declare real blocking edges, keep each ticket within one fresh context window, and publish only after the user approves granularity and dependencies.

## Suggested skills

1. `to-spec` — next, when the main thread is ready to synthesize and publish the consolidated product specification.
2. `to-tickets` — after the spec is published and the user asks for tracer-bullet ticketing.
3. `setup-matt-pocock-skills` — only if the tracker or triage vocabulary has not already been configured.
4. `domain-modeling` — if the main thread needs to consolidate terminology across all datatype handoffs before publishing.
5. `codebase-design` — when fixing the task-schema/property-value seams and keeping datatype logic local to ticketing.
6. `implement` — only after approved tickets exist and the user explicitly requests implementation.
