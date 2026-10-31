import { EntityIdSchema, LongTextSchema, ShortTextSchema } from '../domain/common.ts';
import type { EntityId } from '../domain/common.ts';
// AREA: clients (C00/C01) — owned by the crm-clients lane. Command schemas + reducer.
// To add a command: add a TaggedStruct to clientsCommandSchemas and a Match.tag branch in applyClientsCommand.
//
// Every change appends a readable ClientEvent (card "Historie" tab); archiving never deletes anything (C01-03),
// removing a contact person only archives it, and reassignment keeps the full history (C00-03).
import { Effect, Match, Schema } from 'effect';
import { ClientKindSchema, PartyLinkInputSchema } from '../domain/clients.ts';
import type {
  Client,
  ClientEvent,
  ClientEventKind,
  ClientsSlice,
  ContactPerson,
  PartyLinkInput,
  PartyRef,
} from '../domain/clients.ts';

import { canReadClient } from '../domain/access.ts';
import type { CrmState } from '../domain/state.ts';
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
  requireWriteAll,
} from './context.ts';
import type { CommandContext, Reducer } from './context.ts';

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
  /**
   * Správce / vedoucí: gives every active client without a Party Registry identity (or the listed clients) its
   * registry Party + CUSTOMER Counterparty through the server-side intake, and correlates every approved external
   * customer id of a linked client with its Counterparty (C04 migration).
   */
  Schema.TaggedStruct('SyncClientParties', {
    clientIds: Schema.optionalKey(Schema.Array(EntityIdSchema).check(Schema.isMaxLength(50))),
  }),
] as const;
export const ClientsCommandSchema = Schema.Union(clientsCommandSchemas);
export type ClientsCommand = typeof ClientsCommandSchema.Type;

const replaceClient = (items: readonly Client[], next: Client) =>
  items.map((entry) => (entry.id === next.id ? next : entry));

const replaceContact = (items: readonly ContactPerson[], next: ContactPerson) =>
  items.map((entry) => (entry.id === next.id ? next : entry));

const requireSalesperson = (salespeople: readonly { active: boolean; id: string }[], id: string) =>
  salespeople.some((person) => person.id === id && person.active)
    ? Effect.void
    : invalid('Obchodník neexistuje nebo není aktivní');

const icoOf = (regNo: string | undefined) => (regNo ?? '').replaceAll(/\s+/gu, '');

/**
 * The verified registry link for a command's partyRef. A Party belongs to one CRM client unless the clients carry
 * the same IČO: then they are one organization entered twice and share its registry identity (no new parallel
 * identity). Any other second client for the same Party is refused instead of silently merged (CRM.md §3, l.210).
 */
const verifiedPartyRef = Effect.fn('Crm.verifiedParty')(function* verifiedParty(
  state: CrmState,
  context: CommandContext,
  input: PartyLinkInput,
  subject: { readonly id?: string; readonly regNo?: string | undefined },
) {
  const verified = context.verifiedParties?.get(input.counterpartyId);
  if (verified === undefined || verified.partyId !== input.partyId) {
    return yield* invalid('Vazbu na Party Registry se nepodařilo ověřit; vyberte zákazníka z registru znovu');
  }
  const ico = icoOf(subject.regNo);
  const holder = state.clients.items.find(
    (entry) =>
      entry.id !== subject.id &&
      (entry.partyRef?.counterpartyId === input.counterpartyId || entry.partyRef?.partyId === input.partyId) &&
      (ico === '' || icoOf(entry.regNo) !== ico),
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

/**
 * C04: every approved external customer id (customer link) of a registry-linked client carries that client's
 * Counterparty and Party, so imports pair to the canonical identity rather than to a CRM-local id.
 */
export const correlateCustomerLinks = (state: CrmState): CrmState => {
  const refs = new Map(
    state.clients.items.flatMap((client) =>
      client.partyRef?.counterpartyId === undefined ? [] : [[client.id, client.partyRef] as const],
    ),
  );
  let changed = false;
  const customerLinks = state.imports.customerLinks.map((link) => {
    const ref = refs.get(link.clientId);
    if (
      ref?.counterpartyId === undefined ||
      (link.counterpartyId === ref.counterpartyId && link.partyId === ref.partyId)
    ) {
      return link;
    }
    changed = true;
    return { ...link, counterpartyId: ref.counterpartyId, partyId: ref.partyId };
  });
  return changed ? { ...state, imports: { ...state.imports, customerLinks } } : state;
};

/** Customer links still waiting for the C04 correlation (their client already has a Counterparty). */
export const uncorrelatedCustomerLinks = (state: CrmState) =>
  state.imports.customerLinks.filter((link) => {
    const ref = state.clients.items.find((client) => client.id === link.clientId)?.partyRef;
    return ref?.counterpartyId !== undefined && link.counterpartyId !== ref.counterpartyId;
  }).length;

const event = (
  context: CommandContext,
  suffix: string,
  clientId: EntityId,
  kind: ClientEventKind,
  extra: { readonly fields?: readonly string[]; readonly subject?: string } = {},
): ClientEvent => {
  const result: ClientEvent = {
    ...definedOnly({ subject: extra.subject }),

    at: context.now,
    by: context.viewer.principalId,
    clientId,
    id: newId(context, `event-${suffix}`),
    kind,
  };
  if (extra.fields !== undefined && extra.fields.length > 0) {
    Object.assign(result, { fields: extra.fields });
  }
  return result;
};

const withClients = (state: CrmState, clients: Partial<ClientsSlice>, events: readonly ClientEvent[]): CrmState => ({
  ...state,
  clients: { ...state.clients, ...clients, events: [...(state.clients.events ?? []), ...events] },
});

/**
 * Applies a patch where `''` clears an optional field and `undefined` leaves it alone. Returns the next record
 * and the keys that really changed.
 */
type ClientPatch = Extract<ClientsCommand, { readonly _tag: 'UpdateClient' }>['patch'];
type ContactPatch = Extract<ClientsCommand, { readonly _tag: 'UpdateContactPerson' }>['patch'];
const applyPatch = <T extends Client | ContactPerson>(current: T, patch: ClientPatch | ContactPatch) => {
  const changed: string[] = [];
  const next = { ...current };
  const previousValues = new Map(Object.entries(current));
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      if (value === '') {
        if (key in next) {
          Reflect.deleteProperty(next, key);
          changed.push(key);
        }
      } else if (previousValues.get(key) !== value) {
        Reflect.set(next, key, value);
        changed.push(key);
      }
    }
  }
  return { changed, next };
};

/** A contact person of a client the viewer may write. Foreign contacts answer "not found" (C00). */
const requireWritableContact = Effect.fn('Crm.writableContact')(function* writableContact(
  state: CrmState,
  context: CommandContext,
  contactId: string,
) {
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

/** Stores a verified registry identity on a client, correlates its external customer ids and records it. */
const withPartyRef = (
  state: CrmState,
  client: Client,
  partyRef: PartyRef,
  context: CommandContext,
  eventSuffix: string,
): CrmState => {
  const items = replaceClient(state.clients.items, { ...client, partyRef, updatedAt: context.now });
  const linked = correlateCustomerLinks({ ...state, clients: { ...state.clients, items } });
  return withClients(linked, {}, [
    event(context, eventSuffix, client.id, 'party_linked', { subject: partyRef.registryName ?? client.name }),
  ]);
};

export const applyClientsCommand: Reducer<ClientsCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag(
      'CreateClient',
      Effect.fn('Crm.createClient')(function* createClient(
        value: Extract<ClientsCommand, { readonly _tag: 'CreateClient' }>,
      ) {
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
          value.partyRef === undefined
            ? undefined
            : yield* verifiedPartyRef(state, context, value.partyRef, {
                regNo: value.kind === 'organization' ? value.regNo : undefined,
              });
        const client: Client = {
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
        if (partyRef !== undefined) {
          Object.assign(client, { partyRef });
        }
        const newContacts = value.contacts ?? [];
        const firstPrimary = newContacts.findIndex((entry) => entry.primary === true);
        const contacts: ContactPerson[] = newContacts.map((entry, index) => {
          const contact: ContactPerson = {
            ...definedOnly({ email: entry.email, note: entry.note, phone: entry.phone, role: entry.role }),
            clientId: id,
            createdAt: context.now,
            createdBy: context.viewer.principalId,
            id: newId(context, `contact-${index}`),
            name: entry.name,
            status: 'active',
            updatedAt: context.now,
          };
          if (index === firstPrimary) {
            Object.assign(contact, { primary: true });
          }
          return contact;
        });
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
    Match.tag(
      'UpdateClient',
      Effect.fn('Crm.updateClient')(function* updateClient(
        value: Extract<ClientsCommand, { readonly _tag: 'UpdateClient' }>,
      ) {
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
    Match.tag(
      'ArchiveClient',
      Effect.fn('Crm.archiveClient')(function* archiveClient(
        value: Extract<ClientsCommand, { readonly _tag: 'ArchiveClient' }>,
      ) {
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
    Match.tag(
      'RestoreClient',
      Effect.fn('Crm.restoreClient')(function* restoreClient(
        value: Extract<ClientsCommand, { readonly _tag: 'RestoreClient' }>,
      ) {
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
    Match.tag(
      'AddContactPerson',
      Effect.fn('Crm.addContact')(function* addContact(
        value: Extract<ClientsCommand, { readonly _tag: 'AddContactPerson' }>,
      ) {
        const client = yield* requireWritableClient(state, context, value.clientId);
        const id = newId(context, 'contact');
        const contact: ContactPerson = {
          ...definedOnly({ email: value.email, note: value.note, phone: value.phone, role: value.role }),

          clientId: client.id,
          createdAt: context.now,
          createdBy: context.viewer.principalId,
          id,
          name: value.name,
          status: 'active',
          updatedAt: context.now,
        };
        if (value.primary === true) {
          Object.assign(contact, { primary: true });
        }
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
    Match.tag(
      'UpdateContactPerson',
      Effect.fn('Crm.updateContact')(function* updateContact(
        value: Extract<ClientsCommand, { readonly _tag: 'UpdateContactPerson' }>,
      ) {
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
    Match.tag(
      'RemoveContactPerson',
      Effect.fn('Crm.removeContact')(function* removeContact(
        value: Extract<ClientsCommand, { readonly _tag: 'RemoveContactPerson' }>,
      ) {
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
    Match.tag(
      'LinkClientParty',
      Effect.fn('Crm.linkClientParty')(function* linkClientParty(
        value: Extract<ClientsCommand, { readonly _tag: 'LinkClientParty' }>,
      ) {
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
        const partyRef = yield* verifiedPartyRef(state, context, value.partyRef, client);
        return { entityIds: [client.id], state: withPartyRef(state, client, partyRef, context, 'party') };
      }),
    ),
    Match.tag(
      'SyncClientParties',
      Effect.fn('Crm.syncClientParties')(function* syncClientParties(
        value: Extract<ClientsCommand, { readonly _tag: 'SyncClientParties' }>,
      ) {
        yield* requireWriteAll(context);
        const wanted = value.clientIds === undefined ? undefined : new Set(value.clientIds);
        if (wanted !== undefined && [...wanted].some((id) => !state.clients.items.some((entry) => entry.id === id))) {
          return yield* notFound('Klient neexistuje');
        }
        const targets = state.clients.items
          .filter(
            (client) =>
              client.partyRef === undefined &&
              (wanted === undefined ? client.status === 'active' : wanted.has(client.id)),
          )
          .slice(0, 50);
        // The server-side intake links the targets after this reducer; the C04 correlation happens here.
        return { entityIds: targets.map((client) => client.id), state: correlateCustomerLinks(state) };
      }),
    ),
    Match.tag(
      'AssignClient',
      Effect.fn('Crm.assignClient')(function* assignClient(
        value: Extract<ClientsCommand, { readonly _tag: 'AssignClient' }>,
      ) {
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
