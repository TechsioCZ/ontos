// AREA: AI level C (specs AGENT.md) — owned by the ai-level-c lane. Command schemas + reducer.
//
//   AiProposeChanges  agent (API key): one pending batch of proposals. Every item waits for human approval. Every proposal is dry-run against the current state first, so the agent learns at
//                     once when it is outside its scope (e.g. reassigning a client needs demo.crm.assign).
//   AiDecideChanges   human with write_all: approve (applies the stored operation as the approver) or reject.
//   AiRevertBatch     human with write_all: restores every applied change of one batch from its snapshots
//                     (only when nobody changed the entity since); pending proposals of the batch are rejected.
//
// The command guard lets API keys run ONLY AiProposeChanges in demo.crm; decisions and reverts are human-only.
import { Effect, Match, Schema } from 'effect';
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
import { AiOperationSchema, initialAiChangesSlice, newClientContactsDiff } from '../domain/ai-changes.ts';
import type { Client, ClientEvent, ContactPerson } from '../domain/clients.ts';
import { EntityIdSchema, LongTextSchema, ShortTextSchema } from '../domain/common.ts';
import type { ImportedOrder, PairingChange } from '../domain/imports.ts';
import type { CrmState } from '../domain/state.ts';
import type { PlanItem } from '../domain/visits.ts';
import { applyClientsCommand } from './clients.ts';
import type { CommandChange, CommandContext, CrmCommandFailure, Reducer } from './context.ts';
import { conflict, invalid, newId, notFound, requireWriteAll } from './context.ts';
import { applyImportsCommand } from './imports.ts';
import { applyVisitsCommand } from './visits.ts';

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

/** Commands an API key may run in demo.crm (the command guard enforces it). */
export const nonHumanAllowedCrmCommands: ReadonlySet<string> = new Set(['AiProposeChanges']);
/** Commands reserved for people. */
export const aiHumanOnlyCommands: readonly string[] = ['AiDecideChanges', 'AiRevertBatch'];

// ------------------------------------------------------------------------------------------------ operations

/** Runs one stored operation through the owning area's reducer (all its checks apply). */
const runOperation = (state: CrmState, operation: AiOperation, context: CommandContext) =>
  Match.value(operation).pipe(
    Match.tags({
      AssignClient: (value) => applyClientsCommand(state, value, context),
      AddContactPerson: (value) => applyClientsCommand(state, value, context),
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
      AssignClient: (): AiRisk => 'high',
      AddContactPerson: (): AiRisk => 'low',
      CreateClient: (): AiRisk => 'medium',
      PairOrder: (): AiRisk => 'high',
      PlanContact: (): AiRisk => 'low',
      UnpairOrder: (): AiRisk => 'high',
      UpdateClient: (value): AiRisk =>
        ['name', 'regNo', 'vatNo', 'kind'].some((key) => (value.patch as Record<string, unknown>)[key] !== undefined)
          ? 'high'
          : 'medium',
      UpdateContactPerson: (): AiRisk => 'medium',
    }),
    Match.exhaustive,
  );

const fieldLabels: Record<string, string> = {
  address: 'Adresa',
  clientId: 'Klient',
  contacts: 'Kontaktní osoby',
  dueDate: 'Ozvat se dne',
  email: 'E-mail',
  kind: 'Typ klienta',
  name: 'Název / jméno',
  note: 'Poznámka',
  pairing: 'Stav párování',
  phone: 'Telefon',
  primary: 'Hlavní kontakt',
  regNo: 'IČO',
  role: 'Role',
  salespersonId: 'Obchodník',
  ownerSalespersonId: 'Přidělený obchodník',
  segment: 'Segment',
  vatNo: 'DIČ',
  website: 'Web',
};
const segmentLabels: Record<string, string> = {
  bakery: 'Pekárna / výrobna',
  cafe: 'Kavárna / cukrárna',
  catering: 'Catering',
  hotel: 'Hotel',
  institution: 'Instituce / jídelna',
  restaurant: 'Restaurace',
  retail: 'Maloobchod',
  wholesale: 'Velkoobchod',
};
const pairingLabels: Record<string, string> = { paired: 'Napárováno', review: 'Ke kontrole', unpaired: 'Nenapárováno' };

const display = (state: CrmState, key: string, value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value ? 'ano' : 'ne';
  }
  const text = String(value);
  if (key === 'segment') {
    return segmentLabels[text] ?? text;
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
    return pairingLabels[text] ?? text;
  }
  return text;
};

const line = (state: CrmState, field: string, before: unknown, after: unknown): AiDiffLine | undefined => {
  const from = display(state, field, before);
  const to = after === '' ? undefined : display(state, field, after);
  if (from === to) {
    return undefined;
  }
  return {
    ...(from === undefined ? {} : { before: from }),
    ...(to === undefined ? {} : { after: to }),
    field,
    label: fieldLabels[field] ?? field,
  };
};

const patchLines = (state: CrmState, current: Record<string, unknown>, patch: Record<string, unknown>) =>
  Object.entries(patch).flatMap(([field, value]) => {
    if (value === undefined) {
      return [];
    }
    const entry = line(state, field, current[field], value);
    return entry === undefined ? [] : [entry];
  });

const newValueLines = (state: CrmState, values: Record<string, unknown>) =>
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
  const clientTarget = (id: string): AiChange['target'] => ({
    id,
    kind: 'client',
    label: clientOf(id)?.name ?? 'Neznámý klient',
  });
  return Match.value(operation).pipe(
    Match.tags({
      AssignClient: (value): Described => ({
        diff: [
          line(state, 'ownerSalespersonId', clientOf(value.clientId)?.ownerSalespersonId, value.toSalespersonId ?? ''),
        ].filter((entry): entry is AiDiffLine => entry !== undefined),
        summary: 'Přidělení klienta obchodníkovi',
        target: clientTarget(value.clientId),
      }),
      AddContactPerson: ({ _tag, clientId, ...values }): Described => ({
        diff: newValueLines(state, values),
        summary: 'Nová kontaktní osoba',
        target: clientTarget(clientId),
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
          diff: patchLines(state, (client ?? {}) as Record<string, unknown>, value.patch),
          summary: 'Úprava údajů klienta',
          target: clientTarget(value.id),
        };
      },
      UpdateContactPerson: (value): Described => {
        const contact = state.clients.contacts.find((entry) => entry.id === value.contactId);
        const client = contact === undefined ? undefined : clientOf(contact.clientId);
        return {
          diff: patchLines(state, (contact ?? {}) as Record<string, unknown>, value.patch),
          summary: 'Úprava kontaktní osoby',
          target: {
            id: value.contactId,
            kind: 'contact',
            label:
              contact === undefined
                ? 'Neznámá kontaktní osoba'
                : `${contact.name}${client === undefined ? '' : ` · ${client.name}`}`,
          },
        };
      },
    }),
    Match.exhaustive,
  );
};

// ------------------------------------------------------------------------------------------------ snapshots

interface Entity {
  readonly id: string;
}
interface Collection {
  readonly get: (state: CrmState) => readonly Entity[];
  readonly set: (state: CrmState, items: readonly Entity[]) => CrmState;
}
const collections: Record<AiEntityKind, Collection> = {
  client: {
    get: (state) => state.clients.items,
    set: (state, items) => ({ ...state, clients: { ...state.clients, items: items as readonly Client[] } }),
  },
  contact: {
    get: (state) => state.clients.contacts,
    set: (state, items) => ({ ...state, clients: { ...state.clients, contacts: items as readonly ContactPerson[] } }),
  },
  order: {
    get: (state) => state.imports.orders,
    set: (state, items) => ({ ...state, imports: { ...state.imports, orders: items as readonly ImportedOrder[] } }),
  },
  plan: {
    get: (state) => state.visits.plan,
    set: (state, items) => ({ ...state, visits: { ...state.visits, plan: items as readonly PlanItem[] } }),
  },
};
const entityKinds: readonly AiEntityKind[] = ['client', 'contact', 'order', 'plan'];
/** JSONB reorders object keys on persistence; snapshots must compare values, not insertion order. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Every entity the change created or modified, with its exact previous and next value. */
const snapshotsBetween = (previous: CrmState, next: CrmState): readonly AiSnapshot[] =>
  entityKinds.flatMap((kind) => {
    const before = new Map(collections[kind].get(previous).map((entity) => [entity.id, entity] as const));
    return collections[kind].get(next).flatMap((entity): AiSnapshot[] => {
      const old = before.get(entity.id);
      if (old !== undefined && same(old, entity)) {
        return [];
      }
      return [{ ...(old === undefined ? {} : { before: old }), after: entity, id: entity.id, kind }];
    });
  });

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
  readonly state: CrmState;
  readonly ok: boolean;
  readonly message: string;
}

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
    return !same(current, snapshot.after);
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
    return { state, ok: false, message: 'Nový klient má navazující záznamy. Nejprve vyřešte jejich vazby.' };
  }
  let next = state;
  const events: ClientEvent[] = [];
  const pairing: PairingChange[] = [];
  snapshots.toReversed().forEach((snapshot, index) => {
    const collection = collections[snapshot.kind];
    const items = collection.get(next);
    const current = items.find((entity) => entity.id === snapshot.id) as Record<string, unknown> | undefined;
    const eventBase = {
      at: context.now,
      by: context.viewer.principalId,
      id: newId(context, `ai-revert-${suffix}-${index}`),
    };
    if (snapshot.before === undefined) {
      // Created by the change: clients and contacts are archived (CRM never deletes), plan items removed.
      if (snapshot.kind === 'plan') {
        next = collection.set(
          next,
          items.filter((entity) => entity.id !== snapshot.id),
        );
        return;
      }
      if (current === undefined) {
        return;
      }
      const { primary: _primary, ...rest } = current;
      const archived = {
        ...rest,
        archivedAt: context.now,
        status: 'archived',
        updatedAt: context.now,
      } as unknown as Entity;
      next = collection.set(
        next,
        items.map((entity) => (entity.id === snapshot.id ? archived : entity)),
      );
      const clientId = snapshot.kind === 'client' ? snapshot.id : String(current['clientId'] ?? '');
      events.push({
        ...eventBase,
        clientId,
        kind: snapshot.kind === 'client' ? 'client_archived' : 'contact_removed',
        subject: String(current['name'] ?? ''),
      });
      return;
    }
    const before = snapshot.before as Entity & Record<string, unknown>;
    next = collection.set(
      next,
      items.map((entity) => (entity.id === snapshot.id ? before : entity)),
    );
    const fields = Object.keys({ ...before, ...current }).filter(
      (key) => key !== 'updatedAt' && !same(before[key], current?.[key]),
    );
    if (snapshot.kind === 'client' || snapshot.kind === 'contact') {
      events.push({
        ...eventBase,
        clientId: snapshot.kind === 'client' ? snapshot.id : String(before['clientId'] ?? ''),
        ...(fields.length === 0 ? {} : { fields }),
        kind: snapshot.kind === 'client' ? 'client_updated' : 'contact_updated',
        subject: String(before['name'] ?? ''),
      });
    }
    if (snapshot.kind === 'order') {
      const from = current?.['clientId'];
      const to = before['clientId'];
      pairing.push({
        ...(typeof from === 'string' ? { fromClientId: from } : {}),
        ...(typeof to === 'string' ? { toClientId: to } : {}),
        at: context.now,
        by: context.viewer.principalId,
        id: newId(context, `ai-revert-pairing-${suffix}-${index}`),
        orderId: snapshot.id,
        reason: note,
        via: 'manual',
      });
    }
  });
  next = {
    ...next,
    clients: { ...next.clients, events: [...(next.clients.events ?? []), ...events] },
    imports: { ...next.imports, pairingHistory: [...next.imports.pairingHistory, ...pairing] },
  };
  return { message: `${change.summary} (${change.target.label}) vráceno do stavu před změnou.`, ok: true, state: next };
};

// ------------------------------------------------------------------------------------------------ reducer

export const applyAiChangesCommand: Reducer<AiChangesCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag('AiProposeChanges', (value) =>
      Effect.gen(function* propose() {
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
          const ids = slice.changes.filter((change) => change.batchId === repeated.id).map((change) => change.id);
          return { entityIds: [repeated.id, ...ids], state } satisfies CommandChange;
        }
        const batchId = newId(context, 'ai-batch');
        const batch: AiBatch = {
          agentLabel: value.agentLabel ?? 'AI agent',
          agentPrincipalId: context.viewer.principalId,
          createdAt: context.now,
          id: batchId,
          instruction: value.instruction,
          ...(value.runId === undefined ? {} : { runId: value.runId }),
        };
        let working = state;
        const changes: AiChange[] = [];
        const log: AiLogEntry[] = [];
        for (const [index, proposal] of value.changes.entries()) {
          if (proposal.operation._tag === 'PairOrder' && proposal.operation.approveCustomerLink === true) {
            return yield* invalid(
              'AI smí navrhnout párování jedné objednávky, ne trvalé propojení externího zákazníka.',
            );
          }
          const risk = riskOf(proposal.operation);
          const described = describe(working, proposal.operation);
          // Dry run as the agent: a proposal outside the agent's own scope is refused right away.
          const dryRun = yield* runOperation(working, proposal.operation, subContext(context, `c${index}`)).pipe(
            Effect.mapError((failure) => new Error(failureReason(failure))),
            Effect.result,
          );
          if (dryRun._tag === 'Failure') {
            return yield* invalid(
              `Návrh č. ${index + 1} (${described.summary}) nelze přijmout: ${dryRun.failure.message}`,
            );
          }
          if (described.diff.length === 0) {
            return yield* invalid(`Návrh č. ${index + 1} (${described.summary}) nic nemění`);
          }
          const base: AiChange = {
            batchId,
            proposedSnapshots: snapshotsBetween(working, dryRun.success.state),
            diff: described.diff,
            id: newId(context, `ai-change-${index}`),
            operation: proposal.operation,
            proposedAt: context.now,
            reason: proposal.reason,
            risk,
            status: 'pending',
            summary: described.summary,
            target:
              described.target.id === undefined && proposal.operation._tag === 'CreateClient'
                ? { ...described.target, id: dryRun.success.entityIds[0] ?? '' }
                : described.target,
          };
          log.push(
            logEntry(context, log.length, {
              action: 'proposed',
              actorKind: 'agent',
              batchId,
              changeId: base.id,
              message: `${batch.agentLabel} navrhl: ${base.summary} — ${base.target.label}. Důvod: ${proposal.reason}`,
            }),
          );
          changes.push(base);
        }
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
    Match.tag('AiDecideChanges', (value) =>
      Effect.gen(function* decide() {
        yield* requireWriteAll(context);
        let working = state;
        const log: AiLogEntry[] = [];
        for (const [index, changeId] of value.changeIds.entries()) {
          const slice = sliceOf(working);
          const change = slice.changes.find((entry) => entry.id === changeId);
          if (change === undefined) {
            return yield* notFound('Návrh AI neexistuje');
          }
          if (change.status !== 'pending') {
            return yield* conflict(`Návrh „${change.summary} — ${change.target.label}“ už byl vyřízen`);
          }
          const decided = {
            ...change,
            decidedAt: context.now,
            decidedBy: context.viewer.principalId,
            ...(value.note === undefined || value.note === '' ? {} : { decisionNote: value.note }),
          };
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
                message: `Zamítnuto: ${change.summary} — ${change.target.label}${value.note !== undefined && value.note !== '' ? `. Poznámka: ${value.note}` : ''}`,
              }),
            );
            continue;
          }
          const stale = (change.proposedSnapshots ?? []).some((snapshot) => {
            // Proposals are independent dry runs against the same original state. An approved sibling
            // may already have changed this entity. Follow only that batch's exact applied snapshot
            // chain, never arbitrary current values or another batch's edits.
            let expected = snapshot.before;
            const siblings = slice.changes
              .filter((entry) => entry.batchId === change.batchId && entry.status === 'applied')
              .toSorted((left, right) => (left.applySequence ?? 0) - (right.applySequence ?? 0));
            for (const sibling of siblings) {
              const previous = sibling.snapshots?.find(
                (entry) => entry.id === snapshot.id && entry.kind === snapshot.kind,
              );
              if (previous !== undefined) {
                if (!same(expected, previous.before)) return true;
                expected = previous.after;
              }
            }
            return !same(
              collections[snapshot.kind].get(working).find((entity) => entity.id === snapshot.id),
              expected,
            );
          });
          if (stale) {
            return yield* conflict('Záznam se od návrhu změnil. Obnovte data a požádejte AI o nový návrh.');
          }
          const applied = yield* runOperation(working, change.operation, subContext(context, `a${index}`)).pipe(
            Effect.result,
          );
          if (applied._tag === 'Failure') {
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
            continue;
          }
          const snapshots = snapshotsBetween(working, applied.success.state);
          const after = sliceOf(applied.success.state);
          working = withSlice(applied.success.state, {
            ...after,
            changes: replaceChange(after.changes, {
              ...decided,
              ...(change.operation._tag === 'CreateClient'
                ? { target: { ...change.target, id: applied.success.entityIds[0] ?? change.target.id ?? '' } }
                : {}),
              appliedAt: context.now,
              applySequence:
                slice.changes.filter((entry) => entry.status === 'applied' || entry.status === 'reverted').length + 1,
              snapshots,
              status: 'applied',
            }),
          });
          log.push(
            logEntry(context, log.length, {
              action: 'approved',
              actorKind: 'human',
              batchId: change.batchId,
              changeId,
              message: `Schváleno a provedeno: ${change.summary} — ${change.target.label}${value.note !== undefined && value.note !== '' ? `. Poznámka: ${value.note}` : ''}`,
            }),
          );
        }
        const slice = sliceOf(working);
        return {
          entityIds: [...value.changeIds],
          state: withSlice(working, { ...slice, log: [...slice.log, ...log] }),
        } satisfies CommandChange;
      }),
    ),
    Match.tag('AiRevertBatch', (value) =>
      Effect.gen(function* revertBatch() {
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
        let working = state;
        const log: AiLogEntry[] = [];
        let changes = slice.changes;
        const applied = slice.changes
          .filter((change) => change.batchId === batch.id && change.status === 'applied')
          .toSorted((left, right) => (right.applySequence ?? 0) - (left.applySequence ?? 0));
        let reverted = 0;
        for (const [index, change] of applied.entries()) {
          const outcome = revertChange(working, change, context, `${index}`, note);
          if (!outcome.ok) {
            return yield* conflict(outcome.message);
          }
          working = outcome.state;
          if (outcome.ok) {
            reverted += 1;
            changes = replaceChange(changes, {
              ...change,
              revertedAt: context.now,
              revertedBy: context.viewer.principalId,
              status: 'reverted',
            });
          }
          log.push(
            logEntry(context, log.length, {
              action: outcome.ok ? 'reverted' : 'revert_conflict',
              actorKind: 'human',
              batchId: batch.id,
              changeId: change.id,
              message: outcome.message,
            }),
          );
        }
        for (const change of slice.changes.filter(
          (entry) => entry.batchId === batch.id && entry.status === 'pending',
        )) {
          changes = replaceChange(changes, {
            ...change,
            decidedAt: context.now,
            decidedBy: context.viewer.principalId,
            decisionNote: 'Zamítnuto při vrácení celé dávky',
            status: 'rejected',
          });
          log.push(
            logEntry(context, log.length, {
              action: 'rejected',
              actorKind: 'human',
              batchId: batch.id,
              changeId: change.id,
              message: `Zamítnuto při vrácení dávky: ${change.summary} — ${change.target.label}`,
            }),
          );
        }
        const conflicts = applied.length - reverted;
        log.push(
          logEntry(context, log.length, {
            action: 'batch_reverted',
            actorKind: 'human',
            batchId: batch.id,
            message: `Vrátit vše: ${reverted} z ${applied.length} provedených změn vráceno${conflicts > 0 ? `, ${conflicts} ponecháno (záznam se mezitím změnil)` : ''}.`,
          }),
        );
        const current = sliceOf(working);
        return {
          entityIds: [batch.id],
          state: withSlice(working, {
            batches: current.batches.map((entry) =>
              entry.id === batch.id
                ? { ...entry, revertNote: note, revertedAt: context.now, revertedBy: context.viewer.principalId }
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
