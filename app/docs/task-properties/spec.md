# Complete Task Properties Specification

## Problem Statement

People working with Tasks need one coherent, predictable property system instead of a collection of unrelated field behaviors. A Task Collection must be able to define a shared schema, let authorized people configure it, let Task editors safely change values, expose dependable search/filter/sort/group behavior, and preserve intrinsic Task facts. Today the Ticketing vertical is only a scaffold and has no durable Task, Task Collection, property-definition, property-value, authorization, or query model capable of enforcing those rules.

The product definition has also accumulated datatype documents, handoffs, conflict resolutions, and engineering contracts. The implementation must honor the complete effective behavior without reviving superseded decisions, inventing missing product rules, leaking sensitive values into evidence logs, or turning UI implementation choices such as `ColorSelect` into new business behavior.

## Solution

Build Task Properties as a deep Ticketing domain capability owned by each Task Collection. One collection owns one non-reusable schema; definitions are shared by all retained Tasks in that collection, while ordinary values remain independent per Task. Authorized schema editors can add, rename, configure, duplicate, and remove definitions. Authorized Task editors can change ordinary values. Intrinsic properties project immutable or live Task facts and cannot be manually edited.

Support all 18 datatypes—Text, Number, Select, Multi-select, Status, Date, Date Range, Person, Files & media, Checkbox, URL, Email, Phone, Created time, Created by, Last edited time, Last edited by, and ID—with the exact cardinality, validation, duplication, deletion, query, dependency, and lifecycle behavior below. Persist mutations transactionally through the existing CoreSDK action boundary, query them through the public Ticketing read contract, use Core-owned contracts for identity, references, time-zone preferences, media, audit/domain evidence, and option color editing, and reject stale writes without losing the user's draft.

## User Stories

### Shared schema, lifecycle, permissions, and safety

1. As a Task Collection member, I want every Task in my collection to use one shared property schema, so that property definitions mean the same thing throughout the collection.
2. As a Task editor, I want each Task to keep independent ordinary property values, so that editing one Task does not change another Task.
3. As a schema editor, I want to create multiple definitions of the same datatype, so that the schema can model several distinct concepts with one datatype.
4. As a schema editor, I want ID to remain the only singleton datatype, so that a collection cannot acquire conflicting identifiers.
5. As a schema editor, I want property names trimmed, non-empty, and case-insensitively unique across the schema, so that definitions remain distinguishable.
6. As a schema editor, I want duplicate names to become `Name Copy`, `Name Copy 2`, and so on, so that a duplicate is immediately valid and recognizable.
7. As a schema editor, I want every property datatype to support Mandatory configuration, so that Task forms can enforce required information consistently.
8. As a Task editor, I want enabling Mandatory to leave existing stored values unchanged, so that a schema change does not fabricate data.
9. As a Task editor, I want the next submitted Task edit form to reject any remaining Empty Mandatory value, so that required data is enforced at the next real edit.
10. As a Task editor, I want Checkbox and intrinsic properties to satisfy Mandatory automatically, so that definitions which cannot be Empty never block a form.
11. As a Full access or Editor member, I want to manage property definitions and configuration, so that the collection schema can evolve.
12. As a Full access, Editor, or User member, I want to edit ordinary Task Property Values, so that day-to-day Task work is not limited to schema administrators.
13. As a Viewer, I want Task Property Values to be read-only, so that viewing cannot mutate Tasks.
14. As a Full access member, I want sharing to remain restricted to my access level, so that schema capability does not imply sharing authority.
15. As a schema editor, I want every property removal to require confirmation even when zero Tasks are affected, so that removal is always deliberate.
16. As a schema editor, I want a removal confirmation to count all retained Tasks whose value is not Empty, so that impact is accurate.
17. As a schema editor, I want impact counts and effects to include active, archived, and soft-deleted Tasks regardless of my view or current visibility, so that hidden retained data is not missed.
18. As a schema editor, I want hard-deleted Tasks excluded from impact counts, so that nonexistent Tasks do not inflate the result.
19. As a schema editor, I want generic property removal to delete the definition and its exposed ordinary values after confirmation, so that the shared schema changes consistently.
20. As a schema editor, I want generic duplication to copy configuration into an independent definition and ask whether to copy existing values, so that I can choose between a configured blank property and a value snapshot.
21. As a Task editor, I want later edits to an original definition, duplicate definition, or their values to remain independent, so that duplication does not create accidental coupling.
22. As a Task editor, I want a stale ordinary value write rejected without merge or overwrite, so that a concurrent edit cannot be silently lost.
23. As a Task editor, I want the committed value left unchanged, a Toast explaining the conflict, and my unsaved draft preserved after a stale rejection, so that I can recover without retyping.
24. As a compliance stakeholder, I want every accepted definition, configuration, option, and value mutation to emit atomic audit and domain metadata evidence, so that the occurrence and outcome of changes are durable.
25. As a privacy stakeholder, I want evidence records to omit raw values, drafts, file names, URLs, and other property content, so that operational evidence does not become a shadow value history.
26. As a product user, I want no property-history, audit-log, replay, undo, rollback, reconstruction, export, or time-travel surface from this capability, so that internal evidence is not mistaken for product history.
27. As a Task editor, I want schema-only operations to leave Last edited time and Last edited by unchanged, so that schema maintenance is not reported as a Task edit.
28. As a Task Collection member, I want supported query operations to use datatype-aware semantics, so that search, filters, sorting, and grouping remain meaningful.
29. As a Task Collection member, I want text-like comparisons to be case-insensitive, diacritic-sensitive, canonically Unicode-equivalent, and based on the Task Collection locale, so that query results are predictable without changing stored display text.
30. As a Task Collection member, I want Empty to match negative text-like predicates and sort last in both directions, so that absence has consistent query behavior.

### Text

31. As a Task editor, I want Text to hold either Empty or one multiline inline-rich-text document, so that I can write formatted notes without embedding a second block canvas.
32. As a Task editor, I want bold, italic, underline, strikethrough, inline code, foreground/background colors, hyperlinks, inline equations, Mentions, and Relations, so that common inline expression is preserved.
33. As a Task editor, I want unsupported pasted blocks flattened into supported inline content, so that paste cannot introduce unsupported document structure.
34. As a Task editor, I want whitespace and blank lines alone to count as Empty while a reference or equation alone counts as non-empty, so that Mandatory and deletion counts reflect meaningful content.
35. As a Task Collection member, I want Text search, filters, sorting, and grouping to use readable text while ignoring visual formatting, so that presentation does not change query meaning.
36. As a Task Collection member, I want Text filters for contains, does not contain, equals, does not equal, starts with, ends with, is empty, and is not empty, so that I can locate precise text states.
37. As a schema editor, I want Text duplication to confirm the operation but copy only definition configuration and never Task values, so that rich-text content is not bulk-copied accidentally.
38. As a Task editor, I want a Mention or Relation to target any Business Entity exposed by a registered microvertical in any tenant, so that references are not artificially limited to Ticketing.
39. As a Task editor, I want federated discovery controlled by each owning microvertical and support for a known Core deep link or opaque token, so that selection respects provider rules without accepting guessed raw IDs.
40. As a Task reader, I want a resolvable reference to remain clickable and be freshly authorized by its owning microvertical immediately before opening, so that selection never grants access and permission remains current.
41. As a Task reader, I want a deleted, unknown, or unresolvable reference to retain its stable identity and last label as searchable non-clickable text, so that content does not disappear and may recover if resolution returns.
42. As a Task reader, I want a renamed reference to refresh its active label without changing identity, so that content stays current and stable.

### Number

43. As a Task editor, I want Number to hold Empty or one exact decimal with up to 38 total and 18 fractional digits, so that calculations do not suffer floating-point drift.
44. As a Task editor, I want positive, negative, integer, and decimal values accepted while scientific notation, leading plus, NaN, infinity, and invalid paste are rejected atomically, so that stored numbers are deterministic.
45. As a Task editor, I want invalid input to retain the prior committed value, so that a failed paste cannot clear good data.
46. As a schema editor, I want Number, separators, and Percent display formats without changing the stored value, so that `25` can display as `25 %` while remaining the same exact number.
47. As a user, I want numeric input and display localized while storage and transport remain locale-independent canonical decimals, so that different locales share the same value.
48. As a Task Collection member, I want numeric comparisons to exclude Empty, ordinary mathematical sorting with Empty last, canonical-decimal substring search, and numeric-equality grouping, so that `0`, Empty, and negative values remain distinct.
49. As a schema editor, I want Number duplication to use the generic optional value snapshot, so that I can choose whether existing exact values are copied.

### Select

50. As a Task editor, I want Select to hold Empty or one stable option identity, so that renaming or recoloring an option does not rewrite semantic values.
51. As a schema editor, I want Select options to have trimmed non-empty case-insensitively unique, accent-sensitive names, stable identities, and presentation colors, so that the catalog is deterministic.
52. As an authorized schema editor working inline, I want creating an option and selecting it to be one atomic schema-and-value mutation, so that partial creation cannot leak.
53. As a User without schema permission, I want inline option creation rejected while existing options remain selectable, so that value permission does not grant schema permission.
54. As a schema editor, I want Manual, Alphabetical, and Reverse alphabetical option order, so that the catalog can be curated or localized.
55. As a viewer, I want automatic option order to use my configured user locale with stable identity tie-breaking, so that localized order is deterministic.
56. As a schema editor, I want switching to Manual to snapshot the order I currently see, so that the manual catalog has a concrete starting order.
57. As a schema editor, I want deleting an option to show the retained-Task impact and clear that option from affected Tasks only after confirmation, so that deletion is explicit.
58. As a Task Collection member, I want Select filters for is, is not, is empty, and is not empty, with Empty matching `is not <option>`, so that negative membership is complete.
59. As a Task Collection member, I want Select Task search, Task-row sorting, and grouping explicitly unavailable, so that the product does not imply undefined operations.
60. As a schema editor, I want a duplicated Select to receive new option identities, copied configuration, and an optional value remap, so that it is independent while preserving meaning when requested.

### Multi-select

61. As a Task editor, I want Multi-select to hold an unordered set of unique stable option identities, so that the same option cannot be selected twice.
62. As a Task reader, I want selected options displayed in catalog order, so that display remains stable independent of selection order.
63. As a schema editor, I want Multi-select option names to be trimmed, non-empty, case-insensitively unique, accent-sensitive, and reject commas, so that labels are unambiguous.
64. As a schema editor, I want new Multi-select options to retain the established automatic color assignment behavior and allow authorized editing through ColorSelect, so that existing product behavior is preserved without defining a new palette algorithm.
65. As a schema editor, I want deleting an option to count distinct retained Tasks and remove only that membership, so that all other selections survive.
66. As a Task Collection member, I want contains, does not contain, empty, and not-empty filters, with Empty included in negative membership, so that set queries are complete.
67. As a Task Collection member, I want search over selected option names and no sort or group operation, so that only defined capabilities are exposed.
68. As a schema editor, I want duplication to allocate new option identities, preserve option catalog order and colors, and optionally remap values, so that the duplicate remains independent.

### Status

69. As a Task editor, I want Status to hold Empty or one stable option identity, so that explicit clearing and historical values are representable.
70. As a schema editor, I want the fixed localized groups To-do, In progress, and Complete, with at least one option overall and exactly one Default, so that workflows share stable semantics.
71. As a Task Collection member, I want a new Status definition to start with Not started, In progress, and Done and default to Not started, so that it is immediately useful.
72. As a Task editor, I want existing Tasks to remain Empty when Status is added while newly created Tasks receive the current Default, so that schema activation does not fabricate historical state.
73. As a schema editor, I want changing Default to affect future Tasks only, so that existing and explicitly cleared Tasks are not rewritten.
74. As a schema editor, I want deleting a used non-default Status option to show impact and replace affected values with the current Default after confirmation, so that Tasks remain valid.
75. As a schema editor, I want to choose a different Default before deleting the current Default, so that replacement is always defined.
76. As a Task Collection member, I want Status search by option name and grouping by stable option identity, with no filter or sort operation, so that only settled query behavior is available.
77. As a schema editor, I want duplication to create new groups/options identities, map the Default, and optionally remap values, so that the duplicate is independent.

### Date and Date Range

78. As a Task editor, I want Date to hold Empty or one real calendar date without time or time zone, so that calendar intent cannot shift by location.
79. As a user, I want Date stored and transported as `YYYY-MM-DD` and displayed/input through the supported product locale mapping, so that storage remains locale-independent.
80. As a Task editor, I want Date picker navigation to avoid changing the value, adjacent-month dates to be selectable, and Today to use the client-local calendar date, so that navigation is safe and intuitive.
81. As a Task editor, I want invalid calendar input to retain the prior value, so that validation cannot silently clear a date.
82. As a Task Collection member, I want Date grouped by exact stored date with no search, filter, or sort operation, so that only defined behavior is exposed.
83. As a Task editor, I want Date Range to be Empty or contain complete Start and End dates where Start is strictly before End, so that partial, reversed, and same-day ranges are invalid.
84. As a Task editor, I want Date Range times to be either both present or both absent when time is enabled, so that ranges never contain a partial time pair.
85. As a schema editor, I want time support configured per Date Range definition, so that different range concepts can be date-only or date-and-time.
86. As a schema editor, I want enabling time to preserve existing dates with Empty times and disabling time to confirm the count of complete time pairs before removing only their times, so that dates survive format changes.
87. As a Task editor, I want Date Range to remain time-zone-free, so that entered local date/time components are preserved exactly.
88. As a schema editor, I want Date Range duplication to copy configuration and every existing value without a value-choice prompt, so that the confirmed datatype exception is enforced.
89. As a Task Collection member, I want Date Range grouped by its exact complete dates and optional times with no search, filter, or sort operation, so that only settled behavior is exposed.

### Person

90. As a Task editor, I want Person to hold an unordered set of stable tenant Principal identities with either one-person or no-limit cardinality, so that assignments remain identity-safe.
91. As a schema editor, I want new Person definitions to default to No limit, so that multiple assignment is available unless intentionally restricted.
92. As a Task editor, I want new selections limited to active human members and guests of the current tenant, so that groups, non-human actors, accountless records, cross-tenant people, and inactive people cannot be newly assigned.
93. As a Task reader, I want historical references to disabled, archived, departed, or otherwise ineligible people retained and resolvable, so that past assignments do not disappear.
94. As a Task editor, I want eligible-person search separated from stored-reference resolution and to expose visible name, email, and login fields, so that selection and historical display serve different needs.
95. As a Task editor, I want selecting another person in one-person mode to replace the prior assignment atomically and no-limit mode to prevent duplicates, so that cardinality is always valid.
96. As a schema editor, I want reducing No limit to one rejected with the violating Task count when any Task has multiple people, so that configuration never discards assignments automatically.
97. As a Task Collection member, I want exact membership/empty filters, display-name search, locale-sorted display-name-sequence sorting, and membership fan-out grouping, so that Person queries match its set nature.
98. As an assigned person, I want Person value changes to send no notification, so that this property does not imply notification behavior.

### Files & media

99. As a Task editor, I want Files & media to hold an ordered list of uploaded and external-link items with stable item identities, so that duplicate items and explicit ordering are preserved.
100. As a Task editor, I want each uploaded item to reference a Core Media Asset while an external item stores a validated exact URL, so that Ticketing does not own uploaded bytes.
101. As a Task editor, I want bulk file additions to report independent per-file success and commit only successful items, so that one bad file does not discard unrelated good files.
102. As a Task editor, I want staged or failed uploads excluded from the committed property value, so that query and deletion behavior sees only durable items.
103. As a Task editor, I want Core Media to reject positive content/extension/client-MIME mismatches but accept unknown or inconclusive content as generic when no mismatch exists, so that validation is authoritative without guessing.
104. As a Task editor, I want all uploaded assets download-only with no internal preview for any type, so that unsupported preview security is not implied.
105. As a Task editor, I want Core Media to expose and authoritatively enforce the deployment-wide upload limit, defaulting to 104857600 bytes when configuration is absent, so that every client follows one effective policy.
106. As an operator, I want invalid upload-limit configuration to fail explicitly rather than silently using another limit, so that deployment errors are visible.
107. As a Task editor, I want external links validated with the URL property contract without availability checks, so that acceptance does not depend on network reachability.
108. As a Task editor, I want item removal to require no extra item-level confirmation, so that ordinary list editing remains lightweight.
109. As a schema editor, I want duplication to allocate new item identities while allowing uploaded items to share Core Media Asset references, so that bytes are not duplicated unnecessarily and garbage collection respects all references.
110. As a Task Collection member, I want search over display filenames and external URLs, label membership/empty filters, stored-order lexicographic sequence sorting, and label fan-out grouping, so that queries reflect visible items.

### Checkbox, URL, Email, and Phone

111. As a Task editor, I want Checkbox to be exactly true or false and default to false for all existing and new Tasks, so that it is never Empty.
112. As a Task editor, I want Checkbox changes to have no automatic Task side effects, so that checking a box does only what the value says.
113. As a Task Collection member, I want checked and unchecked filters with no search, sort, or grouping, so that only defined boolean queries are exposed.
114. As a schema editor, I want Checkbox duplication to ask whether to copy values and initialize every no-copy result to false, so that the duplicate remains a total boolean.
115. As a schema editor, I want Checkbox deletion impact to count every retained Task, so that false is correctly treated as non-empty.
116. As a Task editor, I want URL to accept Empty or one trimmed absolute HTTP(S) URL of at most 8000 UTF-8 bytes with a non-empty host, so that stored links have a bounded practical profile.
117. As a Task editor, I want valid localhost, IPv4, bracketed IPv6, valid ports, and IDNs accepted without DNS or reachability checks, so that syntactically valid targets work offline.
118. As a Task editor, I want credentials, control characters, internal whitespace, multiple URLs, and invalid input rejected as a whole while preserving the prior value, so that unsafe or ambiguous links are not stored.
119. As a Task reader, I want URL open and copy to use the exact trimmed stored string with `noopener` and `noreferrer`, so that navigation is safe and storage is not parser-reserialized.
120. As a Task Collection member, I want URL text search/filters/sort/group behavior over the exact stored string, so that links follow shared text-like semantics.
121. As a Task editor, I want Email to accept Empty or one trimmed practical ASCII/punycode address no longer than 254 characters, so that validation is deterministic.
122. As a Task editor, I want Email local parts limited to a 1–64 character dot-atom and domains limited to valid 1–253 character multi-label host names, so that quoted forms, comments, literals, raw non-ASCII, consecutive dots, and multiple addresses are rejected.
123. As a Task reader, I want Email display to preserve entered case while queries use a lowercase projection, so that presentation is faithful and matching is consistent.
124. As a Task reader, I want activating Email to hand only the recipient to `mailto:`, so that the property does not invent a subject or body.
125. As a Task Collection member, I want Email equality/substring/negative/empty filters, case-insensitive search, normalized sort, and normalized equality grouping, so that Empty is included in negative predicates and sorted last.
126. As a Task editor, I want Phone to accept Empty or one exact non-whitespace single-line string up to 256 Unicode code points, so that international and human-formatted values are preserved without normalization.
127. As a Task editor, I want Phone to reject line breaks, tabs, NUL, and other control characters as a whole while retaining the prior value, so that stored handoff text is safe.
128. As a Task reader, I want Phone copy to preserve the exact value and call activation to use a safely encoded `tel:` handoff, so that unsupported device behavior does not become a Task error.
129. As a Task Collection member, I want Phone search, filters, sort, and grouping unavailable, so that arbitrary text is not given invented phone semantics.

### Intrinsic system properties

130. As a Task reader, I want Created time to expose the immutable absolute instant when the durable blank Task record was created, so that first Title/content entry cannot rewrite creation history.
131. As a Task creator, I want Created time initialized even when Title and content are Empty, so that creation is tied to durable Task existence.
132. As a Task reader, I want every Created time definition to project the same non-empty intrinsic fact and duplication to avoid a value-copy prompt, so that schema definitions cannot fork creation time.
133. As a viewer, I want Created time displayed in my locale and effective configured IANA time zone at minute precision, with seconds available in detail, so that the same absolute instant is understandable locally.
134. As a Task Collection member, I want Created time search and temporal filters interpreted in my locale and IANA zone, exact-second filters treated as half-open seconds, local dates/ranges converted to half-open instant ranges, chronological sorting, and local-day grouping, so that hidden milliseconds and daylight-saving boundaries behave correctly.
135. As a Task reader, I want Created by to expose exactly one immutable stable Principal identity for the actual Actor who created the Task, so that provenance is trustworthy.
136. As a Task creator, I want creation to fail when no valid Actor can be established, so that the system never guesses an administrator, random user, or unknown fallback.
137. As a Task reader, I want manual creation, duplication, import, automation, and system creation attributed to the Actor that actually creates the new Task, so that copied content never copies provenance.
138. As a Task reader, I want Created by to show the Principal's current display name and retain inactive identities, so that renames and deactivation do not erase provenance.
139. As a Task Collection member, I want Created by searchable by current display name, filterable by exact Principal, sortable by current display name, and grouped by stable identity, so that provenance can be queried safely.
140. As a Task reader, I want Last edited time initialized to creation and updated only by a successful actual Title, canvas, ordinary property-value, clear, archive, restore, user, automation, or system Task mutation, so that it represents real Task state change.
141. As a Task reader, I want no-op, failed, cancelled, replayed, comment, reaction, read, view, or schema operation to leave Last edited time unchanged, so that incidental activity is not reported as an edit.
142. As a Task reader, I want all Last edited time definitions to project the same live intrinsic fact and duplicate without a value-copy prompt, so that schema changes cannot fork edit time.
143. As a Task Collection member, I want Last edited time to use the same viewer-local display, temporal search/filter, chronological sort, and local-day grouping contract as Created time, so that system times behave consistently.
144. As a Task reader, I want Last edited by initialized to the creator and replaced by the Effective Editor of the latest successful relevant Task save, so that I can see who last changed Task state.
145. As a Task reader, I want a user-driven automation chain attributed to its originating Principal and an independent automation attributed to a named System Principal, so that execution mechanics do not obscure responsibility.
146. As a Task reader, I want concurrent edits ordered by successful commit order and one multi-field save to update attribution once, so that the latest committed editor wins deterministically.
147. As a Task reader, I want deactivated or removed editors retained by stable Principal identity, so that historical attribution does not disappear.
148. As a Task Collection member, I want Last edited by search, filter, sort, and grouping unavailable, so that no unsupported query behavior is implied.
149. As a schema editor, I want adding, removing, re-adding, or duplicating any intrinsic definition to preserve and re-project the underlying Task fact, so that schema visibility never destroys system metadata.
150. As a viewer, I want system-time presentation to use the configured Core Principal IANA zone, then a valid browser initialization/fallback, then UTC, so that there is always an explicit effective time zone.

### ID

151. As a Task Collection member, I want one immutable collection-scoped decimal ID number per retained Task while ID is active, so that Tasks have stable human-readable identifiers.
152. As a schema editor, I want activating ID to deterministically backfill every retained Task, including archived and soft-deleted Tasks, from 1 in Created time and durable creation-ordinal order, so that existing Tasks receive repeatable numbers.
153. As a Task creator, I want each new Task to receive the next number atomically and retries or rollbacks not to consume an extra business number, so that the sequence has no race-created duplicates or gaps.
154. As a Task editor, I want ID read-only and immutable, so that no role can manually change or clear an assignment.
155. As a Task duplicator, I want a duplicate Task to receive a fresh ID while the source retains its ID, so that two Tasks never share an assignment.
156. As a Task Collection member, I want deleting and restoring a Task to retain its assignment and never release its number, so that lifecycle changes do not recycle identity.
157. As a schema editor, I want an optional trimmed case-preserved prefix to change display without rewriting numeric assignments, so that presentation can evolve independently.
158. As a schema editor, I want ID definition duplication rejected before any value-copy prompt, so that the singleton invariant is explicit.
159. As a schema editor, I want deleting ID to confirm against every retained assignment and then permanently remove the definition, prefix, assignments, and sequence counter, so that deletion has its resolved hard-delete meaning.
160. As a schema editor, I want re-adding ID after deletion to backfill a fresh sequence from 1, even if displayed identifiers reuse numbers from the deleted namespace, so that deletion and reactivation are deterministic.
161. As a Task Collection member, I want ID grouping by exact assignment with no search, filter, or sort operation, so that only settled identifier behavior is exposed.
162. As a member of multiple Task Collections, I want each collection's schema and ID sequence independent, so that numbering and definitions never leak across collections.

## Implementation Decisions

### Domain ownership and boundaries

- Ticketing owns the Task, Task Collection, collection schema, property definition/configuration, option/item identity, ordinary value, intrinsic Task fact, Task revision, creation ordinal, and collection ID-sequence domain. Domain tables and migrations belong to Ticketing rather than Core infrastructure.
- One Task Collection owns exactly one non-reusable schema. A schema is never shared or moved between collections. Definitions are shared within that collection; ordinary values belong to Tasks.
- Keep the domain behind a deep Ticketing module. Public writes are registered typed CoreSDK actions; governed reads use the public Ticketing data-access/query contract. Transport and UI layers stay thin.
- `CreateTaskCollection` and `CreateTask` are separate standard CoreSDK Actions. The collection Action atomically creates a server-identified collection, its non-reusable schema, and the baseline Title definition. The Task Action accepts an existing `collectionId` and atomically creates a server-identified blank Task, revision 1, intrinsic provenance/last-edit facts, and required evidence. Each Action has its own retry identity; an unsuccessful Task Action leaves an already successful empty collection intact.
- The initial collection and blank-Task tranche performs neither a SpiceDB permission check nor a Ticketing Actor policy check. Shared CoreSDK operation-context validation establishes an active tenant Principal as the actual Actor before either Action. Later schema and Task-value Actions use their separately specified authorization checks; no Ticketing handler performs ad hoc authorization.
- Full access and Editor may mutate definitions/configuration/options. Full access, Editor, and User may mutate ordinary values. Viewer is read-only. Only Full access carries sharing authority. Intrinsic values reject all manual mutation regardless of role.

### Persistence, concurrency, and evidence

- Use stable identifiers for collections, Tasks, definitions, options, Files & media items, and Principals. Ordinary values use typed representations suitable for their validation and query behavior rather than an undifferentiated generic JSON value model.
- Represent generic Empty sparsely where practical. Checkbox is externally total boolean, Status distinguishes existing Empty from new-Task Default, derived properties project Task columns, and ID projects its assignment ledger.
- Use PostgreSQL exact types: `numeric(38,18)` for Number, `date` for Date, absolute millisecond-capable instants for system times, and `bigint` for ID numbers. Serialize Number and ID as decimal strings at transport boundaries.
- Every mutable definition, option, item list, and ordinary value carries an optimistic revision/version. Multi-select uses a value envelope even at zero selections so Empty retains monotonic revision and timestamp state. A command validates its expected version inside the write transaction. A stale ordinary-value write is rejected, leaves committed state unchanged, and returns enough typed conflict information for the UI to keep the draft and show a Toast. It never auto-merges, overwrites, or retries.
- A successful action commits business state, revisions, the automatic Core audit event, the Core domain event, and outbox messages atomically. Failed, rejected, cancelled, no-op, and rolled-back actions commit none of the business mutation evidence.
- Audit/domain evidence is retained indefinitely in the existing Core evidence stores. It records metadata such as tenant, collection, Task/definition subject identities, actor, operation, outcome, order, correlation/causation, and resulting revision where applicable. It never stores raw property values, drafts, rich text, reference labels, file names, URLs, email addresses, phone strings, or uploaded bytes.
- Evidence is internal metadata only. No Task Properties UI/API/export exposes it, and it carries no guarantee of prior-state reconstruction, replay, comparison, restore, rollback, undo, or time travel. Do not add datatype-specific history tables.
- Detect semantic no-ops before revision, audit/domain evidence, Last edited time, or Last edited by changes.

### Shared definition behavior

- Validate names by trimming, rejecting Empty, and enforcing schema-wide case-insensitive uniqueness. Do not add further character restrictions. Duplicate suffix selection is `Name Copy`, then the lowest available `Name Copy N`; ID never enters this flow.
- Every datatype supports Mandatory. Enabling it never backfills. On the next submitted edit form for an affected Task, reject while any Mandatory property is Empty. Checkbox and all intrinsic datatypes are inherently non-empty while their definition is active.
- Generic creation initializes Empty. Exceptions are Checkbox `false`, existing Status Empty/new Task Default, intrinsic projections, and ID activation backfill.
- Generic duplication creates a separately versioned definition, copies configuration and Mandatory, then asks whether to copy all existing values. Copy or no-copy is one transaction across all retained Tasks.
- Duplication exceptions are authoritative: Text confirms but copies configuration only and never values; Date Range always copies all values without asking; Checkbox asks and uses `false` for no-copy; Created time, Created by, Last edited time, and Last edited by copy configuration and project the same Task fact without asking; ID is rejected; Select/Multi-select/Status allocate new option identities and transactionally remap copied values.
- Generic definition deletion always requires confirmation, including zero impact. Compute count and effect over every retained Task, including archived and soft-deleted Tasks and ignoring permission/view filters; exclude hard-deleted Tasks. Count non-empty according to the datatype's own Empty rule. Confirmation carries the relevant revision; if the preview becomes stale, reject it and refresh the impact rather than applying obsolete effects.
- Intrinsic definition deletion removes only the projection definition and preserves the Task fact. ID is the explicit hard-delete exception: after confirmation it removes definition, prefix, assignments, and counter. Re-adding ID creates a fresh namespace and backfill from 1.
- Schema add, rename, configure, duplicate, and remove operations never update either last-edit fact, even when values are copied or deleted in bulk.

### Query semantics

- Search, filters, sort, and grouping are available by default only where the datatype has settled semantics. Explicit datatype exclusions override the default.
- Textual comparison uses exact stored display text for presentation plus a query projection using Task Collection locale, case-insensitivity, diacritic sensitivity, and Unicode canonical equivalence. Empty contributes no searchable text, matches negative predicates, and sorts last in both directions. Stable Task identity breaks unresolved ties. A case-insensitive grouping heading uses the spelling from the lowest stable Task identity.
- Number search uses canonical decimal substring matching, comparison filters use exact mathematical order and exclude Empty including from `!=`, sorting is numeric with Empty last, and grouping uses numeric equality plus Empty.
- Multi-select and Status search selected option names. Person and Created by search current Principal display names. Files & media searches display filenames and exact external URLs. URL searches the stored string.
- Person sorting compares each Task's locale-sorted sequence of current Principal display names. Files & media sorting compares visible label sequences in stored item order lexicographically. Created by sorting uses current display name. Empty sorts last and stable identities break ties.
- Scalar grouping uses readable/equality or stable identity for Text, Number, Status, URL, Email, Created by, and ID, with Empty where applicable. Date groups by exact date; Date Range by the exact complete range including optional times; system-time properties by viewer-local calendar day.
- Person grouping fans a Task into each assigned Principal group. Files & media grouping fans a Task into each visible label group using Task Collection locale comparison; duplicate equal labels place the Task in the group once. Empty is a separate group.
- Created time and Last edited time temporal search parse viewer-locale input in the effective IANA zone. Date-only input covers the entire local day; date-time input matches supplied precision. Exact-second filters are half-open seconds; local day/custom ranges convert to half-open absolute ranges. Absolute chronological order never depends on display zone.

### Datatype models and validation

- Text is a 0..1 multiline inline-rich-text document restricted to the supported inline marks/nodes. Flatten unsupported pasted blocks. Its readable projection includes active and fallback reference labels and equation text as defined by the editor contract; visual formatting does not participate in queries. Whitespace/blank lines alone are Empty, while a reference/equation alone is not.
- Text Mention/Relation nodes store an opaque Core Reference identity plus last resolved label. Core federates discovery across registered microverticals/tenants; providers control discoverability. A known deep link or opaque token may select a non-discoverable known entity, but a guessed raw ID cannot. The provider authorizes immediately before open. Resolvable references remain clickable even after permission loss; denial blocks navigation without mutating the node. Deleted/unknown/unresolvable targets render their retained label as searchable plain text and may reactivate after recovery.
- Number stores one exact bounded decimal independently of format. Locale affects parse/display only. Reject scientific notation, leading plus, NaN, infinity, overflow/scale excess, and an invalid paste as a whole. Formats are Number, separators, and Percent, with stored `25` displayed as `25 %` in Percent mode.
- Select, Multi-select, and Status values reference stable option identities. Option rename, color, or order changes never rewrite Task values. Option deletions use retained-Task impact counts and transactional value changes.
- Select has Manual, Alphabetical, and Reverse order. Automatic modes use each viewer's configured user locale plus stable identity tie-breaking; switching to Manual snapshots the acting user's displayed order. Inline option create is an authorized schema mutation combined atomically with selection. Deleting a selected option clears affected Select values. A duplicated Select definition is placed immediately after its source.
- Multi-select stores a set and displays catalog order. Names additionally reject commas. Deleting an option removes only that membership. Existing automatic color assignment behavior is preserved but its palette/algorithm is not defined here.
- Status owns the fixed stable groups To-do, In progress, and Complete. Group labels are localized and option order is group-local. It always has at least one option and exactly one Default. Initial options are Not started, In progress, and Done; Default is Not started. Existing Tasks are Empty when activated, new Tasks get current Default, and changing Default is prospective. Deleting a used non-default replaces affected values with current Default; deleting current Default first requires choosing another.
- Date stores an optional real calendar date as PostgreSQL `date` and `YYYY-MM-DD`; it has no time or zone. The current explicit product locale mappings are `cs-CZ` and `en-GB`. An Empty picker opens the current month without assigning Today; a populated picker opens the stored date's month. Month navigation is non-mutating, Today uses client-local date, and invalid input preserves the prior value.
- Date Range is Empty or a complete pair with Start strictly before End and never the same date. Time support is per definition; when enabled, times are both present or both absent. The datatype is timezone-free. Enabling time preserves dates and creates Empty time slots. Disabling it confirms the count of values with complete time pairs, removes only those times, and preserves dates. Partial/reversed/same-day drafts remain invalid and uncommitted.
- Person stores 0..1 or 0..n unique tenant Principal IDs and defaults to No limit. New choices are active human members/guests in the current tenant only. Core Person Directory separates eligible search from resolution of retained inactive/historical identities and supplies visible name/email/login. Reducing cardinality is rejected with a violating-Task count instead of dropping assignments. Changes do not emit product notifications.
- Files & media stores ordered Ticketing item identities. Uploaded items reference Core Media Assets; external items retain an exact validated URL. Duplicate labels/items are allowed. Reorder is explicit. Removing an item needs no item-level confirmation. Duplication creates new item IDs; shared asset references are allowed and asset garbage collection cannot delete while any item references the asset.
- Core Media performs per-file content detection and size enforcement. Reject a positive detected-type conflict with a meaningful extension or client MIME; accept unknown/inconclusive content generically when no conflict exists. No asset has an internal preview. Core exposes the effective read-only limit from `CORE_MEDIA_MAX_UPLOAD_BYTES`; absence means 104857600 bytes and invalid configuration fails explicitly. Clients may reject earlier but cannot override Core. A failed/oversized/mismatched file creates neither asset nor property item; bulk results remain independent.
- Checkbox is exactly boolean and initializes `false`; both values are non-empty and it has no automatic Task behavior.
- URL trims outer whitespace, enforces at most 8000 UTF-8 bytes, parses one absolute WHATWG-compatible HTTP(S) URL with a non-empty host, rejects credentials/control/internal whitespace/multiple URLs, and preserves exact trimmed input instead of parser serialization. It accepts valid localhost, IPv4, bracketed IPv6, ports, and IDNs without DNS/reachability checks. Open uses the exact stored URL with `noopener`/`noreferrer`; copy is exact.
- Email trims outer whitespace and validates one practical ASCII/punycode address up to 254 characters. Local part is a 1–64 character supported dot-atom without leading/trailing/consecutive dots. Domain is 1–253 characters, has at least two 1–63 character labels, and permits letters/digits/interior hyphens/punycode. Reject quotes, comments, literals, raw non-ASCII, control/space, and multiple addresses. Preserve entered case; query through lowercase projection. Activation creates recipient-only `mailto:`.
- Phone treats Unicode-whitespace-only as Empty; otherwise preserves the exact entire string including outer whitespace. Enforce one line and at most 256 Unicode code points; reject CR/LF, Unicode line separators, tabs, NUL, and control characters atomically. Do not validate or normalize phone meaning. Copy is exact and activation uses a safely encoded `tel:` handoff; lack of device support is not a Task error.

### Intrinsic facts, identity, and time

- Store Created time, Created by, Last edited time, and Last edited by as non-null intrinsic Task facts independent of visible definitions. Definitions are projections and own no separate value rows. Multiple/duplicated definitions project the same fact.
- Durable blank Task creation accepts an existing collection identity and atomically assigns server Task identity, Created time, valid Actor, Last edited time equal to Created time, and Last edited by equal to the creator. Collection and Task creation are independently idempotent; idempotency keys identify retries and never become aggregate identities. Title/content are not prerequisites.
- Created by comes only from trusted operation context and cannot be caller-supplied. Manual/import/automation/system/duplication paths use the Actor actually creating the Task. If no valid Actor exists, creation fails with no fallback. Stable Principal identity is retained; reads use current display name and inactive status.
- A successful actual Task mutation to Title, canvas, an editable property value/clear, archive, or restore atomically advances Last edited time and sets Last edited by. The last committed save wins; one multi-field save updates once. A later reversal is still a new edit, while a semantic no-op is not.
- User-driven automation carries the originating Principal across the full chain. Independent automation with no user origin uses its actual named System Principal. The Core Principal attribution contract provides Actor, Originating Principal, and named System semantics; never infer attribution from mutable labels.
- Comments, reactions, reads/views, unsaved/cancelled/failed changes, idempotent replays, personal view changes, and all schema operations bypass last-edit updates. Archive and restore are explicit Task mutations and update both facts.
- Core Principal Preferences owns the configured IANA time zone. Effective order is configured valid user zone, valid browser initialization/fallback, then UTC. APIs transport absolute millisecond instants; presentation applies locale/zone and DST. Standard time display is minute precision and detail display exposes seconds.

### ID sequencing and deletion

- ID is a collection-scoped immutable numeric assignment stored as PostgreSQL `bigint` and serialized as a decimal string. Display is `PREFIX-number` when a trimmed case-preserved prefix exists and the bare number otherwise; prefix changes configuration only.
- Maintain an immutable assignment ledger and a transactionally updated counter row per active ID namespace. Do not expose allocation publicly. A rolled-back creation must not consume a number.
- Persist a durable Task creation ordinal. Activation serializes against Task creation at collection scope and backfills every retained Task by `(created_at, creation_ordinal)` from 1. Then new Tasks atomically receive the next number.
- Enforce database invariants for at most one active ID definition per collection, one assignment per Task, and unique number per collection namespace. Task delete/restore retains assignment; Task duplication allocates fresh. Numbers are not reused while the namespace exists.
- ID deletion is destructive only after the unconditional confirmation and retained-assignment count. It removes the definition, prefix, all assignments, and counter. A later add creates a new namespace and deterministically backfills from 1; reuse relative to the deleted namespace is allowed.

### Shared Core contracts and UI dependencies

- Core Reference owns opaque cross-microvertical/tenant reference discovery, resolution, lifecycle, deep links, and authorize-on-open behavior.
- Core Principal/Person Directory owns stable Principal identity, eligible-person discovery, historical resolution, Actor/Originating Principal/System attribution, and current display projection.
- Core Principal Preferences owns configured IANA time zones and fallback behavior.
- Core Media owns uploaded bytes, effective upload policy, per-file size/type validation, authorization, download-only access, and reference-aware asset lifetime.
- Existing Core audit and domain event stores own indefinite metadata evidence and transactional correlation/causation.
- Select, Multi-select, and Status option color editing uses `ColorSelect` from `@techsio/ui-kit/molecules/color-select`, with application-provided available colors/current selection and `onColorClick`. This is engineering-only C-019/DEC-098 scope: it defines no palette, serialization, uniqueness, random/deterministic assignment, automatic selection, or product workflow.

## Testing Decisions

- A good test asserts behavior visible through a public contract: accepted/rejected commands, durable reads, revisions, query results, role decisions, transactional rollback, evidence metadata, and UI-observable conflict/presentation behavior. Tests must not lock in table layouts, helper calls, editor internals, query-builder structure, or component implementation details.
- The primary seam is the authenticated typed Ticketing command/action boundary through CoreSDK backed by real PostgreSQL, followed by reads through the public Ticketing data-access/query contract. This one seam covers Task creation, schema/value authorization, all datatype mutations, duplication, deletion impact, optimistic conflicts, intrinsic facts, ID allocation/backfill/concurrency, query semantics, audit/domain evidence, outbox atomicity, rollback, and idempotency.
- Use independently controlled transactions and a controllable clock at the same public seam for concurrency, successful-save ordering, millisecond system times, deterministic ID backfill, rollback-without-number-consumption, and stale-write behavior.
- Contract-test Core Reference, Core Principal/Person Directory and attribution, Core Principal Preferences, Core Media, evidence logging, and ColorSelect integration at their published boundaries. Ticketing tests use faithful contract adapters and do not duplicate Core internals.
- Add presentation interaction tests only where the command/query seam cannot prove behavior: rich-text paste flattening and reference fallback/open authorization; localized Number/Date/Email editors; Date picker non-mutation and client-local Today; Date Range draft errors and time-disable confirmation; Toast plus unsaved-draft preservation; option ordering and ColorSelect wiring; exact copy/open/`mailto:`/`tel:` handoffs; system-time locale/IANA/DST/minute/detail rendering; and Files & media per-file progress/results.
- Add focused domain-level property tests only for high-combination pure invariants such as exact decimal parsing, URL/Email/Phone grammar boundaries, Date Range completeness/order, option remapping, and query projection/collation. These supplement rather than replace the public seam.
- Run role matrices for Full access, Editor, User, and Viewer across schema and value operations, including inline option creation, intrinsic forged writes, and dynamic collection resource targeting.
- Run lifecycle matrices against active, archived, soft-deleted, and hard-deleted Tasks to prove counts/effects, option replacement/removal, ID retention, and exclusion of hard-deleted records.
- Run generic datatype contract suites for naming, Mandatory, Empty, duplicate suffixes, duplication choice, unconditional deletion confirmation, audit/domain metadata, stale writes, and default query behavior; then apply explicit datatype exceptions rather than copying tests manually.
- Prior art is the existing CoreSDK action integration tests, policy/authorization tests, and data-access tests. Extend those established transaction and public-contract patterns when the Ticketing domain replaces its current scaffold.

## Out of Scope

- Implementing complete Task change history, value snapshots, audit-log UI/API/export, version comparison, replay, undo, rollback, restore-to-version, reconstruction, or time travel.
- Storing raw Task Property Values or sensitive display data in audit/domain evidence.
- Sharing one Task schema or ID sequence between Task Collections, reusing schema objects, or moving a schema between collections.
- New access levels, sharing rules, suggestion/comment behavior, notification behavior, or authorization grants beyond the recorded property rules.
- Comment/reaction history, comment authorship, or treating comments, reactions, reads, views, and personal view changes as Task edits.
- General Task ownership, assignee, priority, templates, automation design, import mapping, or workflow behavior beyond what is necessary to attribute creation/editing and persist properties.
- Migrating external historical Created time/Created by facts when no trustworthy provenance exists.
- Rich-text block-canvas features or preserving unsupported pasted block structure.
- Select Task search/sort/group; Multi-select sort/group; Status filters/sort; Date search/filter/sort; Date Range search/filter/sort; Checkbox search/sort/group; Phone search/filter/sort/group; Last edited by search/filter/sort/group; ID search/filter/sort.
- Person change notifications or assignment-driven side effects; Checkbox side effects; Status or property-driven automations.
- DNS, reachability, deliverability, mailbox existence, telephone-number validity/normalization, or link availability checks.
- Internal file preview, conversion, media viewer, preview URLs, malware policy beyond the recorded Core Media contract, or a per-property/per-tenant upload-limit business rule.
- A new option-color palette, color serialization, uniqueness constraint, random/deterministic assignment algorithm, automatic selection rule, or product creation flow. C-019 is engineering-only and uses ColorSelect.
- Product behavior for unsupported devices/apps after `mailto:` or `tel:` handoff.
- Automatic deletion of abandoned blank Tasks or physical deletion/garbage-collection policy beyond retained-Task and referenced-media requirements.

## Further Notes

- This specification uses the durable Task Properties domain vocabulary: Task Collection, Task, Property Definition, Property Configuration, Task Property Value, Option, Actor, Principal, Originating Principal, Effective Editor, intrinsic Task fact, retained Task, and Empty.
- The effective source set is the product-resolution ledger, archived product-owner specifications, durable datatype briefs, contracts, product-owner handoffs, consistency report, decision ledger, capability matrix, and current app context. Source checksums pass and the consistency report declares the corpus ready for specification.
- Decision coverage is complete for DEC-001 through DEC-104 after applying their recorded refinements. DEC-098 is the effective cross-datatype ColorSelect decision; DEC-085 remains historical C-019 provenance only. The locale portion of DEC-014 is superseded by DEC-096. The removal portion of DEC-077 is superseded by DEC-087. PR-020 refines PR-015 for permission loss, and PR-024 refines PR-016 for Core Media type/preview enforcement. Earlier superseded resolution entries are intentionally excluded.
- There are no open product conflicts in this scope. Engineering must not fill perceived gaps with new business behavior; an implementation uncertainty that changes externally observable behavior requires a separate product decision.
- The current Ticketing vertical is scaffold code with placeholder in-memory reads and a non-persisting create action. The specification therefore requires foundational Task/collection/property persistence and public contracts, not a field-level patch.
- The `ready-for-agent` issue represents the complete behavior contract. Delivery should later be split into independently demonstrable tracer-bullet tickets rather than horizontal database/API/UI batches.
