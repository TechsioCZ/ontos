# Ticketing

Ticketing manages Tasks whose structured fields are defined by a shared schema owned by their Task Collection.

## Language

**Task Collection**:
A durably named collection of Tasks. Its immutable name is assigned at creation. It owns exactly one non-reusable Task Property schema and, while an ID Task Property exists, its collection-scoped ID sequence.

**Task Property Definition**:
A schema-level field definition shared by every Task in one Task Collection.
_Avoid_: Property instance, Task field

**Task Property Value**:
The independent value of one Task Property Definition for one Task.
_Avoid_: Property definition

**Mandatory Task Property**:
A Task Property Definition whose value must be non-empty when an edited Task form is submitted. Existing Empty values are not backfilled when the definition becomes Mandatory.
_Avoid_: Required field

**Derived Task Property**:
A Task Property whose value is produced from an authoritative system fact rather than entered by a user.
_Avoid_: Read-only field, computed field

**Core Reference**:
A Mention or Relation to a Business Entity exposed by a registered microvertical. It retains an opaque stable target identity and last display label. A resolvable target remains clickable and is authorized by its owning microvertical immediately before opening; a deleted or unresolvable target appears as searchable, non-clickable plain text.

**Business Entity**:
A durably identified domain object exposed through the Core Reference contract by a registered microvertical. It may belong to any microvertical or tenant; its owning microvertical controls discovery, resolution, and authorization to open.

**Select Option**:
An independently identified choice owned by one Select Task Property Definition. Its name is presentation, not identity.

**Multi-select Option**:
An independently identified choice owned by one Multi-select Task Property Definition and selectable at most once in each Task Property Value.

**Status Option**:
An independently identified choice owned by one Status Task Property Definition, assigned to one fixed Status Group, and eligible to be that definition's Default.

**Default Status Option**:
The single Status Option automatically assigned to new Tasks and used to replace values whose selected Status Option is deleted.

**Person Directory**:
A Core-owned tenant-scoped service that searches identities eligible for new assignment and resolves stored Principal references, including identities that later became ineligible.

**Files & Media Item**:
An ordered Ticketing-owned value item with its own identity, either referencing a Core Media Asset or containing a validated external URL.

**Media Asset**:
A Core-owned record for uploaded bytes, storage metadata, processing state, and authorized preview/download access.

**Task Provenance**:
Intrinsic immutable Task metadata containing the creation instant and the stable Principal identity of the Actor that created the Task.

**Actor**:
The tenant-scoped human or named system Principal actually responsible for an operation.

**Originating Principal**:
The human Principal whose action initiated an automation chain, retained across downstream automatic Task mutations.

**Effective Editor**:
The Originating Principal for a user-initiated automatic mutation, otherwise the Actor that directly performs the successful Task mutation.

**ID Assignment**:
An immutable-within-its-ID-definition numeric identifier assigned to one Task from the Task Collection's non-reusing active sequence. Deleting the ID Task Property deletes the assignment and ends that sequence.
