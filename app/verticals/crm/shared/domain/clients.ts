// AREA: clients (C00/C01) — owned by the crm-clients lane.
// Client cards, contact persons and the assignment history client -> salesperson.
// Adding fields: make them Schema.optionalKey (persisted JSON from older revisions must still decode).
import { Schema } from 'effect';
import type { CrmViewer } from './access.ts';
import { canReadClient } from './access.ts';
import { EntityIdSchema, IsoTimeSchema, LongTextSchema, PrincipalIdSchema, ShortTextSchema } from './common.ts';

/**
 * Reference to the canonical identity in Party Registry (ADR-0015). TODO(crm-clients): create/match the Party
 * through party-registry Actions; until then clients carry only the display snapshot below.
 */
export const PartyRefSchema = Schema.Struct({
  counterpartyId: Schema.optionalKey(EntityIdSchema),
  partyId: EntityIdSchema,
});

export const ClientKindSchema = Schema.Literals(['organization', 'person']);
export const ClientStatusSchema = Schema.Literals(['active', 'archived']);

export const ClientSchema = Schema.Struct({
  address: Schema.optionalKey(ShortTextSchema),
  archivedAt: Schema.optionalKey(IsoTimeSchema),
  createdAt: IsoTimeSchema,
  createdBy: PrincipalIdSchema,
  email: Schema.optionalKey(ShortTextSchema),
  id: EntityIdSchema,
  kind: ClientKindSchema,
  name: ShortTextSchema,
  note: Schema.optionalKey(LongTextSchema),
  /** Current salesperson; absent = unassigned (visible only to read_all). */
  ownerSalespersonId: Schema.optionalKey(EntityIdSchema),
  partyRef: Schema.optionalKey(PartyRefSchema),
  phone: Schema.optionalKey(ShortTextSchema),
  /** IČO when known. */
  regNo: Schema.optionalKey(ShortTextSchema),
  status: ClientStatusSchema,
  updatedAt: IsoTimeSchema,
});
export type Client = typeof ClientSchema.Type;

export const ContactPersonSchema = Schema.Struct({
  clientId: EntityIdSchema,
  createdAt: IsoTimeSchema,
  createdBy: PrincipalIdSchema,
  email: Schema.optionalKey(ShortTextSchema),
  id: EntityIdSchema,
  name: ShortTextSchema,
  note: Schema.optionalKey(LongTextSchema),
  phone: Schema.optionalKey(ShortTextSchema),
  /** Job role, e.g. "Nákupčí", "Jednatel". */
  role: Schema.optionalKey(ShortTextSchema),
  status: ClientStatusSchema,
  updatedAt: IsoTimeSchema,
});
export type ContactPerson = typeof ContactPersonSchema.Type;

/** One change of the client's salesperson. Past visits keep their own author (C00-03). */
export const AssignmentChangeSchema = Schema.Struct({
  at: IsoTimeSchema,
  by: PrincipalIdSchema,
  clientId: EntityIdSchema,
  fromSalespersonId: Schema.optionalKey(EntityIdSchema),
  id: EntityIdSchema,
  reason: Schema.optionalKey(LongTextSchema),
  toSalespersonId: Schema.optionalKey(EntityIdSchema),
});
export type AssignmentChange = typeof AssignmentChangeSchema.Type;

export const ClientsSliceSchema = Schema.Struct({
  assignmentHistory: Schema.Array(AssignmentChangeSchema),
  contacts: Schema.Array(ContactPersonSchema),
  items: Schema.Array(ClientSchema),
});
export type ClientsSlice = typeof ClientsSliceSchema.Type;

export const initialClientsSlice: ClientsSlice = { assignmentHistory: [], contacts: [], items: [] };

/** Ids of the clients this viewer may see. Every other area filters by this set. */
export const visibleClientIds = (slice: ClientsSlice, viewer: CrmViewer): ReadonlySet<string> =>
  new Set(slice.items.filter((client) => canReadClient(viewer, client)).map((client) => client.id));

/** Read projection: only visible clients and their contacts / assignment history. */
export const projectClientsSlice = (slice: ClientsSlice, visible: ReadonlySet<string>): ClientsSlice => ({
  assignmentHistory: slice.assignmentHistory.filter((change) => visible.has(change.clientId)),
  contacts: slice.contacts.filter((contact) => visible.has(contact.clientId)),
  items: slice.items.filter((client) => visible.has(client.id)),
});
