# Handoff: task ticketing baseline

## Current state

The product owner supplied the general requirements for a Notion-inspired task-ticketing model. No implementation, repository artifact, issue, specification, or design decision has been created yet. No workspace files were changed.

The user plans to provide a separate detailed document for every property datatype in fresh tasks and hand those results back into this work later. Treat those future documents as additions to the baseline below.

## Baseline requirements

- A new task initially contains only `Title`.
- A task can contain properties, including multiple distinct properties of the same datatype.
- Properties belong to a shared task schema. Creating a property makes it available on every task that uses that schema; existing tasks receive it with the value state `Empty`.
- Removing a property from one task removes it from the shared schema and therefore from all tasks using that schema.
- Every property removal requires a confirmation dialog that displays the number of values matching `Is not empty`.
- Duplicating a property creates a new, independent property with the original property's configuration.
- Every duplication asks whether to copy values:
  - If accepted, values are copied for every existing task.
  - If declined, the duplicate is empty for every task.
- Later changes to the original property and its duplicate do not affect each other.
- Every change is versioned with a `timestamp`.

## Access levels

1. Full access: edit, suggest, comment, share.
2. Editor: edit, suggest, comment.
3. User: may edit property values but may not add, remove, duplicate, or change the format/configuration of properties; may suggest and comment.
4. Viewer: read-only.

## Property datatypes awaiting detailed documents

- Text
- Number
- Select
- Multi-select
- Status
- Date
- Date range
- Person
- Files & Media
- Checkbox
- URL
- Email
- Phone
- Created time
- Created by
- Last edited time
- Last edited by
- ID

## Repository constraints

- Work only in `@app`.
- Treat `mvp/` and `mvp2/` as read-only.

## Guidance for the next agent

- Preserve the baseline semantics while incorporating each datatype-specific handoff.
- Do not silently resolve conflicts between a datatype document and this baseline; identify the conflict and ask for a product decision if it materially changes behavior.
- Keep schema-level operations distinct from task-level value edits, especially when applying permissions.
- Do not begin implementation unless the user explicitly requests it.

## Suggested skills

- `domain-modeling`: use when consolidating the task, schema, property-definition, property-value, permission, and version terminology.
- `to-spec`: use after the datatype documents have been consolidated and the user wants the agreed requirements published as a specification.
- `grilling`: use if the user asks to stress-test unresolved product behavior before implementation.
- `implement`: use only after an actionable specification or tickets exist and the user asks for implementation.
