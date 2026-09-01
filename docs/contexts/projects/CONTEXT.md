# Projects language

Projects is the work-management domain. These terms describe product meaning, not storage or UI
implementation.

**Task** — One unit of work inside exactly one Task Collection. A new Task starts with only its
Title value; additional values follow the collection's property schema.

**Task Collection** — Schema-owning set of Tasks. It defines available Task Properties and their
configuration; views do not own the schema.

**Task View** — Saved presentation of a Task Collection, including visible properties, order,
filters, and sorting. A new collection starts with one default view showing every property in
collection order. Hiding a property in a view does not remove it from the collection.

**Task Property** — Named schema element defining one kind of value Tasks in a collection may hold.
Several properties of the same type may coexist.

**Task Property Name** — Trimmed user-facing name that is unique within its Task Collection without
regard to case, including names of locked properties.

**Task Property Value** — The value held by one Task for one Task Property. Empty is valid unless
the property is mandatory.

**Task Property Type** — Value kind and behavior of a Task Property, including validation, editing,
search, and sort semantics.

**Title Task Property** — Automatically created mandatory Text property that identifies Tasks for
users. It cannot be removed, hidden, duplicated, renamed, or changed to another type.

**User-created Task Property** — Property explicitly added by a user. It supports normal
create/read/update/delete configuration even when mandatory, but its type does not change after
creation.

**Derived Task Property** — Optional property whose value is produced by the system, such as
creation time, editor, or Task ID. Removing its schema entry does not delete the underlying system
fact.

**Mandatory Task Property** — Property requiring a non-empty value when a new or edited Task is
saved. Making an existing property mandatory does not rewrite old empty Tasks; the rule applies when
each Task is next edited and saved.

**Locked Task Property** — Property whose protected configuration cannot be changed by ordinary
schema editing.

**Hidden Task Property** — Property omitted from a particular Task View. It remains part of the
Task Collection and retains its values.

**Task Property Order** — Default presentation order in the collection and Task detail. Title stays
first; user-created properties follow in configurable order, while views may keep their own order.

**Duplicated Task Property** — Independent copy placed next to its source with a unique name,
configuration, and mandatory state. Duplication explicitly asks whether values should also be
copied; the copy does not remain synchronized.

**Task Property Deletion** — Removal of a user-created property, its configuration, and all of its
values after confirmation. Confirmation shows how many Tasks have a non-empty value. It is distinct
from hiding or clearing one value.

**Task Property Search** — Finding Tasks by type-specific matching of Task Property Values.

**Task Property Sort** — Ordering Tasks by type-specific value semantics. Empty values sort after
non-empty values in either direction. Multi-select, Person, and Files & Media are not sortable.

**Select Option** — Configured choice in a Select property; a Task chooses at most one, and sorting
follows configured option order.

**Multi-select Option** — Configured choice in a Multi-select property; a Task chooses zero or more.

**Status Task Property** — Dedicated workflow-state type whose options belong to groups such as Not
started, In progress, and Done. It is not a renamed Select.

**Person Task Property** — Property referencing zero, one, or more Principals, not external Parties
or free text. Search matches visible display names and visible email or login identifiers.

**Files & Media Task Property** — Property referencing zero, one, or more Core-managed media or
evidence records, never storing bytes inside Projects. Search matches filenames, not contents or
other metadata.

**Date Task Property** — A single date value with exact-date search semantics.

**Date Range Task Property** — Start and end dates where end cannot precede start; sorting uses
start, then end.

**Checkbox Task Property** — Checked or unchecked once set. Empty is distinct from unchecked, and
the property cannot be mandatory.

**URL, Email, and Phone Task Properties** — Lightly validated values with type-appropriate search
and presentation behavior.

**Task ID** — System-produced globally unique Task identifier that may be exposed through a Derived
Task Property.

**Task Audit Principal** — Principal recorded by system-derived authorship or edit properties. It
is distinct from a Person Task Property value.

**Task Access Level** — Permission bundle for Tasks and their property schema. Full access may edit,
suggest, comment, and share; Editor may edit, suggest, and comment; User may edit values, suggest,
and comment but not change schema; Viewer is read-only.

**Task Change Version** — Timestamped history record for a Task Property schema, configuration, or
value change.
