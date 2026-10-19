// AREA: clients (C00/C01) — owned by the crm-clients lane. Command schemas + reducer.
// To add a command: add a TaggedStruct to clientsCommandSchemas and a Match.tag branch in applyClientsCommand.
import { Effect, Match, Schema } from 'effect';
import type { Client, ContactPerson } from '../domain/clients.ts';
import { ClientKindSchema } from '../domain/clients.ts';
import { EntityIdSchema, LongTextSchema, ShortTextSchema } from '../domain/common.ts';
import type { CommandContext, Reducer } from './context.ts';
import {
  conflict,
  definedOnly,
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
};

export const clientsCommandSchemas = [
  Schema.TaggedStruct('CreateClient', {
    ...ClientFieldsSchema,
    kind: ClientKindSchema,
    name: ShortTextSchema,
    /** Defaults to the creating salesperson; only demo.crm.assign may choose someone else. */
    ownerSalespersonId: Schema.optionalKey(EntityIdSchema),
  }),
  Schema.TaggedStruct('UpdateClient', {
    id: EntityIdSchema,
    patch: Schema.Struct({ ...ClientFieldsSchema, name: Schema.optionalKey(ShortTextSchema) }),
  }),
  Schema.TaggedStruct('ArchiveClient', { id: EntityIdSchema }),
  Schema.TaggedStruct('AddContactPerson', {
    clientId: EntityIdSchema,
    email: OptionalText,
    name: ShortTextSchema,
    note: Schema.optionalKey(LongTextSchema),
    phone: OptionalText,
    role: OptionalText,
  }),
  Schema.TaggedStruct('AssignClient', {
    clientId: EntityIdSchema,
    reason: Schema.optionalKey(LongTextSchema),
    /** Absent = unassign. */
    toSalespersonId: Schema.optionalKey(EntityIdSchema),
  }),
] as const;
export const ClientsCommandSchema = Schema.Union(clientsCommandSchemas);
export type ClientsCommand = typeof ClientsCommandSchema.Type;

const replaceClient = (items: readonly Client[], next: Client) =>
  items.map((entry) => (entry.id === next.id ? next : entry));

const requireSalesperson = (context: CommandContext, salespeople: readonly { id: string }[], id: string) =>
  salespeople.some((person) => person.id === id) ? Effect.void : invalid('Obchodník neexistuje');

export const applyClientsCommand: Reducer<ClientsCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag('CreateClient', (value) =>
      Effect.gen(function* createClient() {
        yield* requireAnyWrite(context);
        const owner = value.ownerSalespersonId ?? context.viewer.salespersonId;
        if (owner !== undefined && owner !== context.viewer.salespersonId) {
          yield* requireAssign(context);
          yield* requireSalesperson(context, state.salespeople, owner);
        }
        if (!context.viewer.writeAll && owner === undefined) {
          return yield* invalid('Obchodník bez záznamu obchodníka nemůže založit klienta');
        }
        const id = newId(context, 'client');
        const client: Client = {
          ...definedOnly({
            address: value.address,
            email: value.email,
            note: value.note,
            ownerSalespersonId: owner,
            phone: value.phone,
            regNo: value.regNo,
          }),
          createdAt: context.now,
          createdBy: context.viewer.principalId,
          id,
          kind: value.kind,
          name: value.name,
          status: 'active',
          updatedAt: context.now,
        };
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
          entityIds: [id],
          state: {
            ...state,
            clients: { ...state.clients, assignmentHistory: history, items: [...state.clients.items, client] },
          },
        };
      }),
    ),
    Match.tag('UpdateClient', (value) =>
      Effect.gen(function* updateClient() {
        const client = yield* requireWritableClient(state, context, value.id);
        const { name, ...optional } = value.patch;
        // An empty string clears an optional field.
        const cleared = Object.fromEntries(
          Object.entries(client).filter(([key]) => optional[key as keyof typeof optional] !== ''),
        );
        const next = {
          ...cleared,
          ...definedOnly(optional),
          name: name ?? client.name,
          updatedAt: context.now,
        } as Client;
        return {
          entityIds: [client.id],
          state: { ...state, clients: { ...state.clients, items: replaceClient(state.clients.items, next) } },
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
          state: { ...state, clients: { ...state.clients, items: replaceClient(state.clients.items, next) } },
        };
      }),
    ),
    Match.tag('AddContactPerson', (value) =>
      Effect.gen(function* addContact() {
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
        return {
          entityIds: [id],
          state: { ...state, clients: { ...state.clients, contacts: [...state.clients.contacts, contact] } },
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
          yield* requireSalesperson(context, state.salespeople, value.toSalespersonId);
        }
        if (client.ownerSalespersonId === value.toSalespersonId) {
          return yield* conflict('Klient je již přidělen tomuto obchodníkovi');
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
          state: {
            ...state,
            clients: {
              ...state.clients,
              assignmentHistory: [...state.clients.assignmentHistory, change],
              items: replaceClient(state.clients.items, next),
            },
          },
        };
      }),
    ),
    Match.exhaustive,
  );
