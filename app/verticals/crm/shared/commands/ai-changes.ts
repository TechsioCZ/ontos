import { AiSnapshotValueSchema } from '@app/shared-contracts/ai-approvals';
import { EntityIdSchema, LongTextSchema, ShortTextSchema } from '../domain/common.ts';
import type { EntityId } from '../domain/common.ts';
// AREA: AI level C (specs AGENT.md) — owned by the ai-level-c lane. Command schemas + reducer.
//
//   AiProposeChanges  one pending batch of proposals. Every item waits for approval. Every proposal is dry-run
//                     against the current state first (e.g. reassigning a client needs demo.crm.assign).
//   AiDecideChanges   principal with write_all: approve (applies the stored operation as the approver) or reject.
//   AiRevertBatch     principal with write_all: restores every applied change of one batch from its snapshots
//                     (only when nobody changed the entity since); pending proposals of the batch are rejected.
//
// Native Action grants authorize execution; the reducer retains its write_all and proposal state checks.
import { Effect, Match, Option, Predicate, Result, Schema } from 'effect';
import { AiOperationSchema, initialAiChangesSlice, newClientContactsDiff } from '../domain/ai-changes.ts';
import type {
  AiBatch,
  AiChange,
  AiDiffLine,
  AiEntityKind,
  AiLogEntry,
  AiOperation,
  AiRisk,
  AiSnapshot,
} from '../domain/ai-changes.ts';

import { ClientSchema, ContactPersonSchema, PartyLinkInputSchema } from '../domain/clients.ts';
import type { Client, ClientEvent, ContactPerson } from '../domain/clients.ts';

import { ImportedOrderSchema } from '../domain/imports.ts';
import type { ImportedOrder, PairingChange } from '../domain/imports.ts';

import type { CrmState } from '../domain/state.ts';
import { CrmReferenceIneligible } from '../errors/crm-reference-ineligible.ts';
import { PlanItemSchema } from '../domain/visits.ts';
import type { PlanItem } from '../domain/visits.ts';

import { applyClientsCommand } from './clients.ts';
import { conflict, invalid, newId, notFound, requireWriteAll } from './context.ts';
import type { CommandChange, CommandContext, CrmCommandFailure, Reducer } from './context.ts';

import { applyImportsCommand } from './imports.ts';
import { applyVisitsCommand } from './visits.ts';

const missingProposalReason = 'Návrh AI neexistuje';

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(2000));

export const aiChangesCommandSchemas = [
  Schema.TaggedStruct('AiProposeChanges', {
    /** Display name the agent reports; the principal id is always taken from the authenticated caller. */
    agentLabel: Schema.optionalKey(ShortTextSchema),
    changes: Schema.Array(Schema.Struct({ operation: AiOperationSchema, reason: ReasonSchema })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
    /** The instruction the agent is working on. */
    instruction: ReasonSchema,
    runId: Schema.optionalKey(ShortTextSchema),
  }),
  Schema.TaggedStruct('AiDecideChanges', {
    changeIds: Schema.Array(EntityIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    decision: Schema.Literals(['approve', 'reject']),
    note: Schema.optionalKey(LongTextSchema),
  }),
  Schema.TaggedStruct('AiRevertBatch', {
    batchId: EntityIdSchema,
    note: Schema.optionalKey(LongTextSchema),
  }),
] as const;
export const AiChangesCommandSchema = Schema.Union(aiChangesCommandSchemas);
export type AiChangesCommand = typeof AiChangesCommandSchema.Type;

// ------------------------------------------------------------------------------------------------ operations

/** Runs one stored operation through the owning area's reducer (all its checks apply). */
const runOperation = (state: CrmState, operation: AiOperation, context: CommandContext) =>
  Match.value(operation).pipe(
    Match.tags({
      AddContactPerson: (value) => applyClientsCommand(state, value, context),
      AssignClient: (value) => applyClientsCommand(state, value, context),
      CreateClient: (value) => applyClientsCommand(state, value, context),
      PairOrder: (value) => applyImportsCommand(state, value, context),
      PlanContact: (value) => applyVisitsCommand(state, value, context),
      UnpairOrder: (value) => applyImportsCommand(state, value, context),
      UpdateClient: (value) => applyClientsCommand(state, value, context),
      UpdateContactPerson: (value) => applyClientsCommand(state, value, context),
    }),
    Match.exhaustive,
  );

const riskOf = (operation: AiOperation): AiRisk =>
  Match.value(operation).pipe(
    Match.tags({
      AddContactPerson: (): AiRisk => 'low',
      AssignClient: (): AiRisk => 'high',
      CreateClient: (): AiRisk => 'medium',
      PairOrder: (): AiRisk => 'high',
      PlanContact: (): AiRisk => 'low',
      UnpairOrder: (): AiRisk => 'high',
      UpdateClient: (value): AiRisk =>
        (['name', 'regNo', 'vatNo', 'kind'] as const).some((key) => value.patch[key] !== undefined) ? 'high' : 'medium',
      UpdateContactPerson: (): AiRisk => 'medium',
    }),
    Match.exhaustive,
  );

const fieldLabels = new Map(
  Object.entries({
    address: 'Adresa',
    clientId: 'Klient',
    contacts: 'Kontaktní osoby',
    dueDate: 'Ozvat se dne',
    email: 'E-mail',
    kind: 'Typ klienta',
    name: 'Název / jméno',
    note: 'Poznámka',
    ownerSalespersonId: 'Přidělený obchodník',
    pairing: 'Stav párování',
    phone: 'Telefon',
    primary: 'Hlavní kontakt',
    regNo: 'IČO',
    role: 'Role',
    salespersonId: 'Obchodník',
    segment: 'Segment',
    vatNo: 'DIČ',
    website: 'Web',
  }),
);
const segmentLabels = new Map(
  Object.entries({
    bakery: 'Pekárna / výrobna',
    cafe: 'Kavárna / cukrárna',
    catering: 'Catering',
    hotel: 'Hotel',
    institution: 'Instituce / jídelna',
    restaurant: 'Restaurace',
    retail: 'Maloobchod',
    wholesale: 'Velkoobchod',
  }),
);
const pairingLabels = new Map(
  Object.entries({ paired: 'Napárováno', review: 'Ke kontrole', unpaired: 'Nenapárováno' }),
);

type OwnerFieldValue<T> = T extends object ? T[keyof T] : never;
type AiDisplayValue = OwnerFieldValue<AiOperation | Client | ContactPerson | PlanItem> | undefined;
type AiDisplayFields = Readonly<Record<string, AiDisplayValue>>;
type AiPatch = Extract<AiOperation, { readonly _tag: 'UpdateClient' | 'UpdateContactPerson' }>['patch'];

const DisplayValueSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
const display = (state: CrmState, key: string, value: AiDisplayValue): string | undefined => {
  const decoded = Schema.decodeUnknownOption(DisplayValueSchema)(value);
  if (Option.isNone(decoded)) {
    const party = Schema.decodeUnknownOption(PartyLinkInputSchema)(value);
    return Option.isSome(party) ? party.value.partyId : undefined;
  }
  if (decoded.value === '') {
    return undefined;
  }
  if (Schema.is(Schema.Boolean)(decoded.value)) {
    return decoded.value ? 'ano' : 'ne';
  }
  const text = String(decoded.value);
  if (key === 'segment') {
    return segmentLabels.get(text) ?? text;
  }
  if (key === 'kind') {
    return text === 'person' ? 'Fyzická osoba' : 'Firma';
  }
  if (key === 'clientId') {
    return state.clients.items.find((client) => client.id === text)?.name ?? text;
  }
  if (key === 'salespersonId' || key === 'ownerSalespersonId') {
    return state.salespeople.find((person) => person.id === text)?.name ?? text;
  }
  if (key === 'pairing') {
    return pairingLabels.get(text) ?? text;
  }
  return text;
};

const line = (
  state: CrmState,
  field: string,
  before: AiDisplayValue,
  after: AiDisplayValue,
): AiDiffLine | undefined => {
  const from = display(state, field, before);
  const to = after === '' ? undefined : display(state, field, after);
  if (from === to) {
    return undefined;
  }
  const entry: AiDiffLine = { field, label: fieldLabels.get(field) ?? field };
  if (from !== undefined) {
    Object.assign(entry, { before: from });
  }
  if (to !== undefined) {
    Object.assign(entry, { after: to });
  }
  return entry;
};

const patchLines = (state: CrmState, current: Client | ContactPerson | undefined, patch: AiPatch) => {
  const previous = new Map<string, AiDisplayValue>(Object.entries(current ?? {}));
  return Object.entries(patch).flatMap(([field, value]) => {
    if (value === undefined) {
      return [];
    }
    const entry = line(state, field, previous.get(field), value);
    return entry === undefined ? [] : [entry];
  });
};

const newValueLines = (state: CrmState, values: AiDisplayFields) =>
  Object.entries(values).flatMap(([field, value]) => {
    if (field === '_tag' || field === 'contacts' || value === undefined) {
      return [];
    }
    const entry = line(state, field, undefined, value);
    return entry === undefined ? [] : [entry];
  });

const orderLabel = (order: ImportedOrder) => `Objednávka ${order.number ?? order.externalId} (${order.source})`;

interface Described {
  readonly diff: readonly AiDiffLine[];
  readonly summary: string;
  readonly target: AiChange['target'];
}

/** Readable summary, target and before -> after lines of a proposal against the current state. */
const describe = (state: CrmState, operation: AiOperation): Described => {
  const clientOf = (id: string) => state.clients.items.find((client) => client.id === id);
  const clientTarget = (id: EntityId): AiChange['target'] => ({
    id,
    kind: 'client',
    label: clientOf(id)?.name ?? 'Neznámý klient',
  });
  return Match.value(operation).pipe(
    Match.tags({
      AddContactPerson: ({ _tag, clientId, ...values }): Described => ({
        diff: newValueLines(state, values),
        summary: 'Nová kontaktní osoba',
        target: clientTarget(clientId),
      }),
      AssignClient: (value): Described => ({
        diff: [
          line(state, 'ownerSalespersonId', clientOf(value.clientId)?.ownerSalespersonId, value.toSalespersonId ?? ''),
        ].filter((entry): entry is AiDiffLine => entry !== undefined),
        summary: 'Přidělení klienta obchodníkovi',
        target: clientTarget(value.clientId),
      }),
      CreateClient: (value): Described => ({
        diff: [...newValueLines(state, value), ...newClientContactsDiff(value.contacts)],
        summary: 'Založení nového klienta',
        target: { kind: 'client', label: value.name },
      }),
      PairOrder: (value): Described => {
        const order = state.imports.orders.find((entry) => entry.id === value.orderId);
        return {
          diff: [
            line(state, 'clientId', order?.clientId, value.clientId),
            line(state, 'pairing', order?.pairing, 'paired'),
          ].filter((entry): entry is AiDiffLine => entry !== undefined),
          summary: 'Přiřazení objednávky klientovi',
          target: {
            id: value.orderId,
            kind: 'order',
            label: order === undefined ? 'Neznámá objednávka' : orderLabel(order),
          },
        };
      },
      PlanContact: ({ _tag, clientId, sourceVisitId: _source, ...values }): Described => ({
        diff: newValueLines(state, {
          ...values,
          salespersonId: values.salespersonId ?? clientOf(clientId)?.ownerSalespersonId,
        }),
        summary: 'Naplánování kontaktu',
        target: clientTarget(clientId),
      }),
      UnpairOrder: (value): Described => {
        const order = state.imports.orders.find((entry) => entry.id === value.orderId);
        return {
          diff: [
            line(state, 'clientId', order?.clientId, ''),
            line(state, 'pairing', order?.pairing, 'unpaired'),
          ].filter((entry): entry is AiDiffLine => entry !== undefined),
          summary: 'Zrušení párování objednávky',
          target: {
            id: value.orderId,
            kind: 'order',
            label: order === undefined ? 'Neznámá objednávka' : orderLabel(order),
          },
        };
      },
      UpdateClient: (value): Described => {
        const client = clientOf(value.id);
        return {
          diff: patchLines(state, client, value.patch),
          summary: 'Úprava údajů klienta',
          target: clientTarget(value.id),
        };
      },
      UpdateContactPerson: (value): Described => {
        const contact = state.clients.contacts.find((entry) => entry.id === value.contactId);
        const client = contact === undefined ? undefined : clientOf(contact.clientId);
        return {
          diff: patchLines(state, contact, value.patch),
          summary: 'Úprava kontaktní osoby',
          target: {
            id: value.contactId,
            kind: 'contact',
            label:
              contact === undefined
                ? 'Neznámá kontaktní osoba'
                : contact.name + (client === undefined ? '' : ` · ${client.name}`),
          },
        };
      },
    }),
    Match.exhaustive,
  );
};

// ------------------------------------------------------------------------------------------------ snapshots

const EntitySchema = Schema.Union([ClientSchema, ContactPersonSchema, ImportedOrderSchema, PlanItemSchema]);
type Entity = typeof EntitySchema.Type;
const SnapshotObjectSchema = Schema.Record(Schema.String, AiSnapshotValueSchema);
const encodeEntity = (entity: Entity) =>
  Schema.encodeEffect(EntitySchema)(entity).pipe(
    Effect.flatMap((encoded) => Schema.decodeUnknownEffect(SnapshotObjectSchema)({ ...entity, ...encoded })),
  );
const entityWire = (entity: Entity | undefined) =>
  entity === undefined
    ? Option.none<typeof SnapshotObjectSchema.Type>()
    : Schema.encodeOption(EntitySchema)(entity).pipe(
        Option.flatMap((encoded) => Schema.decodeUnknownOption(SnapshotObjectSchema)({ ...entity, ...encoded })),
      );
interface Collection {
  readonly get: (state: CrmState) => readonly Entity[];
}
const collections = {
  client: { get: (state: CrmState) => state.clients.items },
  contact: { get: (state: CrmState) => state.clients.contacts },
  order: { get: (state: CrmState) => state.imports.orders },
  plan: { get: (state: CrmState) => state.visits.plan },
} satisfies Record<AiEntityKind, Collection>;
const entityKinds: readonly AiEntityKind[] = ['client', 'contact', 'order', 'plan'];
/** JSONB reorders object keys on persistence; snapshots must compare values, not insertion order. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Every entity the change created or modified, with its exact previous and next value. */
const snapshotsBetween = Effect.fn('Crm.snapshotChanges')(function* snapshotChanges(
  previous: CrmState,
  next: CrmState,
) {
  const byKind = yield* Effect.forEach(
    entityKinds,
    (kind) => {
      const before = new Map(collections[kind].get(previous).map((entity) => [entity.id, entity] as const));
      return Effect.forEach(
        collections[kind].get(next),
        Effect.fn('Crm.snapshotEntity')(function* snapshotEntity(entity: Entity) {
          const old = before.get(entity.id);
          const after = yield* encodeEntity(entity);
          const encodedBefore = old === undefined ? undefined : yield* encodeEntity(old);
          if (old !== undefined && same(encodedBefore, after)) {
            return [];
          }
          const snapshot: AiSnapshot = { after, id: entity.id, kind };
          if (encodedBefore !== undefined) {
            Object.assign(snapshot, { before: encodedBefore });
          }
          return [snapshot];
        }),
        { concurrency: 1 },
      );
    },
    { concurrency: 1 },
  ).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new CrmReferenceIneligible({
          code: 'crm_reference_ineligible',
          reason: 'Záznam neodpovídá schématu CRM',
        }),
        'cause',
        { value: cause },
      ),
    ),
  );
  // Entity kinds contain per-id arrays with zero or one snapshot.
  const snapshotArrayDepth = 2;
  return byKind.flat(snapshotArrayDepth);
});

const entityMatchesSnapshot = (entity: Entity | undefined, snapshot: AiSnapshot['after']) => {
  if (entity === undefined) {
    return snapshot === undefined;
  }
  const encoded = entityWire(entity);
  return Option.isSome(encoded) && same(encoded.value, snapshot);
};

const proposalIsStale = (
  change: AiChange,
  current: { readonly changes: readonly AiChange[]; readonly state: CrmState },
) =>
  (change.proposedSnapshots ?? []).some((snapshot) => {
    // Follow this batch's exact applied snapshot chain from its original independent dry run.
    let expected = snapshot.before;
    const siblings = current.changes
      .filter((entry) => entry.batchId === change.batchId && entry.status === 'applied')
      .toSorted((left, right) => (left.applySequence ?? 0) - (right.applySequence ?? 0));
    for (const sibling of siblings) {
      const previous = sibling.snapshots?.find((entry) => entry.id === snapshot.id && entry.kind === snapshot.kind);
      if (previous !== undefined) {
        if (!same(expected, previous.before)) {
          return true;
        }
        expected = previous.after;
      }
    }
    return !entityMatchesSnapshot(
      collections[snapshot.kind].get(current.state).find((entity) => entity.id === snapshot.id),
      expected,
    );
  });

const decisionNoteSuffix = (note: string | undefined) =>
  note === undefined || note === '' ? '' : `. Poznámka: ${note}`;

// ------------------------------------------------------------------------------------------------ helpers

const sliceOf = (state: CrmState) => state.aiChanges ?? initialAiChangesSlice;
const withSlice = (state: CrmState, slice: ReturnType<typeof sliceOf>): CrmState => ({ ...state, aiChanges: slice });
const subContext = (context: CommandContext, suffix: string): CommandContext => ({
  ...context,
  invocationId: `${context.invocationId}-${suffix}`,
});
const logEntry = (
  context: CommandContext,
  index: number,
  entry: Omit<AiLogEntry, 'at' | 'id' | 'invocationId' | 'actorPrincipalId'>,
): AiLogEntry => ({
  ...entry,
  actorPrincipalId: context.viewer.principalId,
  at: context.now,
  id: newId(context, `ai-log-${index}`),
  invocationId: context.invocationId,
});
const failureReason = (failure: CrmCommandFailure) => failure.reason;

const replaceChange = (changes: readonly AiChange[], next: AiChange) =>
  changes.map((entry) => (entry.id === next.id ? next : entry));

// ------------------------------------------------------------------------------------------------ revert

interface RevertOutcome {
  readonly message: string;
  readonly ok: boolean;
  readonly state: CrmState;
}

interface SnapshotRestoration {
  readonly event?: ClientEvent;
  readonly pairing?: PairingChange;
  readonly state: CrmState;
}

const changedFields = (before: Entity, current: Entity | undefined): string[] => {
  const previous = new Map<string, unknown>(Object.entries(Option.getOrElse(entityWire(before), () => ({}))));
  const latest = new Map<string, unknown>(Object.entries(Option.getOrElse(entityWire(current), () => ({}))));
  return Object.keys({ ...before, ...current }).filter(
    (key) => key !== 'updatedAt' && !same(previous.get(key), latest.get(key)),
  );
};

const restoredEvent = (
  context: CommandContext,
  suffix: string,
  clientId: EntityId,
  kind: ClientEvent['kind'],
  subject: string,
  fields: readonly string[] = [],
): ClientEvent => {
  const event: ClientEvent = {
    at: context.now,
    by: context.viewer.principalId,
    clientId,
    id: newId(context, `ai-revert-${suffix}`),
    kind,
    subject,
  };
  if (fields.length > 0) {
    Object.assign(event, { fields });
  }
  return event;
};

/** Snapshot wire values stay generic JSON. Only restoration checks an owner's entity schema. */
const restoreSnapshot = (
  state: CrmState,
  snapshot: AiSnapshot,
  context: CommandContext,
  suffix: string,
  note: string,
): Option.Option<SnapshotRestoration> =>
  Match.value(snapshot.kind).pipe(
    Match.when('client', () => {
      const current = state.clients.items.find((entry) => entry.id === snapshot.id);
      if (snapshot.before === undefined) {
        if (current === undefined) {
          return Option.some({ state });
        }
        const archived: Client = { ...current, archivedAt: context.now, status: 'archived', updatedAt: context.now };
        Reflect.deleteProperty(archived, 'primary');
        return Option.some({
          event: restoredEvent(context, suffix, snapshot.id, 'client_archived', current.name),
          state: {
            ...state,
            clients: {
              ...state.clients,
              items: state.clients.items.map((entry) => (entry.id === snapshot.id ? archived : entry)),
            },
          },
        });
      }
      const decoded = Schema.decodeUnknownOption(ClientSchema)(snapshot.before);
      const original = Schema.decodeUnknownOption(SnapshotObjectSchema)(snapshot.before);
      if (Option.isNone(decoded) || Option.isNone(original) || decoded.value.id !== snapshot.id) {
        return Option.none();
      }
      const before: Client = { ...original.value, ...decoded.value };
      return Option.some({
        event: restoredEvent(
          context,
          suffix,
          snapshot.id,
          'client_updated',
          before.name,
          changedFields(before, current),
        ),
        state: {
          ...state,
          clients: {
            ...state.clients,
            items: state.clients.items.map((entry) => (entry.id === snapshot.id ? before : entry)),
          },
        },
      });
    }),
    Match.when('contact', () => {
      const current = state.clients.contacts.find((entry) => entry.id === snapshot.id);
      if (snapshot.before === undefined) {
        if (current === undefined) {
          return Option.some({ state });
        }
        const { primary: _primary, ...rest } = current;
        const archived: ContactPerson = {
          ...rest,
          archivedAt: context.now,
          status: 'archived',
          updatedAt: context.now,
        };
        return Option.some({
          event: restoredEvent(context, suffix, current.clientId, 'contact_removed', current.name),
          state: {
            ...state,
            clients: {
              ...state.clients,
              contacts: state.clients.contacts.map((entry) => (entry.id === snapshot.id ? archived : entry)),
            },
          },
        });
      }
      const decoded = Schema.decodeUnknownOption(ContactPersonSchema)(snapshot.before);
      const original = Schema.decodeUnknownOption(SnapshotObjectSchema)(snapshot.before);
      if (Option.isNone(decoded) || Option.isNone(original) || decoded.value.id !== snapshot.id) {
        return Option.none();
      }
      const before: ContactPerson = { ...original.value, ...decoded.value };
      return Option.some({
        event: restoredEvent(
          context,
          suffix,
          before.clientId,
          'contact_updated',
          before.name,
          changedFields(before, current),
        ),
        state: {
          ...state,
          clients: {
            ...state.clients,
            contacts: state.clients.contacts.map((entry) => (entry.id === snapshot.id ? before : entry)),
          },
        },
      });
    }),
    Match.when('order', () => {
      // CRM AI can pair an imported order, but cannot create or delete one.
      const decoded = Schema.decodeUnknownOption(ImportedOrderSchema)(snapshot.before);
      const original = Schema.decodeUnknownOption(SnapshotObjectSchema)(snapshot.before);
      if (Option.isNone(decoded) || Option.isNone(original) || decoded.value.id !== snapshot.id) {
        return Option.none();
      }
      const before: ImportedOrder = { ...original.value, ...decoded.value };
      const current = state.imports.orders.find((entry) => entry.id === snapshot.id);
      const pairing: PairingChange = {
        at: context.now,
        by: context.viewer.principalId,
        id: newId(context, `ai-revert-pairing-${suffix}`),
        orderId: snapshot.id,
        reason: note,
        via: 'manual',
      };
      if (current?.clientId !== undefined) {
        Object.assign(pairing, { fromClientId: current.clientId });
      }
      if (before.clientId !== undefined) {
        Object.assign(pairing, { toClientId: before.clientId });
      }
      return Option.some({
        pairing,
        state: {
          ...state,
          imports: {
            ...state.imports,
            orders: state.imports.orders.map((entry) => (entry.id === snapshot.id ? before : entry)),
          },
        },
      });
    }),
    Match.when('plan', () => {
      if (snapshot.before === undefined) {
        return Option.some({
          state: {
            ...state,
            visits: { ...state.visits, plan: state.visits.plan.filter((entry) => entry.id !== snapshot.id) },
          },
        });
      }
      const decoded = Schema.decodeUnknownOption(PlanItemSchema)(snapshot.before);
      const original = Schema.decodeUnknownOption(SnapshotObjectSchema)(snapshot.before);
      if (Option.isNone(decoded) || Option.isNone(original) || decoded.value.id !== snapshot.id) {
        return Option.none();
      }
      const before: PlanItem = { ...original.value, ...decoded.value };
      return Option.some({
        state: {
          ...state,
          visits: {
            ...state.visits,
            plan: state.visits.plan.map((entry) => (entry.id === snapshot.id ? before : entry)),
          },
        },
      });
    }),
    Match.exhaustive,
  );

/** Restores one applied change from its snapshots, newest entity first. Refuses when anything changed since. */
const revertChange = (
  state: CrmState,
  change: AiChange,
  context: CommandContext,
  suffix: string,
  note: string,
): RevertOutcome => {
  const snapshots = change.snapshots ?? [];
  const changedSince = snapshots.find((snapshot) => {
    const current = collections[snapshot.kind].get(state).find((entity) => entity.id === snapshot.id);
    return !entityMatchesSnapshot(current, snapshot.after);
  });
  if (changedSince !== undefined) {
    return {
      message: `${change.summary} (${change.target.label}): záznam se od schválení změnil, automaticky ho nevracím.`,
      ok: false,
      state,
    };
  }
  const createdClient = snapshots.find((entry) => entry.kind === 'client' && entry.before === undefined);
  if (
    createdClient !== undefined &&
    (state.visits.items.some((entry) => entry.clientId === createdClient.id) ||
      state.imports.orders.some((entry) => entry.clientId === createdClient.id) ||
      state.clients.contacts.some(
        (entry) =>
          entry.clientId === createdClient.id &&
          entry.status === 'active' &&
          !snapshots.some((snapshot) => snapshot.id === entry.id),
      ) ||
      state.visits.plan.some((entry) => entry.clientId === createdClient.id))
  ) {
    return { message: 'Nový klient má navazující záznamy. Nejprve vyřešte jejich vazby.', ok: false, state };
  }
  let next = state;
  const events: ClientEvent[] = [];
  const pairing: PairingChange[] = [];
  for (const [index, snapshot] of snapshots.toReversed().entries()) {
    const restored = restoreSnapshot(next, snapshot, context, `${suffix}-${index}`, note);
    if (Option.isNone(restored)) {
      return {
        message: `${change.summary} (${change.target.label}): snímek neodpovídá záznamu CRM, automaticky ho nevracím.`,
        ok: false,
        state,
      };
    }
    next = restored.value.state;
    if (restored.value.event !== undefined) {
      events.push(restored.value.event);
    }
    if (restored.value.pairing !== undefined) {
      pairing.push(restored.value.pairing);
    }
  }
  next = {
    ...next,
    clients: { ...next.clients, events: [...(next.clients.events ?? []), ...events] },
    imports: { ...next.imports, pairingHistory: [...next.imports.pairingHistory, ...pairing] },
  };
  return { message: `${change.summary} (${change.target.label}) vráceno do stavu před změnou.`, ok: true, state: next };
};

type AiProposal = Extract<AiChangesCommand, { readonly _tag: 'AiProposeChanges' }>['changes'][number];
interface ProposedChanges {
  readonly changes: readonly AiChange[];
  readonly log: readonly AiLogEntry[];
}
interface DecisionProgress {
  readonly log: readonly AiLogEntry[];
  readonly state: CrmState;
}
interface RevertProgress extends DecisionProgress {
  readonly changes: readonly AiChange[];
  readonly reverted: number;
}

// ------------------------------------------------------------------------------------------------ reducer

export const applyAiChangesCommand: Reducer<AiChangesCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag(
      'AiProposeChanges',
      Effect.fn('Crm.propose')(function* propose(
        value: Extract<AiChangesCommand, { readonly _tag: 'AiProposeChanges' }>,
      ) {
        const slice = sliceOf(state);
        const repeated =
          value.runId === undefined
            ? undefined
            : slice.batches.find(
                (batch) => batch.runId === value.runId && batch.agentPrincipalId === context.viewer.principalId,
              );
        if (repeated !== undefined) {
          const existing = slice.changes.filter((change) => change.batchId === repeated.id);
          if (
            repeated.instruction !== value.instruction ||
            !same(
              existing.map((change) => ({ operation: change.operation, reason: change.reason })),
              value.changes,
            )
          ) {
            return yield* conflict('Toto označení běhu už patří jinému návrhu. Pro nový návrh použijte nové runId.');
          }
          const ids = existing.map((change) => change.id);
          return { entityIds: [repeated.id, ...ids], state } satisfies CommandChange;
        }
        const batchId = newId(context, 'ai-batch');
        const batch: AiBatch = {
          agentLabel: value.agentLabel ?? 'AI agent',
          agentPrincipalId: context.viewer.principalId,
          createdAt: context.now,
          id: batchId,
          instruction: value.instruction,
        };
        if (value.runId !== undefined) {
          Object.assign(batch, { runId: value.runId });
        }
        const working = state;
        const { changes, log } = yield* Effect.reduce(
          value.changes,
          (): ProposedChanges => ({ changes: [], log: [] }),
          Effect.fn('Crm.proposeChange')(function* proposeChange(
            progress: ProposedChanges,
            proposal: AiProposal,
            index: number,
          ) {
            if (
              Predicate.isTagged(proposal.operation, 'PairOrder') &&
              proposal.operation.approveCustomerLink === true
            ) {
              return yield* invalid(
                'AI smí navrhnout párování jedné objednávky, ne trvalé propojení externího zákazníka.',
              );
            }
            const risk = riskOf(proposal.operation);
            const described = describe(working, proposal.operation);
            // Dry run as the agent: a proposal outside the agent's own scope is refused right away.
            const dryRun = yield* runOperation(working, proposal.operation, subContext(context, `c${index}`)).pipe(
              Effect.result,
            );
            if (Result.isFailure(dryRun)) {
              return yield* invalid(
                `Návrh č. ${index + 1} (${described.summary}) nelze přijmout: ${failureReason(dryRun.failure)}`,
              );
            }
            if (described.diff.length === 0) {
              return yield* invalid(`Návrh č. ${index + 1} (${described.summary}) nic nemění`);
            }
            let { target } = described;
            if (target.id === undefined && Predicate.isTagged(proposal.operation, 'CreateClient')) {
              const [createdId] = dryRun.success.entityIds;
              if (createdId === undefined) {
                return yield* invalid(missingProposalReason);
              }
              target = { ...target, id: createdId };
            }
            const base: AiChange = {
              batchId,
              diff: described.diff,
              id: newId(context, `ai-change-${index}`),
              operation: proposal.operation,
              proposedAt: context.now,
              proposedSnapshots: yield* snapshotsBetween(working, dryRun.success.state),
              reason: proposal.reason,
              risk,
              status: 'pending',
              summary: described.summary,
              target,
            };
            return {
              changes: [...progress.changes, base],
              log: [
                ...progress.log,
                logEntry(context, progress.log.length, {
                  action: 'proposed',
                  actorKind: 'agent',
                  batchId,
                  changeId: base.id,
                  message: `${batch.agentLabel} navrhl: ${base.summary} — ${base.target.label}. Důvod: ${proposal.reason}`,
                }),
              ],
            };
          }),
        );
        const current = sliceOf(working);
        return {
          entityIds: [batchId, ...changes.map((change) => change.id)],
          state: withSlice(working, {
            batches: [...current.batches, batch],
            changes: [...current.changes, ...changes],
            log: [...current.log, ...log],
          }),
        } satisfies CommandChange;
      }),
    ),
    Match.tag(
      'AiDecideChanges',
      Effect.fn('Crm.decide')(function* decide(value: Extract<AiChangesCommand, { readonly _tag: 'AiDecideChanges' }>) {
        yield* requireWriteAll(context);
        const progress = yield* Effect.reduce(
          value.changeIds,
          (): DecisionProgress => ({ log: [], state }),
          Effect.fn('Crm.decideChange')(function* decideChange(
            prior: DecisionProgress,
            changeId: EntityId,
            index: number,
          ) {
            let working = prior.state;
            const log = [...prior.log];
            const slice = sliceOf(working);
            const change = slice.changes.find((entry) => entry.id === changeId);
            if (change === undefined) {
              return yield* notFound(missingProposalReason);
            }
            if (change.status !== 'pending') {
              return yield* conflict(`Návrh „${change.summary} — ${change.target.label}“ už byl vyřízen`);
            }
            const decided: AiChange = {
              ...change,
              decidedAt: context.now,
              decidedBy: context.viewer.principalId,
            };
            if (value.note !== undefined && value.note !== '') {
              Object.assign(decided, { decisionNote: value.note });
            }
            if (value.decision === 'reject') {
              working = withSlice(working, {
                ...slice,
                changes: replaceChange(slice.changes, { ...decided, status: 'rejected' }),
              });
              log.push(
                logEntry(context, log.length, {
                  action: 'rejected',
                  actorKind: 'human',
                  batchId: change.batchId,
                  changeId,
                  message: `Zamítnuto: ${change.summary} — ${change.target.label}${decisionNoteSuffix(value.note)}`,
                }),
              );
              return { log, state: working };
            }
            if (proposalIsStale(change, { changes: slice.changes, state: working })) {
              return yield* conflict('Záznam se od návrhu změnil. Obnovte data a požádejte AI o nový návrh.');
            }
            const applied = yield* runOperation(working, change.operation, subContext(context, `a${index}`)).pipe(
              Effect.result,
            );
            if (Result.isFailure(applied)) {
              working = withSlice(working, {
                ...slice,
                changes: replaceChange(slice.changes, {
                  ...decided,
                  failure: failureReason(applied.failure),
                  status: 'failed',
                }),
              });
              log.push(
                logEntry(context, log.length, {
                  action: 'apply_failed',
                  actorKind: 'human',
                  batchId: change.batchId,
                  changeId,
                  message: `Schválení nešlo provést: ${change.summary} — ${change.target.label}: ${failureReason(applied.failure)}`,
                }),
              );
              return { log, state: working };
            }
            const snapshots = yield* snapshotsBetween(working, applied.success.state);
            const after = sliceOf(applied.success.state);
            const approved: AiChange = {
              ...decided,
              appliedAt: context.now,
              applySequence:
                slice.changes.filter((entry) => entry.status === 'applied' || entry.status === 'reverted').length + 1,
              snapshots,
              status: 'applied',
            };
            if (Predicate.isTagged(change.operation, 'CreateClient')) {
              const createdId = applied.success.entityIds[0] ?? change.target.id;
              if (createdId === undefined) {
                return yield* conflict(missingProposalReason);
              }
              Object.assign(approved, { target: { ...change.target, id: createdId } });
            }
            working = withSlice(applied.success.state, {
              ...after,
              changes: replaceChange(after.changes, approved),
            });
            log.push(
              logEntry(context, log.length, {
                action: 'approved',
                actorKind: 'human',
                batchId: change.batchId,
                changeId,
                message: `Schváleno a provedeno: ${change.summary} — ${change.target.label}${decisionNoteSuffix(value.note)}`,
              }),
            );
            return { log, state: working };
          }),
        );
        const { log, state: working } = progress;
        const slice = sliceOf(working);
        return {
          entityIds: [...value.changeIds],
          state: withSlice(working, { ...slice, log: [...slice.log, ...log] }),
        } satisfies CommandChange;
      }),
    ),
    Match.tag(
      'AiRevertBatch',
      Effect.fn('Crm.revertBatch')(function* revertBatch(
        value: Extract<AiChangesCommand, { readonly _tag: 'AiRevertBatch' }>,
      ) {
        yield* requireWriteAll(context);
        const slice = sliceOf(state);
        const batch = slice.batches.find((entry) => entry.id === value.batchId);
        if (batch === undefined) {
          return yield* notFound('Dávka AI změn neexistuje');
        }
        if (batch.revertedAt !== undefined) {
          return yield* conflict('Dávka už byla vrácena');
        }
        const note =
          value.note !== undefined && value.note.length >= 3
            ? value.note
            : `Vráceno: dávka AI „${batch.instruction.slice(0, 120)}“`;
        const applied = slice.changes
          .filter((change) => change.batchId === batch.id && change.status === 'applied')
          .toSorted((left, right) => (right.applySequence ?? 0) - (left.applySequence ?? 0));
        const restored = yield* Effect.reduce(
          applied,
          (): RevertProgress => ({ changes: slice.changes, log: [], reverted: 0, state }),
          Effect.fn('Crm.revertChange')(function* revertApplied(
            previous: RevertProgress,
            change: AiChange,
            index: number,
          ) {
            const outcome = revertChange(previous.state, change, context, `${index}`, note);
            if (!outcome.ok) {
              return yield* conflict(outcome.message);
            }
            return {
              changes: replaceChange(previous.changes, {
                ...change,
                revertedAt: context.now,
                revertedBy: context.viewer.principalId,
                status: 'reverted',
              }),
              log: [
                ...previous.log,
                logEntry(context, previous.log.length, {
                  action: 'reverted',
                  actorKind: 'human',
                  batchId: batch.id,
                  changeId: change.id,
                  message: outcome.message,
                }),
              ],
              reverted: previous.reverted + 1,
              state: outcome.state,
            };
          }),
        );
        const progress = yield* Effect.reduce(
          slice.changes.filter((entry) => entry.batchId === batch.id && entry.status === 'pending'),
          (): RevertProgress => restored,
          (previous, change) =>
            Effect.sync(() => ({
              ...previous,
              changes: replaceChange(previous.changes, {
                ...change,
                decidedAt: context.now,
                decidedBy: context.viewer.principalId,
                decisionNote: 'Zamítnuto při vrácení celé dávky',
                status: 'rejected',
              }),
              log: [
                ...previous.log,
                logEntry(context, previous.log.length, {
                  action: 'rejected',
                  actorKind: 'human',
                  batchId: batch.id,
                  changeId: change.id,
                  message: `Zamítnuto při vrácení dávky: ${change.summary} — ${change.target.label}`,
                }),
              ],
            })),
        );
        const { changes, reverted, state: working } = progress;
        const conflicts = applied.length - reverted;
        const conflictSuffix = conflicts > 0 ? `, ${conflicts} ponecháno (záznam se mezitím změnil)` : '';
        const log = [
          ...progress.log,
          logEntry(context, progress.log.length, {
            action: 'batch_reverted',
            actorKind: 'human',
            batchId: batch.id,
            message: `Vrátit vše: ${reverted} z ${applied.length} provedených změn vráceno${conflictSuffix}.`,
          }),
        ];
        const current = sliceOf(working);
        return {
          entityIds: [batch.id],
          state: withSlice(working, {
            batches: current.batches.map((entry) =>
              entry.id === batch.id
                ? { ...entry, revertedAt: context.now, revertedBy: context.viewer.principalId, revertNote: note }
                : entry,
            ),
            changes,
            log: [...current.log, ...log],
          }),
        } satisfies CommandChange;
      }),
    ),
    Match.exhaustive,
  );
