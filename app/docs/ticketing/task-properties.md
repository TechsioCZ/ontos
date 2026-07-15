# Task Properties

This note records product/domain decisions from the ticketing grilling session. It is not an implementation plan.

## Core Model

- The Task experience is inspired by Notion.
- A Task is a work item in the ticketing app.
- A Task belongs to exactly one Task Collection.
- A Task Collection is a visible project-like set of Tasks and owns one shared Task Property schema.
- A Task View presents Tasks from one Task Collection. Views do not own the schema.
- A new Task Collection starts with one default Task View showing all Task Properties in collection order.
- A Task is created empty with only the Title Task Property present.
- Moving Tasks between Task Collections is not supported for now.

## Property Schema

- A Task Property is a field definition shared by all Tasks in a Task Collection.
- Each Task has its own Task Property Value for each property in its collection schema.
- Multiple Task Properties of the same Task Property Type may exist in one Task Collection.
- Task Property names are trimmed and unique within a Task Collection without regard to case.
- The locked Title property participates in the same name uniqueness rule.
- User-created Task Property types cannot be changed after creation.
- User-created Task Properties support normal create, read, update, delete, rename, duplicate, mandatory toggle, and type-specific configuration changes.
- Deleting any removable Task Property always requires confirmation.
- Delete confirmation shows the count of Tasks where the property is `Is not empty`.
- Hiding a Task Property in a view is separate from deleting it from the schema.
- Every Task Property schema change and Task Property Value change is versioned with a timestamp.

## Access Rights

- Full access can edit, suggest, comment, and share.
- Editor can edit, suggest, and comment.
- User has partial edit rights: they can edit Task Property Values, suggest, and comment, but cannot add, remove, duplicate, rename, reorder, hide, or edit the format/configuration of Task Properties.
- Viewer is read-only.

## Title

- Every Task Collection automatically has one Title Task Property.
- Title is a locked, mandatory Text property.
- Title is edited as a single-line input, not the rich multiline Text editor.
- Users cannot rename Title, delete it, hide it from views, duplicate it, make it optional, or change its type.
- No other Task Property in the same collection can be named `Title`, case-insensitively.

## Mandatory Properties

- User-created Task Properties can be marked mandatory or optional later.
- Mandatory means a non-empty value is required when saving a new or edited Task form.
- Existing Tasks are not backfilled or changed when a property becomes mandatory.
- If an existing Task has an empty mandatory property, validation blocks saving that Task form until the value is filled.
- Making a property mandatory does not require an impact-count warning.
- Mandatory status does not affect property deletion or ordering.
- Checkbox and Derived Task Properties cannot be marked mandatory.

## Ordering And Views

- Task Collection schema has a default Task Property Order used by the Task detail form and new views.
- Title is fixed first.
- User-created Task Properties can be manually ordered after Title.
- New user-created Task Properties are added at the end of the order.
- Duplicated Task Properties are placed immediately after the source property.
- Individual Task Views may hide or reorder user-created Task Properties without changing schema order.

## Duplication

- Duplicating a Task Property copies its configuration, including mandatory state.
- The duplicate receives a unique copy name, using `copy` and a number when needed.
- The duplicate is independent after creation.
- Every duplication asks whether values should also be copied.
- If values are copied, values are copied for all existing Tasks.
- If values are not copied, the duplicated property is Empty for all existing Tasks, except system-derived values that are automatically produced by the system.
- Title cannot be duplicated.
- Derived Task Property duplicates keep the same system value source rather than copying value snapshots.

## Search And Sort

- All Task Property Types are searchable, with type-specific search semantics.
- Table row sorting is available for sortable single-value types.
- Empty values sort after non-empty values in both ascending and descending order.
- Multi-select, Person, and Files & Media are not sortable for now.
- Select sorting follows the property's option order.
- Date Range sorting uses start date first, then end date.
- Date and Date Range search use exact date selection, such as through a date picker, not formatted text matching.

## Property Types

### Text

- Normal Text properties use the rich Text behavior defined in the Text property specification.
- Title uses a constrained single-line Text input instead.

### Number

- Number follows the Number property specification.
- Number is sortable and searchable.

### Select

- Select stores at most one Select Option.
- Table sorting by Select follows the property's option order.

### Multi-select

- Multi-select stores zero, one, or more Multi-select Options.
- Multi-select is searchable and filterable.
- Multi-select is not sortable for now.

### Status

- Status is its own Task Property Type, not a Select alias.
- A Task Collection may have multiple user-created Status properties.
- Status is not automatically created.
- Status options belong to fixed groups such as Not started, In progress, and Done.
- A new Status property starts with default statuses for those groups.

### Date

- Date stores one date.
- Search uses exact date selection.

### Date Range

- A non-empty Date Range value must have both start and end dates.
- The end date cannot be before the start date.
- Same-day ranges are valid.
- Search uses exact date selection.
- Sorting uses start date first, then end date.

### Person

- Person stores zero, one, or more Principals.
- Search matches visible Principal display names and visible email or login identifiers.
- Person is not sortable for now.

### Files & Media

- Files & Media stores zero, one, or more references to Core-managed media or artifact records.
- Ticketing does not own raw file storage for this property.
- Search matches file names only, not metadata or file contents.
- Files & Media is not sortable for now.

### Checkbox

- Checkbox has checked and unchecked values.
- Unchecked is a real value, not Empty.
- New Checkbox properties are Empty for existing Tasks until a value is set.
- Checkbox cannot be marked mandatory.

### URL

- URL stores one web address.
- Non-empty values must be valid enough to save as URLs.
- URL is sortable and searchable.

### Email

- Email stores one email address.
- Non-empty values must be valid enough to save as email addresses.
- Email is sortable and searchable.

### Phone

- Phone stores one phone number.
- Non-empty values use light normalization and validation because phone formats vary internationally.
- Phone is sortable and searchable.

### Derived Properties

- Created time, Created by, Last edited time, Last edited by, and ID are Derived Task Properties.
- Derived values are automatically produced by the system.
- Derived properties are optional to add to a Task Collection schema or view.
- Derived properties can be renamed, duplicated, hidden, or removed from the schema.
- Removing a Derived Task Property does not delete the underlying system fact.
- Derived properties cannot be marked mandatory.
- ID exposes a system-produced globally unique Task ID.
- Created by and Last edited by record a Principal.
