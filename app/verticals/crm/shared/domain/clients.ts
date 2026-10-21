// AREA: clients (C00/C01) — owned by the crm-clients lane.
// Client cards, contact persons and the assignment history client -> salesperson.
// Adding fields: make them Schema.optionalKey (persisted JSON from older revisions must still decode).
import { Schema } from 'effect';
import type { CrmViewer } from './access.ts';
import { canReadClient } from './access.ts';
import { EntityIdSchema, IsoTimeSchema, LongTextSchema, PrincipalIdSchema, ShortTextSchema } from './common.ts';

/**
 * Reference to the canonical identity in Party Registry (ADR-0015, CRM.md §3/§4). The Party Registry owns the
 * Party, its Contact Points and the CUSTOMER Counterparty Role; the CRM client only links to it and keeps a display
 * snapshot for its lists. The server verifies every link through the party-registry counterparty Read before it is
 * stored (never trusted from the browser).
 */
export const PartyRefSchema = Schema.Struct({
  counterpartyId: Schema.optionalKey(EntityIdSchema),
  /** When the link was verified and stored. */
  linkedAt: Schema.optionalKey(IsoTimeSchema),
  linkedBy: Schema.optionalKey(PrincipalIdSchema),
  partyId: EntityIdSchema,
  /** Display name of the Party in the registry at link time. */
  registryName: Schema.optionalKey(ShortTextSchema),
});
export type PartyRef = typeof PartyRefSchema.Type;

/** What a command may send: the Counterparty (CUSTOMER context of this company) and its Party. */
export const PartyLinkInputSchema = Schema.Struct({
  counterpartyId: EntityIdSchema,
  partyId: EntityIdSchema,
});
export type PartyLinkInput = typeof PartyLinkInputSchema.Type;

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
  /** Business segment chosen from a short list (velkoobchod, restaurace, hotel...). */
  segment: Schema.optionalKey(ShortTextSchema),
  status: ClientStatusSchema,
  updatedAt: IsoTimeSchema,
  /** DIČ when known. */
  vatNo: Schema.optionalKey(ShortTextSchema),
  website: Schema.optionalKey(ShortTextSchema),
});
export type Client = typeof ClientSchema.Type;

/** Segments offered by the client form (stored as the key; labels are localised). */
export const clientSegments = [
  'wholesale',
  'retail',
  'bakery',
  'restaurant',
  'hotel',
  'catering',
  'cafe',
  'institution',
] as const;

export const ContactPersonSchema = Schema.Struct({
  archivedAt: Schema.optionalKey(IsoTimeSchema),
  clientId: EntityIdSchema,
  createdAt: IsoTimeSchema,
  createdBy: PrincipalIdSchema,
  email: Schema.optionalKey(ShortTextSchema),
  id: EntityIdSchema,
  name: ShortTextSchema,
  note: Schema.optionalKey(LongTextSchema),
  phone: Schema.optionalKey(ShortTextSchema),
  /** Main contact of the client (shown in the list). */
  primary: Schema.optionalKey(Schema.Boolean),
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

export const ClientEventKindSchema = Schema.Literals([
  'client_created',
  'client_updated',
  'client_archived',
  'client_restored',
  'contact_added',
  'contact_updated',
  'contact_removed',
  'assigned',
  'party_linked',
]);
export type ClientEventKind = typeof ClientEventKindSchema.Type;

/** Readable change log of one client card ("Historie" tab). Core audit keeps the full invocation record. */
export const ClientEventSchema = Schema.Struct({
  at: IsoTimeSchema,
  by: PrincipalIdSchema,
  clientId: EntityIdSchema,
  /** Changed field keys (client_updated / contact_updated). */
  fields: Schema.optionalKey(Schema.Array(ShortTextSchema)),
  id: EntityIdSchema,
  kind: ClientEventKindSchema,
  /** Short subject, e.g. the contact person's name. */
  subject: Schema.optionalKey(ShortTextSchema),
});
export type ClientEvent = typeof ClientEventSchema.Type;

export const ClientsSliceSchema = Schema.Struct({
  assignmentHistory: Schema.Array(AssignmentChangeSchema),
  contacts: Schema.Array(ContactPersonSchema),
  events: Schema.optionalKey(Schema.Array(ClientEventSchema)),
  items: Schema.Array(ClientSchema),
});
export type ClientsSlice = typeof ClientsSliceSchema.Type;

export const initialClientsSlice: ClientsSlice = { assignmentHistory: [], contacts: [], events: [], items: [] };

/** Ids of the clients this viewer may see. Every other area filters by this set. */
export const visibleClientIds = (slice: ClientsSlice, viewer: CrmViewer): ReadonlySet<string> =>
  new Set(slice.items.filter((client) => canReadClient(viewer, client)).map((client) => client.id));

/** Read projection: only visible clients and their contacts / assignment history. */
export const projectClientsSlice = (slice: ClientsSlice, visible: ReadonlySet<string>): ClientsSlice => ({
  assignmentHistory: slice.assignmentHistory.filter((change) => visible.has(change.clientId)),
  contacts: slice.contacts.filter((contact) => visible.has(contact.clientId)),
  events: (slice.events ?? []).filter((event) => visible.has(event.clientId)),
  items: slice.items.filter((client) => visible.has(client.id)),
});
