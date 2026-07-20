# Handoff: Checkbox property for task ticketing

## Purpose

Return the finalized Checkbox-property discussion to the main ticketing task so it can later be synthesized with the general property model using `to-spec`, then decomposed with `to-tickets`. Do not implement from this handoff alone unless the user explicitly asks.

This handoff is intentionally self-contained for the Checkbox datatype. It includes the product owner's business rules, acceptance criteria, BDD coverage, and the additional integration decisions confirmed by the user.

## Source artifacts

- General task-ticketing baseline: `/tmp/ontos-task-ticketing-handoff.md`
- Final Checkbox business specification and BDD scenarios: `/Users/jiprochazka/.codex/attachments/3b1bd130-48de-4580-88dd-83d6b4877c1b/pasted-text.txt`
- Workspace instructions: `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/AGENTS.md` and `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app/AGENTS.md`

## Readiness

- Readiness score from the Checkbox source document: GOLD.
- The property meaning is clear and separate from task completion.
- The value model contains only `true` and `false`.
- Default behavior for both new and existing Tasks is confirmed.
- Main flows, filtering, and important edge cases are testable.
- There are no remaining Checkbox-specific business questions.

## Product meaning

Checkbox is a general user-defined Task Property that lets a user record a simple binary condition on each Task.

- `true` means the condition represented by the property is marked as satisfied.
- `false` means the condition represented by the property is not marked as satisfied.

Checkbox does not automatically mean that a Task is complete. It has no automatic relationship to the Task's Status or any other property. The user determines the business meaning through the property name, such as `Approved`, `Invoiced`, or `Requires review`.

## Business goal

Users need to add simple binary flags to Tasks so they can:

- record whether a specific condition is satisfied,
- change the value independently on individual Tasks,
- filter Tasks according to whether that condition is satisfied.

## Actor

The main actor is a user who is allowed to manage Task properties and edit Tasks.

The detailed permission model is not defined in the Checkbox datatype specification. Use the general task-ticketing baseline for access levels unless a later common-property spec supersedes it.

## Checkbox datatype scope

The Checkbox datatype specification includes:

- creating a Task Property of type `Checkbox`,
- naming the Checkbox property,
- making the Checkbox property available on Tasks in the shared schema,
- assigning the default value,
- changing a value from `false` to `true`,
- changing a value from `true` to `false`,
- filtering Tasks by Checkbox value,
- adding a Checkbox property to existing Tasks.

## Checkbox datatype out of scope

The Checkbox datatype specification excludes:

- automatic connection to Task completion,
- automatic changes to Status,
- automatic actions triggered by Checkbox changes,
- history and audit behavior,
- bulk value changes,
- sorting and grouping,
- permissions,
- formulas and derived values,
- API and integrations,
- technical and visual implementation of the control,
- generic property lifecycle behavior, such as duplication or removal.

Where the general task-ticketing baseline defines lifecycle behavior, that baseline still applies unless contradicted by the Checkbox-specific value model or the confirmed integration decisions below.

## Business rules

### BR-01: General property

Checkbox is a general user-defined Task Property. Changing it does not, by itself, complete a Task or change any system Task state.

### BR-02: Property name

When creating a Checkbox property, the user gives it a name. The name expresses the condition represented by the Checkbox.

### BR-03: Allowed values

Checkbox has exactly one of two values:

- `true`
- `false`

Checkbox does not support `Empty`, `null`, or any third state.

### BR-04: Default value

The default Checkbox value is always `false`.

This applies to:

- a new Task created after the Checkbox property exists,
- an existing Task when a new Checkbox property is added to its shared schema.

### BR-05: Value is independent per Task

Each Task has its own value for a Checkbox property. Changing the value on one Task must not change the value of the same property on another Task.

### BR-06: Value changes

A user can change the value:

- from `false` to `true`,
- from `true` to `false`.

Repeated toggling must be allowed without restriction.

### BR-07: No side effects

Changing a Checkbox property must not automatically change:

- Task Status,
- Task Title,
- another property,
- the Task completion state.

### BR-08: Property configuration

Checkbox has no option list and no additional value configuration.

It does not support:

- user-defined options,
- custom labels for the values,
- custom colors for individual values,
- multiple selected values.

### BR-09: Filtering

Tasks can be filtered with these predicates:

- Checkbox is checked: value is `true`,
- Checkbox is unchecked: value is `false`.

Filter results must always use the current value of the property on each Task.

Because Checkbox cannot be `Empty`, these two filter predicates are exhaustive.

## Edge cases

### Adding a Checkbox property to existing Tasks

When a new Checkbox property is added to the shared schema, all existing Tasks get value `false`. The system must not leave existing Tasks without a value.

### New Task

A new Task gets value `false` for every existing Checkbox property until a user explicitly changes that value.

### Repeated toggling

Checkbox can be repeatedly changed between `true` and `false`. A previous change must not restrict a later change.

### Independent Tasks

Changing the value on one Task must not affect other Tasks.

### Independent properties

Changing one Checkbox property must not affect another Checkbox property or a property of another type.

### No third state

A Task must never have a Checkbox property in `Empty`. If the property exists for the Task, its value is always `true` or `false`.

## Acceptance criteria from the product owner

1. A user can create a Task Property of type `Checkbox` and name it.
2. Checkbox supports only `true` and `false`.
3. Checkbox cannot be left without a value.
4. After creating a Checkbox property, all existing Tasks have value `false`.
5. A newly created Task has default value `false` for all Checkbox properties.
6. A user can change the value from `false` to `true`.
7. A user can change the value from `true` to `false`.
8. The value changes only on the edited Task.
9. Changing Checkbox does not change Status or other properties.
10. Tasks can be filtered by value `true`.
11. Tasks can be filtered by value `false`.
12. Checkbox has no additional value configuration.

## BDD scenarios from the product owner

```gherkin
Feature: Checkbox property on a Task

  Users need to record simple conditions on Tasks,
  where each condition can be satisfied or not satisfied.

  Rule: Checkbox is a general binary property

    Scenario: Create a Checkbox property
      Given a user can manage Task properties
      When the user creates a property named "Approved" with type "Checkbox"
      Then property "Approved" is available on Tasks
      And its value can only be true or false
      And the property has no additional user-defined options

    Scenario: Checkbox is not the Task completion state
      Given a Task has Checkbox property "Approved" with value false
      And the Task is not marked as complete
      When the user changes "Approved" to true
      Then property "Approved" has value true
      And the Task completion state remains unchanged

  Rule: The default Checkbox value is false

    Scenario: Default value on a new Task
      Given Checkbox property "Approved" exists
      When the user creates a new Task
      Then property "Approved" on the new Task has value false

    Scenario: Add Checkbox property to existing Tasks
      Given Tasks exist in the system
      When the user creates Checkbox property "Approved"
      Then all existing Tasks have property "Approved" set to false
      And no existing Task has property "Approved" in Empty

  Rule: Checkbox value can be toggled

    Scenario: Check the Checkbox
      Given a Task has property "Approved" with value false
      When the user sets property "Approved" as checked
      Then property "Approved" has value true

    Scenario: Uncheck the Checkbox
      Given a Task has property "Approved" with value true
      When the user sets property "Approved" as unchecked
      Then property "Approved" has value false

    Scenario: Toggle the Checkbox repeatedly
      Given a Task has property "Approved" with value false
      When the user changes the value to true
      And then changes it back to false
      Then the resulting value of property "Approved" is false

  Rule: Checkbox value is independent for each Task

    Scenario: Change Checkbox on one Task
      Given Task "A" has property "Approved" with value false
      And Task "B" has property "Approved" with value false
      When the user changes property "Approved" on Task "A" to true
      Then Task "A" has property "Approved" value true
      And Task "B" has property "Approved" value false

  Rule: Changing Checkbox does not affect other properties

    Scenario: Change Checkbox when other properties exist
      Given a Task has property "Approved" with value false
      And the Task has Status property with value "In progress"
      And the Task has Checkbox property "Invoiced" with value false
      When the user changes property "Approved" to true
      Then property "Approved" has value true
      And the Status property remains "In progress"
      And property "Invoiced" remains false

  Rule: Tasks can be filtered by Checkbox value

    Scenario: Filter checked Tasks
      Given Task "A" has property "Approved" with value true
      And Task "B" has property "Approved" with value false
      When the user applies filter "Approved is checked"
      Then the system shows Task "A"
      And the system does not show Task "B"

    Scenario: Filter unchecked Tasks
      Given Task "A" has property "Approved" with value true
      And Task "B" has property "Approved" with value false
      When the user applies filter "Approved is unchecked"
      Then the system shows Task "B"
      And the system does not show Task "A"

    Scenario: Filter result updates after Checkbox change
      Given filter "Approved is checked" is active
      And a Task has property "Approved" with value false
      When the user changes property "Approved" to true
      Then the Task matches the active filter
```

## Confirmed integration decisions with the general baseline

The user resolved all Checkbox-specific interactions with the general task-ticketing baseline:

1. Checkbox is an explicit exception to the baseline's generic `Empty` initialization. If the property exists for a Task, its value is always `true` or `false`; new and existing Tasks receive `false` by default.
2. Duplicating a Checkbox property without copying values initializes the duplicate to `false` on every Task. Duplicating with values copies each Task's current boolean value.
3. The removal confirmation's `Is not empty` count is the total number of Tasks in the shared schema/Task Collection, not the number whose Checkbox is checked. Both `true` and `false` are non-empty values.

## General baseline behavior still relevant to Checkbox

The general task-ticketing baseline applies around the Checkbox datatype:

- A new Task initially contains only `Title` before properties from the shared schema are considered.
- A Task can contain properties, including multiple distinct Checkbox properties.
- Properties belong to a shared Task schema. Creating a property makes it available on every Task that uses that schema.
- Removing a property from one Task removes it from the shared schema and therefore from all Tasks using that schema.
- Every property removal requires a confirmation dialog that displays the number of values matching `Is not empty`; for Checkbox, this count is all Tasks in the shared schema/Task Collection.
- Duplicating a property creates a new independent property with the original property's configuration.
- Every duplication asks whether to copy values.
- Later changes to the original property and its duplicate do not affect each other.
- Every change is versioned with a `timestamp`.
- Access levels from the baseline apply unless superseded by a later common-property spec:
  - Full access: edit, suggest, comment, share.
  - Editor: edit, suggest, comment.
  - User: may edit property values but may not add, remove, duplicate, or change the format/configuration of properties; may suggest and comment.
  - Viewer: read-only.

## Interpretation notes

- The final Checkbox document is authoritative over older contradictory Checkbox notes.
- `app/docs/ticketing/task-properties.md` is staged as deleted in the current worktree. Its committed version said that new Checkbox properties were `Empty` for existing Tasks; do not restore or reuse that superseded rule.
- Mandatory-property behavior is a separate common-property concern. The current Checkbox specification places general lifecycle/configuration outside its scope, and the current baseline does not define mandatory behavior. Do not infer a Checkbox mandatory rule from the staged-deleted document; address it in the common property specification if that capability is included later.
- The Checkbox source document lists generic history/audit, permissions, duplication, and removal as out of scope for the datatype. The corresponding general rules in the baseline still apply when Checkbox is integrated into the shared property model, including timestamped versioning and access levels.

## Repository state relevant to future work

- Work only under `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos/app`; `mvp/` and `mvp2/` are read-only.
- The ticketing vertical is currently a generated scaffold with in-memory starter items and Effect API/action plumbing.
- There is no persisted Task, Task Collection, Task Property definition/value model, Checkbox API, filtering implementation, or production Task UI yet.
- No implementation or repository workspace artifact was created or changed during the Checkbox discussion.
- The worktree already contains unrelated/user-owned changes, including the staged deletion above and generated diagnostics. Preserve them.

## Guidance for later specification and tickets

- Use the project vocabulary consistently: Task Collection owns the shared schema; Task Property is the definition; Task Property Value belongs to one Task and one property definition.
- State the Checkbox exception explicitly wherever a generic property rule otherwise produces `Empty`.
- Keep schema commands, such as create, duplicate, and remove, separate from per-Task value commands for permissions and versioning.
- At the contract boundary, a Checkbox value is a boolean; `null`/`Empty` is invalid.
- In a partial update, an omitted Checkbox field means unchanged, not `Empty`.
- Filtering must distinguish checked from unchecked and must include defaulted `false` values.
- The implementation may use explicit value rows or an implicit schema default, but externally every Task must immediately resolve to `false`; no transient `Empty` state is allowed.
- Prefer the highest practical behavior test point when specifying tests: an end-to-end ticketing vertical/application test that exercises schema creation or duplication, Task reads/updates, filtering, and observable version timestamps.
- Add narrower tests only for invariants that cannot be proven cleanly at the higher behavior level.
- The main thread should confirm the testing approach before `to-spec` publishes, as required by that skill.
- Issue-tracker configuration and triage labels were not inspected in this task. If they are not already configured in the main thread, follow the setup prerequisite required by `to-spec`/`to-tickets` before publishing.

## Suggested skills

1. `to-spec` - synthesize the baseline plus this Checkbox handoff, confirm the testing approach, and publish the specification. Do not re-interview the user about the three confirmed integration decisions.
2. `to-tickets` - invoke only after the specification exists and the user wants ticket decomposition. Produce narrow, demoable vertical slices with explicit blocking edges; quiz the user on granularity and dependencies before publishing.
3. `domain-modeling` - useful in the main thread when consolidating terminology and invariants across all property datatypes.
4. `implement` - use only after an actionable specification/ticket frontier exists and the user explicitly requests implementation.
