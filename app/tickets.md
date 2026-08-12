# Tickets: CRM MicroVertical

These 21 local implementation tickets build the CRM described by
[`specs/feature-crm-microvertical.md`](specs/feature-crm-microvertical.md). The feature specification
is the product and architecture source of truth; this file is the executable implementation map.

No ticket creates a GitHub issue. Work the **frontier**: a ticket may start when every ticket in its
**Blocked by** section is complete. Backend tickets own the complete path from persistence through
the callable BFF contract and backend tests. UI tickets consume those completed typed contracts.

## Rules shared by every ticket

- Every mutation is one dedicated typed Action. Editing never changes lifecycle status, primary
  Contact designation, or deletion state.
- Codesmith generates Action contracts and deterministic transport/registration wiring, but never
  private business handlers. Handlers are owner-local, manually authored Effect programs.
- Deletes are soft deletes. There is no restore flow and no cascading deletion of CRM history.
- Customer and Contact are tenant-wide. Deal, Offer, and Activity belong to the selected Legal
  Entity and receive that scope only from trusted server context.
- Search, search providers, external communication, file uploads, and document generation are out
  of scope.
- Each backend ticket includes unit, PostgreSQL/RLS, Action, BFF, authorization, idempotency,
  concurrency, rollback, and boundary tests appropriate to its behavior.
- Each UI ticket includes typed loading, empty, validation, forbidden, not-found, conflict,
  unavailable/retry, and success states as applicable, plus English/Czech copy, accessibility,
  responsive behavior, and component/route tests.

## Parallelization map

Use these execution waves when multiple workers are available. Tickets inside one wave may run in
parallel after the preceding blockers are merged. Logical parallelism assumes isolated worktrees or
branches; do not run generators, migrations, or package/topology edits concurrently in one working
tree.

| Wave | Tickets that can run in parallel                                                                                 | Maximum parallel work |
| ---- | ---------------------------------------------------------------------------------------------------------------- | --------------------: |
| 1    | 1. Codesmith Action boundary; 2. CRM foundation                                                                  |                     2 |
| 2    | 3. Customer backend                                                                                              |                     1 |
| 3    | 4. Customer UI; 5. Contact backend                                                                               |                     2 |
| 4    | 6. Contact UI; 7. Primary Contact backend; 9. Deal backend                                                       |                     3 |
| 5    | 8. Primary Contact UI; 10. Deal UI; 11. Deal lifecycle backend; 13. Offer revision backend; 17. Activity backend |                     5 |
| 6    | 12. Deal lifecycle UI; 14. Offer revision UI; 15. Offer lifecycle backend                                        |                     3 |
| 7    | 16. Offer lifecycle UI; 18. Customer timeline backend                                                            |                     2 |
| 8    | 19. Activity and timeline UI; 20. Authorization and resource hardening                                           |                     2 |
| 9    | 21. Complete acceptance and deployment verification                                                              |                     1 |

The peak useful concurrency is five workers in Wave 5. Three or four workers is the recommended
operating level because the CRM vertical, generated manifests, migrations, and shared test fixtures
are likely merge-conflict hotspots. Merge backend contracts before starting their UI consumers.

## 1. Correct the Codesmith Action boundary

**What to build:** Make generated Actions callable through typed, Action-specific Effect transport
and owner-local registration without generating their private business handlers. The Action
generator owns deterministic contracts and wiring; developers own business behavior.

**Blocked by:** None — can start immediately.

- [ ] Generated Action output contains payload/result/error declarations, the Action descriptor,
      Action-specific client/server transport wiring, and an owner-private handler binding point.
- [ ] Generated output contains no `NotImplemented` handler, placeholder handler, or business
      implementation function.
- [ ] A manually authored private Effect handler can bind to the generated descriptor without
      exposing the handler through the public manifest or browser bundle.
- [ ] Generator help, stable rerun, safe composition, traversal, cross-owner, no-partial-write,
      formatting, and generated-compilation tests pass.

## 2. Create the CRM MicroVertical foundation

**What to build:** Establish the independently deployable `crm` application and its `crm.core`
business module, owner-local database boundary, Shell identity boundary, empty generated entry
pages, resource/timeline contribution seam, and English/Czech localization foundation. Do not add
CRM entities yet.

**Blocked by:** None — can start immediately.

- [ ] The generated deployment is independently buildable and publishes a valid immutable
      `crm.core` module contract while keeping `appId = crm` distinct from `moduleId = crm.core`.
- [ ] CRM has its own PostgreSQL schema, Drizzle migration journal, application connection,
      migration/grant orchestration, and exact schema verification boundary.
- [ ] The Action identity boundary and required resource-detail/timeline provider scaffolding are
      available before business implementations use them.
- [ ] Shell allowlisting, topology, ownership, generated pages, module discovery, translations, and
      deployment boundary tests pass without importing another deployment's private code.

## 3. Implement the Customer backend

**What to build:** Make tenant-wide company Customers persistable and callable through complete
create, edit, delete, list, detail, and resource-detail backend behavior.

**Blocked by:** 1. Correct the Codesmith Action boundary; 2. Create the CRM MicroVertical foundation.

- [ ] Customer stores the agreed company fields with canonical English names, normalized optional
      values, optimistic versioning, timestamps, and a soft-delete tombstone.
- [ ] Active company registration numbers are unique within one tenant when present; Customer name,
      email, phone, and tax identification number may repeat.
- [ ] Dedicated generated Create, Edit, and Delete Actions are bound to manually authored handlers;
      edit cannot delete, and all writes are idempotent, audited, and concurrency-safe.
- [ ] Paginated list, direct detail, and resource-detail BFF operations exclude deleted Customers
      from ordinary reads and enforce module access in the selected Legal Entity context.
- [ ] Forced tenant RLS, normalization, validation, duplicate, conflict, deletion, permission,
      rollback, and cross-tenant tests pass.

## 4. Implement the Customer UI

**What to build:** Let an authorized CRM user list Customers, open Customer details, and create,
edit, or soft-delete a Customer from the generated Customers page.

**Blocked by:** 3. Implement the Customer backend.

- [ ] The Customers page presents a paginated semantic list and direct detail workspace without a
      search input or search provider.
- [ ] Create and edit forms cover every agreed Customer field with correct structured address,
      registration-number, tax-number, email, phone, website, and validation behavior.
- [ ] Deletion requires explicit confirmation and cannot be performed through the edit form.
- [ ] Typed Action outcomes, stale-version conflicts, unavailable/retry behavior, URL-backed
      selected record/page state, translations, accessibility, responsive layout, and UI tests pass.

## 5. Implement the Contact backend

**What to build:** Make tenant-wide Contacts belonging to exactly one Customer persistable and
callable through complete create, edit, delete, list, detail, and resource-detail behavior.

**Blocked by:** 3. Implement the Customer backend.

- [ ] Contact stores names, email, phone, job title, Customer ownership, version, timestamps, and a
      soft-delete tombstone; at least one trimmed name part is required.
- [ ] Dedicated generated Create, Edit, and Delete Actions use manually authored handlers, reject
      missing/deleted/cross-tenant Customers, and cannot change primary designation.
- [ ] Paginated Customer Contact lists, direct Contact detail, and resource-detail BFF operations
      exclude deleted rows and retain safe historical labels.
- [ ] Tenant RLS, Customer ownership, validation, concurrency, idempotency, authorization, rollback,
      deletion, and cross-tenant tests pass.

## 6. Implement the Contact UI

**What to build:** Let users maintain a Customer's Contacts inside the Customer workspace and open
direct Contact details.

**Blocked by:** 4. Implement the Customer UI; 5. Implement the Contact backend.

- [ ] Customer details show a paginated semantic Contact list and clear empty state.
- [ ] Users can create and edit Contact names, email, phone, and job title without changing primary
      designation.
- [ ] Contact deletion requires explicit confirmation and preserves the surrounding Customer view.
- [ ] Typed errors, concurrency conflicts, unavailable/retry behavior, translations, focus handling,
      narrow layouts, long names, and component/route tests pass.

## 7. Implement the primary Contact backend

**What to build:** Make setting, replacing, or clearing a Customer's primary Contact one atomic,
dedicated business operation.

**Blocked by:** 5. Implement the Contact backend.

- [ ] `ChangeCustomerPrimaryContact` is the only operation that can mutate primary designation and
      is bound to a manually authored Effect handler.
- [ ] The Action atomically clears the previous primary Contact and sets the selected active Contact,
      or explicitly clears the designation.
- [ ] The Action verifies Customer ownership and expected versions, emits its declared business
      event, and cannot select a deleted or foreign Contact.
- [ ] Competing primary changes, replay, stale versions, permission denial, rollback, and database
      uniqueness tests pass.

## 8. Implement the primary Contact UI

**What to build:** Let users see, set, replace, and clear the primary Contact through explicit
controls separate from ordinary Contact editing.

**Blocked by:** 6. Implement the Contact UI; 7. Implement the primary Contact backend.

- [ ] Customer and Contact views identify the current primary Contact without presenting the field
      in the ordinary Contact edit form.
- [ ] Explicit controls support setting, replacing, and clearing the designation with appropriate
      confirmation and pending states.
- [ ] Concurrent-change conflicts refresh or preserve user input safely and never present a false
      success state.
- [ ] English/Czech copy, keyboard/focus behavior, typed outcomes, and UI tests pass.

## 9. Implement the Deal backend

**What to build:** Make Legal-Entity-owned Deals persistable and callable through complete create,
edit, delete, list, detail, and resource-detail behavior. Lifecycle changes remain separate.

**Blocked by:** 3. Implement the Customer backend; 5. Implement the Contact backend.

- [ ] Deal stores Customer, optional Customer Contact, title, description, expected value, currency,
      expected close date, fixed status, version, timestamps, and soft-delete tombstone.
- [ ] New Deals always begin in `New`; ordinary Edit and Delete Actions cannot change status.
- [ ] Create and Edit validate that an optional Contact belongs to the Deal's active Customer and
      derive tenant/Legal Entity only from trusted context.
- [ ] Paginated Deal list, Customer filter, direct detail, and resource-detail operations enforce
      selected-Legal-Entity isolation and exclude deleted Deals.
- [ ] Money/currency, cross-Customer Contact, RLS, concurrency, idempotency, authorization, rollback,
      deleted-parent, and cross-Legal-Entity tests pass.

## 10. Implement the Deal UI

**What to build:** Let users list, filter by Customer, view, create, edit, and soft-delete Deals in
the selected Legal Entity without changing Deal status through ordinary forms.

**Blocked by:** 9. Implement the Deal backend.

- [ ] The Deals page presents a paginated semantic list, Customer filter, status Badge, and direct
      Deal details without any search capability.
- [ ] Create and edit flows handle Customer, eligible optional Contact, description, expected value,
      currency, and expected close date while excluding status.
- [ ] Deletion requires explicit confirmation and leaves historical children intact.
- [ ] Typed validation/conflict/permission/unavailable outcomes, URL state, translations,
      accessibility, responsive behavior, and UI tests pass.

## 11. Implement the Deal lifecycle backend

**What to build:** Make Deal status changes a dedicated audited Action supporting every agreed
transition, including reopening completed Deals.

**Blocked by:** 9. Implement the Deal backend.

- [ ] `ChangeDealStatus` is the only status mutation and supports New, Qualified, Offer sent,
      Negotiation, Won, and Lost.
- [ ] Any status can transition to any other status, including Won/Lost reopening, while no-op,
      stale, deleted, or cross-scope requests return declared outcomes.
- [ ] Successful changes publish safe previous/new status Domain Events for the Customer timeline.
- [ ] Every status pair, idempotent replay, concurrency, authorization, RLS, audit/event/evidence
      atomicity, and rollback tests pass.

## 12. Implement the Deal lifecycle UI

**What to build:** Let users understand and explicitly change Deal status, including reopening a Won
or Lost Deal.

**Blocked by:** 10. Implement the Deal UI; 11. Implement the Deal lifecycle backend.

- [ ] Deal list/detail views display localized status Badges and expose only the dedicated status
      interaction for changing state.
- [ ] The transition control permits all agreed target statuses and clearly supports reopening.
- [ ] Pending, success, stale-version conflict, permission, unavailable/retry, and refreshed-state
      behavior use the typed Action client.
- [ ] Keyboard behavior, translations, responsive presentation, and lifecycle UI tests pass.

## 13. Implement the Offer revision backend

**What to build:** Make versioned commercial Offers under a Deal persistable and callable through
complete create, Draft edit, delete, list, and detail behavior. Lifecycle changes remain separate.

**Blocked by:** 9. Implement the Deal backend.

- [ ] Offer stores immutable positive revision number, title, description, amount, currency,
      validity date, fixed status, version, timestamps, and soft-delete tombstone in Deal scope.
- [ ] Create allocates the next revision atomically and always begins in Draft; only active Drafts
      are editable, and edit cannot change status or revision number.
- [ ] Dedicated Create, Edit, and Delete Actions reject deleted/cross-scope Deals and never mutate
      Deal status, another Offer, or Activity implicitly.
- [ ] Offer revision list/detail operations use deterministic revision ordering and selected-Legal-
      Entity isolation while preserving safe historical labels.
- [ ] Revision races, Draft editing, money/currency, idempotency, concurrency, authorization, RLS,
      rollback, deletion, and parent-state tests pass.

## 14. Implement the Offer revision UI

**What to build:** Let users inspect Deal Offer revisions and create, edit, or soft-delete Draft
Offers without exposing lifecycle changes in ordinary forms.

**Blocked by:** 10. Implement the Deal UI; 13. Implement the Offer revision backend.

- [ ] Deal details present Offer revisions in deterministic order with revision and status labels.
- [ ] Create/edit flows cover title, description, amount, currency, and validity date; revision and
      status are never editable fields.
- [ ] Only Draft Offers expose editing, deletion requires explicit confirmation, and terminal/non-
      Draft records remain readable.
- [ ] Typed outcomes, localized monetary input, translations, accessibility, responsive behavior,
      and UI tests pass.

## 15. Implement the Offer lifecycle backend

**What to build:** Make sending, accepting, rejecting, withdrawing, and superseding an Offer
dedicated, strictly validated lifecycle operations through one status Action.

**Blocked by:** 13. Implement the Offer revision backend.

- [ ] `ChangeOfferStatus` is the only Offer status mutation and permits exactly Draft to Sent or
      Withdrawn, and Sent to Accepted, Rejected, Withdrawn, or Superseded.
- [ ] Accepted, Rejected, Withdrawn, and Superseded are terminal; superseding requires a higher
      active revision; at most one active Offer per Deal may be Accepted.
- [ ] The Action does not implicitly change the Deal, another Offer, or create an Activity, and it
      publishes safe lifecycle Domain Events.
- [ ] Every allowed/forbidden transition, concurrent acceptance, higher-revision requirement,
      idempotency, stale/deleted state, authorization, atomicity, and rollback test passes.

## 16. Implement the Offer lifecycle UI

**What to build:** Let users perform only valid Offer lifecycle transitions and understand Draft,
Sent, and terminal states.

**Blocked by:** 14. Implement the Offer revision UI; 15. Implement the Offer lifecycle backend.

- [ ] Offer revisions display localized status Badges and only valid next-state controls.
- [ ] Accepted, Rejected, Withdrawn, and Superseded Offers expose no further transition controls;
      Supersede clearly requires a higher revision.
- [ ] Pending, confirmation, success, concurrent acceptance/conflict, permission, and unavailable
      outcomes consume the typed Action client and refresh state correctly.
- [ ] Translations, keyboard/focus behavior, responsive presentation, and lifecycle UI tests pass.

## 17. Implement the Activity backend

**What to build:** Make historical Note, Call, Email, Meeting, and Other Activity records callable
through complete create, edit, delete, and read behavior without performing external communication.

**Blocked by:** 5. Implement the Contact backend; 9. Implement the Deal backend.

- [ ] Activity stores Customer, selected Legal Entity, fixed type, subject, optional details,
      occurrence time, optional Contact/Deal, version, timestamps, and soft-delete tombstone.
- [ ] Dedicated Create, Edit, and Delete Actions validate that optional Contact and Deal references
      belong to the same Customer and Legal Entity.
- [ ] Activity behavior only records interactions; it does not send email, place calls, schedule
      meetings, mutate Deals/Offers, or create another implicit record.
- [ ] Activity read operations support the timeline backend while ordinary results exclude deleted
      records and historical views preserve safe labels.
- [ ] Every type, optional-link combination, occurrence time, cross-scope reference, RLS,
      concurrency, idempotency, authorization, deletion, atomicity, and rollback test passes.

## 18. Implement the Customer timeline backend

**What to build:** Provide one deterministic, paginated relationship history that combines active
Activities with meaningful Deal and Offer lifecycle events for the selected Legal Entity.

**Blocked by:** 11. Implement the Deal lifecycle backend; 15. Implement the Offer lifecycle backend; 17. Implement the Activity backend.

- [ ] Timeline entries merge Activities, Deal status events, and agreed Offer creation/status events
      using occurrence/event time plus stable ID ordering.
- [ ] Routine field edits and Core audit rows do not appear as relationship-history entries.
- [ ] The timeline filters commercial history by selected Legal Entity while resolving the shared
      tenant-wide Customer and safe labels for deleted linked records.
- [ ] The BFF and resource timeline provider expose bounded cursor pagination and declared typed
      authentication, authorization, not-found, and unavailable outcomes.
- [ ] Empty, mixed-source, ordering ties, pagination boundaries, deletion, cross-Legal-Entity,
      provider failure, permission, and contract tests pass.

## 19. Implement the Activity and timeline UI

**What to build:** Let users record and maintain historical interactions and read the mixed Customer
relationship timeline from the Customer workspace.

**Blocked by:** 4. Implement the Customer UI; 17. Implement the Activity backend; 18. Implement the Customer timeline backend.

- [ ] Customer details show a paginated chronological timeline with distinguishable Activity, Deal,
      and Offer lifecycle entries and a clear empty state.
- [ ] Users can create, edit, and soft-delete Activities with fixed type, subject, details,
      occurrence time, optional Contact, and optional Deal.
- [ ] The UI explains that Activities record completed interactions and does not imply that OntOS
      sends messages, places calls, or schedules meetings.
- [ ] Deleted/historical labels, pagination, typed errors, stale conflicts, pending/success feedback,
      translations, accessibility, responsive behavior, and UI tests pass.

## 20. Harden CRM authorization and resource access

**What to build:** Prove that v1 CRM access is module-wide in the selected Legal Entity, tenant-wide
Customer/Contact identity is shared safely, commercial data is isolated, and future explicit
per-resource restriction can be introduced without changing CRM identifiers.

**Blocked by:** 3. Customer backend; 5. Contact backend; 7. Primary Contact backend; 9. Deal backend; 11. Deal lifecycle backend; 13. Offer revision backend; 15. Offer lifecycle backend; 17. Activity backend; 18. Customer timeline backend.

- [ ] All 18 Actions use exact configured Action objects and executor permissions; no production
      path relies on unconfigured-Action compatibility.
- [ ] Authorized users see the same Customer/Contact identity in every permitted Legal Entity while
      Deal, Offer, Activity, values, and timeline entries remain selected-Legal-Entity-only.
- [ ] Customer, Contact, and Deal direct resource details fail closed on module/resource denial,
      unavailable/conditional decisions, cross-tenant IDs, and cross-Legal-Entity IDs.
- [ ] An unrestricted v1 resource can later receive an explicit SpiceDB restriction marker and
      reader/writer relations without changing its ID or ResourceRef.
- [ ] SpiceDB, RLS, Action, read-runtime, resource provider, unavailable-dependency, and migration-
      path tests pass.

## 21. Verify complete CRM acceptance and deployment

**What to build:** Prove that the complete CRM behaves as one independently deployable,
well-integrated OntOS MicroVertical and satisfies the master specification without accidental API,
database, or deployment coupling.

**Blocked by:** 8. Primary Contact UI; 12. Deal lifecycle UI; 16. Offer lifecycle UI; 19. Activity and timeline UI; 20. Authorization and resource hardening.

- [ ] Every master-spec acceptance criterion is traced to passing focused tests, with exactly five
      CRM entities and 18 dedicated mutation Actions.
- [ ] Every mutation route invokes exactly one registered Action; compound primary designation is
      one atomic dedicated Action, and edits cannot mutate status or deletion state.
- [ ] CRM independently builds, publishes its valid module contract, receives only audience-scoped
      Shell assertions, and imports no other deployment's manifest, registration, schema,
      repository, or handler.
- [ ] Generated migrations, RLS/grants, package exports, federation exposes, public manifest,
      topology, ownership, browser bundles, and i18n catalogs contain no accidental private surface.
- [ ] Database generation/migration/verification/tests, generator tests, API/database/module
      boundary checks, module contracts, application contracts, build, and the final repository
      quality gate all pass without weakening existing checks.
