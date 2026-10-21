// AREA: clients (C00/C01) — owned by the crm-clients lane. Command schemas + reducer.
// To add a command: add a TaggedStruct to clientsCommandSchemas and a Match.tag branch in applyClientsCommand.
//
// Every change appends a readable ClientEvent (card "Historie" tab); archiving never deletes anything (C01-03),
// removing a contact person only archives it, and reassignment keeps the full history (C00-03).
import { Effect, Match, Schema } from 'effect';
import type {
  Client,
  ClientEvent,
  ClientEventKind,
  ClientsSlice,
  ContactPerson,
  PartyLinkInput,
  PartyRef,
} from '../domain/clients.ts';
import { ClientKindSchema, PartyLinkInputSchema } from '../domain/clients.ts';
import { EntityIdSchema, LongTextSchema, ShortTextSchema } from '../domain/common.ts';
import { canReadClient } from '../domain/access.ts';
import type { CrmState } from '../domain/state.ts';
import type { CommandContext, Reducer } from './context.ts';
import {
  conflict,
  definedOnly,
  denied,
  invalid,
  newId,
  notFound,
  requireAnyWrite,
  requireAssign,
  requireWritableClient,
} from './context.ts';

const OptionalText = Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(200)));
const ClientFieldsSchema = {
  address: OptionalText,
  email: OptionalText,
  note: Schema.optionalKey(LongTextSchema),
  phone: OptionalText,
  regNo: OptionalText,
  segment: OptionalText,
  vatNo: OptionalText,
  website: OptionalText,
};
const ContactFieldsSchema = {
  email: OptionalText,
  note: Schema.optionalKey(LongTextSchema),
  phone: OptionalText,
  primary: Schema.optionalKey(Schema.Boolean),
  role: OptionalText,
};
const NewContactSchema = Schema.Struct({ ...ContactFieldsSchema, name: ShortTextSchema });

export const clientsCommandSchemas = [
  Schema.TaggedStruct('CreateClient', {
    ...ClientFieldsSchema,
    /** Contact persons created together with the client (C01-01). */
    contacts: Schema.optionalKey(Schema.Array(NewContactSchema).check(Schema.isMaxLength(20))),
    kind: ClientKindSchema,
    name: ShortTextSchema,
    /** Defaults to the creating salesperson; only demo.crm.assign may choose someone else. */
    ownerSalespersonId: Schema.optionalKey(EntityIdSchema),
    /** Party Registry identity created or matched before; verified by the server (CRM.md §3). */
    partyRef: Schema.optionalKey(PartyLinkInputSchema),
  }),
  Schema.TaggedStruct('UpdateClient', {
    id: EntityIdSchema,
    patch: Schema.Struct({
      ...ClientFieldsSchema,
      kind: Schema.optionalKey(ClientKindSchema),
      name: Schema.optionalKey(ShortTextSchema),
    }),
  }),
  Schema.TaggedStruct('ArchiveClient', { id: EntityIdSchema }),
  Schema.TaggedStruct('RestoreClient', { id: EntityIdSchema }),
  Schema.TaggedStruct('AddContactPerson', {
    ...ContactFieldsSchema,
    clientId: EntityIdSchema,
    name: ShortTextSchema,
  }),
  Schema.TaggedStruct('UpdateContactPerson', {
    contactId: EntityIdSchema,
    patch: Schema.Struct({ ...ContactFieldsSchema, name: Schema.optionalKey(ShortTextSchema) }),
  }),
  /** Archives the contact person (kept in history, hidden from the card). */
  Schema.TaggedStruct('RemoveContactPerson', { contactId: EntityIdSchema }),
  Schema.TaggedStruct('AssignClient', {
    clientId: EntityIdSchema,
    reason: Schema.optionalKey(LongTextSchema),
    /** Absent = unassign. */
    toSalespersonId: Schema.optionalKey(EntityIdSchema),
  }),
  // Appended last: ai-changes.ts picks commands from this array by position.
  /** Links an existing client to its Party Registry identity (verified by the server). */
  Schema.TaggedStruct('LinkClientParty', {
    clientId: EntityIdSchema,
    partyRef: PartyLinkInputSchema,
  }),
] as const;
export const ClientsCommandSchema = Schema.Union(clientsCommandSchemas);
export type ClientsCommand = typeof ClientsCommandSchema.Type;

const replaceClient = (items: readonly Client[], next: Client) =>
  items.map((entry) => (entry.id === next.id ? next : entry));

const replaceContact = (items: readonly ContactPerson[], next: ContactPerson) =>
  items.map((entry) => (entry.id === next.id ? next : entry));

const requireSalesperson = (salespeople: readonly { id: string; active: boolean }[], id: string) =>
  salespeople.some((person) => person.id === id && person.active)
    ? Effect.void
    : invalid('Obchodník neexistuje nebo není aktivní');

/**
 * The verified registry link for a command's partyRef. One Party is one CRM client: a second client for the same
 * Party would be the parallel customer record CRM.md §3 forbids, so it is refused instead of silently merged.
 */
const verifiedPartyRef = (state: CrmState, context: CommandContext, input: PartyLinkInput, clientId?: string) =>
  Effect.gen(function* verifiedParty() {
    const verified = context.verifiedParties?.get(input.counterpartyId);
    if (verified === undefined || verified.partyId !== input.partyId) {
      return yield* invalid('Vazbu na Party Registry se nepodařilo ověřit; vyberte zákazníka z registru znovu');
    }
    const holder = state.clients.items.find(
      (entry) =>
        entry.id !== clientId &&
        (entry.partyRef?.counterpartyId === input.counterpartyId || entry.partyRef?.partyId === input.partyId),
    );
    if (holder !== undefined) {
      return yield* conflict(
        canReadClient(context.viewer, holder)
          ? `Tato firma je v CRM již vedena jako klient „${holder.name}“`
          : 'Tato firma je v CRM již vedena u jiného obchodníka; požádejte vedoucího obchodu o převod',
      );
    }
    const ref: PartyRef = {
      ...definedOnly({ registryName: verified.displayName }),
      counterpartyId: verified.counterpartyId,
      linkedAt: context.now,
      linkedBy: context.viewer.principalId,
      partyId: verified.partyId,
    };
    return ref;
  });

const event = (
  context: CommandContext,
  suffix: string,
  clientId: string,
  kind: ClientEventKind,
  extra: { readonly fields?: readonly string[]; readonly subject?: string } = {},
): ClientEvent => ({
  ...definedOnly({ subject: extra.subject }),
  ...(extra.fields === undefined || extra.fields.length === 0 ? {} : { fields: extra.fields }),
  at: context.now,
  by: context.viewer.principalId,
  clientId,
  id: newId(context, `event-${suffix}`),
  kind,
});

const withClients = (state: CrmState, clients: Partial<ClientsSlice>, events: readonly ClientEvent[]): CrmState => ({
  ...state,
  clients: { ...state.clients, ...clients, events: [...(state.clients.events ?? []), ...events] },
});

/**
 * Applies a patch where `''` clears an optional field and `undefined` leaves it alone. Returns the next record
 * and the keys that really changed.
 */
const applyPatch = <T extends Record<string, unknown>>(current: T, patch: Record<string, unknown>) => {
  const changed: string[] = [];
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (value === '') {
      if (key in next) {
        delete next[key];
        changed.push(key);
      }
      continue;
    }
    if (next[key] !== value) {
      next[key] = value;
      changed.push(key);
    }
  }
  return { changed, next: next as T };
};

/** A contact person of a client the viewer may write. Foreign contacts answer "not found" (C00). */
const requireWritableContact = (state: CrmState, context: CommandContext, contactId: string) =>
  Effect.gen(function* writableContact() {
    const contact = state.clients.contacts.find((entry) => entry.id === contactId);
    if (contact === undefined) {
      return yield* notFound('Kontaktní osoba neexistuje nebo k ní nemáte přístup');
    }
    yield* requireWritableClient(state, context, contact.clientId);
    return contact;
  });

/** Only one primary contact per client: setting a new one clears the flag on the others. */
const withPrimary = (contacts: readonly ContactPerson[], clientId: string, primaryId: string) =>
  contacts.map((entry) => {
    if (entry.clientId !== clientId || entry.id === primaryId || entry.primary !== true) {
      return entry;
    }
    const { primary: _primary, ...rest } = entry;
    return rest;
  });

export const applyClientsCommand: Reducer<ClientsCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag('CreateClient', (value) =>
      Effect.gen(function* createClient() {
        yield* requireAnyWrite(context);
        const owner = value.ownerSalespersonId ?? context.viewer.salespersonId;
        if (owner !== undefined && owner !== context.viewer.salespersonId) {
          yield* requireAssign(context);
          yield* requireSalesperson(state.salespeople, owner);
        }
        if (!context.viewer.writeAll && owner === undefined) {
          return yield* invalid('Obchodník bez záznamu obchodníka nemůže založit klienta');
        }
        const id = newId(context, 'client');
        const partyRef =
          value.partyRef === undefined ? undefined : yield* verifiedPartyRef(state, context, value.partyRef);
        const client: Client = {
          ...(partyRef === undefined ? {} : { partyRef }),
          ...definedOnly({
            address: value.address,
            email: value.email,
            note: value.note,
            ownerSalespersonId: owner,
            phone: value.phone,
            regNo: value.kind === 'organization' ? value.regNo : undefined,
            segment: value.segment,
            vatNo: value.kind === 'organization' ? value.vatNo : undefined,
            website: value.website,
          }),
          createdAt: context.now,
          createdBy: context.viewer.principalId,
          id,
          kind: value.kind,
          name: value.name,
          status: 'active',
          updatedAt: context.now,
        };
        const newContacts = value.contacts ?? [];
        const firstPrimary = newContacts.findIndex((entry) => entry.primary === true);
        const contacts: ContactPerson[] = newContacts.map((entry, index) => ({
          ...definedOnly({ email: entry.email, note: entry.note, phone: entry.phone, role: entry.role }),
          ...(index === firstPrimary ? { primary: true } : {}),
          clientId: id,
          createdAt: context.now,
          createdBy: context.viewer.principalId,
          id: newId(context, `contact-${index}`),
          name: entry.name,
          status: 'active',
          updatedAt: context.now,
        }));
        const history =
          owner === undefined
            ? state.clients.assignmentHistory
            : [
                ...state.clients.assignmentHistory,
                {
                  at: context.now,
                  by: context.viewer.principalId,
                  clientId: id,
                  id: newId(context, 'assignment'),
                  toSalespersonId: owner,
                },
              ];
        return {
          entityIds: [id, ...contacts.map((entry) => entry.id)],
          state: withClients(
            state,
            {
              assignmentHistory: history,
              contacts: [...state.clients.contacts, ...contacts],
              items: [...state.clients.items, client],
            },
            [
              event(context, 'created', id, 'client_created', { subject: value.name }),
              ...(partyRef === undefined
                ? []
                : [event(context, 'party', id, 'party_linked', { subject: partyRef.registryName ?? value.name })]),
              ...contacts.map((entry, index) =>
                event(context, `contact-${index}`, id, 'contact_added', { subject: entry.name }),
              ),
            ],
          ),
        };
      }),
    ),
    Match.tag('UpdateClient', (value) =>
      Effect.gen(function* updateClient() {
        const client = yield* requireWritableClient(state, context, value.id);
        if (client.status === 'archived') {
          return yield* conflict('Archivovaného klienta nelze upravit; nejprve jej obnovte');
        }
        const kind = value.patch.kind ?? client.kind;
        const patch =
          kind === 'person'
            ? {
                ...value.patch,
                regNo: client.regNo === undefined ? undefined : '',
                vatNo: client.vatNo === undefined ? undefined : '',
              }
            : value.patch;
        const { changed, next } = applyPatch(client, patch);
        if (changed.length === 0) {
          return { entityIds: [client.id], state };
        }
        const updated: Client = { ...next, updatedAt: context.now };
        return {
          entityIds: [client.id],
          state: withClients(state, { items: replaceClient(state.clients.items, updated) }, [
            event(context, 'updated', client.id, 'client_updated', { fields: changed, subject: updated.name }),
          ]),
        };
      }),
    ),
    Match.tag('ArchiveClient', (value) =>
      Effect.gen(function* archiveClient() {
        const client = yield* requireWritableClient(state, context, value.id);
        if (client.status === 'archived') {
          return yield* conflict('Klient je již archivován');
        }
        const next: Client = { ...client, archivedAt: context.now, status: 'archived', updatedAt: context.now };
        return {
          entityIds: [client.id],
          state: withClients(state, { items: replaceClient(state.clients.items, next) }, [
            event(context, 'archived', client.id, 'client_archived', { subject: client.name }),
          ]),
        };
      }),
    ),
    Match.tag('RestoreClient', (value) =>
      Effect.gen(function* restoreClient() {
        const client = yield* requireWritableClient(state, context, value.id);
        if (client.status === 'active') {
          return yield* conflict('Klient je aktivní');
        }
        const { archivedAt: _archivedAt, ...rest } = client;
        const next: Client = { ...rest, status: 'active', updatedAt: context.now };
        return {
          entityIds: [client.id],
          state: withClients(state, { items: replaceClient(state.clients.items, next) }, [
            event(context, 'restored', client.id, 'client_restored', { subject: client.name }),
          ]),
        };
      }),
    ),
    Match.tag('AddContactPerson', (value) =>
      Effect.gen(function* addContact() {
        const client = yield* requireWritableClient(state, context, value.clientId);
        const id = newId(context, 'contact');
        const contact: ContactPerson = {
          ...definedOnly({ email: value.email, note: value.note, phone: value.phone, role: value.role }),
          ...(value.primary === true ? { primary: true } : {}),
          clientId: client.id,
          createdAt: context.now,
          createdBy: context.viewer.principalId,
          id,
          name: value.name,
          status: 'active',
          updatedAt: context.now,
        };
        const others =
          value.primary === true ? withPrimary(state.clients.contacts, client.id, id) : state.clients.contacts;
        return {
          entityIds: [id],
          state: withClients(state, { contacts: [...others, contact] }, [
            event(context, 'contact', client.id, 'contact_added', { subject: value.name }),
          ]),
        };
      }),
    ),
    Match.tag('UpdateContactPerson', (value) =>
      Effect.gen(function* updateContact() {
        const contact = yield* requireWritableContact(state, context, value.contactId);
        if (contact.status === 'archived') {
          return yield* conflict('Odebranou kontaktní osobu nelze upravit');
        }
        const { primary, ...patch } = value.patch;
        const { changed, next } = applyPatch(contact, patch);
        let updated: ContactPerson = next;
        if (primary === true && contact.primary !== true) {
          updated = { ...updated, primary: true };
          changed.push('primary');
        } else if (primary === false && contact.primary === true) {
          const { primary: _primary, ...rest } = updated;
          updated = rest;
          changed.push('primary');
        }
        if (changed.length === 0) {
          return { entityIds: [contact.id], state };
        }
        updated = { ...updated, updatedAt: context.now };
        const base =
          primary === true ? withPrimary(state.clients.contacts, contact.clientId, contact.id) : state.clients.contacts;
        return {
          entityIds: [contact.id],
          state: withClients(state, { contacts: replaceContact(base, updated) }, [
            event(context, 'contact', contact.clientId, 'contact_updated', { fields: changed, subject: updated.name }),
          ]),
        };
      }),
    ),
    Match.tag('RemoveContactPerson', (value) =>
      Effect.gen(function* removeContact() {
        const contact = yield* requireWritableContact(state, context, value.contactId);
        if (contact.status === 'archived') {
          return yield* conflict('Kontaktní osoba je již odebrána');
        }
        const { primary: _primary, ...rest } = contact;
        const next: ContactPerson = { ...rest, archivedAt: context.now, status: 'archived', updatedAt: context.now };
        return {
          entityIds: [contact.id],
          state: withClients(state, { contacts: replaceContact(state.clients.contacts, next) }, [
            event(context, 'contact', contact.clientId, 'contact_removed', { subject: contact.name }),
          ]),
        };
      }),
    ),
    Match.tag('LinkClientParty', (value) =>
      Effect.gen(function* linkClientParty() {
        const client = yield* requireWritableClient(state, context, value.clientId);
        if (
          client.partyRef?.counterpartyId === value.partyRef.counterpartyId &&
          client.partyRef.partyId === value.partyRef.partyId
        ) {
          return yield* conflict('Klient je s tímto záznamem Party Registry již propojen');
        }
        if (client.partyRef?.counterpartyId !== undefined && !context.viewer.writeAll) {
          return yield* denied('Změnit vazbu na Party Registry smí jen správce nebo vedoucí obchodu');
        }
        const partyRef = yield* verifiedPartyRef(state, context, value.partyRef, client.id);
        const next: Client = { ...client, partyRef, updatedAt: context.now };
        return {
          entityIds: [client.id],
          state: withClients(state, { items: replaceClient(state.clients.items, next) }, [
            event(context, 'party', client.id, 'party_linked', { subject: partyRef.registryName ?? client.name }),
          ]),
        };
      }),
    ),
    Match.tag('AssignClient', (value) =>
      Effect.gen(function* assignClient() {
        yield* requireAssign(context);
        const client = state.clients.items.find((entry) => entry.id === value.clientId);
        if (client === undefined) {
          return yield* notFound('Klient neexistuje');
        }
        if (value.toSalespersonId !== undefined) {
          yield* requireSalesperson(state.salespeople, value.toSalespersonId);
        }
        if (client.ownerSalespersonId === value.toSalespersonId) {
          return yield* conflict('Klient je již přidělen tomuto obchodníkovi');
        }
        // A direct API call must meet the same handover requirements as the dialog (C00-03).
        if (client.ownerSalespersonId !== undefined && (value.reason?.trim() ?? '') === '') {
          return yield* invalid('Uveďte důvod převodu, zapíše se do historie klienta');
        }
        const { ownerSalespersonId: previous, ...rest } = client;
        const next: Client =
          value.toSalespersonId === undefined
            ? { ...rest, updatedAt: context.now }
            : { ...rest, ownerSalespersonId: value.toSalespersonId, updatedAt: context.now };
        const change = {
          ...definedOnly({ fromSalespersonId: previous, reason: value.reason, toSalespersonId: value.toSalespersonId }),
          at: context.now,
          by: context.viewer.principalId,
          clientId: client.id,
          id: newId(context, 'assignment'),
        };
        return {
          entityIds: [client.id],
          state: withClients(
            state,
            {
              assignmentHistory: [...state.clients.assignmentHistory, change],
              items: replaceClient(state.clients.items, next),
            },
            [event(context, 'assigned', client.id, 'assigned', { subject: client.name })],
          ),
        };
      }),
    ),
    Match.exhaustive,
  );
