// AI level C for orders (specs AGENT.md §3): the agent proposes order changes, a person approves them in
// /prodej/schvalovani-ai, and an applied batch can be reverted at once. The module-neutral engine lives in
// @app/shared-contracts/ai-approvals; this file plugs the merchandise state and reducer into it.
//
// Revert keeps the stock ledger honest: an order goes back to its previous values (its audit history keeps the
// reverted step plus the return), and every stock movement the change wrote gets a compensating movement.
import { decideAiChanges, proposeAiChanges, revertAiBatch } from '@app/shared-contracts/ai-approvals';
import type {
  AiApprovalAdapter,
  AiContext,
  AiDescribed,
  AiDiffLine,
  AiFailure,
  AiRisk,
  AiSlice,
} from '@app/shared-contracts/ai-approvals';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { DateTime, Effect, Exit, Match, Schema } from 'effect';
import type { MerchandiseAiOperation, MerchandiseCommand } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { OrderSchema, StockMovementIdSchema, StockMovementSchema } from '../../shared/domain/merchandise-model.ts';
import type { Order, OrderHistoryEntry, StockMovement } from '../../shared/domain/merchandise-model.ts';
import {
  describeAddress,
  describeContact,
  describeLines,
  describeShipping,
  evolveMerchandiseState,
  orderStatusLabels,
  stockOnHandOf,
  variantStockOf,
} from './persistence.service.ts';

type AiCommand = Extract<MerchandiseCommand, { readonly _tag: 'AiDecideChanges' | 'AiProposeChanges' | 'AiRevertBatch' }>;

export const isMerchandiseAiCommand = (command: MerchandiseCommand): command is AiCommand =>
  command._tag === 'AiProposeChanges' || command._tag === 'AiDecideChanges' || command._tag === 'AiRevertBatch';

const czk = (minor: number) =>
  `${(minor / 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2, minimumFractionDigits: 0 })} Kč`;

/** Reducer reasons are English contract texts; the approver and the agent read Czech. */
const czechReason = (reason: string): string =>
  ({
    'Each product variant may appear only once in an order': 'Každá varianta produktu smí být v objednávce jen jednou.',
    'Only open orders before the carrier hand-over can be edited':
      'Upravit lze jen otevřenou objednávku před předáním dopravci.',
    'Order does not exist': 'Objednávka neexistuje.',
    'The requested order transition is not allowed': 'Tento přechod mezi stavy objednávky není povolen.',
  })[reason] ??
  (reason.startsWith('Insufficient stock for ')
    ? `Nedostatek zásob pro ${reason.slice('Insufficient stock for '.length)}.`
    : reason.startsWith('Choose a variant of ')
      ? `Vyberte variantu produktu ${reason.slice('Choose a variant of '.length)}.`
      : reason);

const orderLabel = (order: Order | undefined) =>
  order === undefined ? 'Neznámá objednávka' : `Objednávka ${order.number}${order.contact === undefined ? '' : ` · ${order.contact.name}`}`;

const diffLine = (field: string, label: string, before: string, after: string): readonly AiDiffLine[] =>
  before === after ? [] : [{ after, before, field, label }];

/** Before -> after lines from the order the reducer would produce (the same reducer approval runs). */
const orderDiff = (before: Order, after: Order): readonly AiDiffLine[] => [
  ...diffLine('status', 'Stav', orderStatusLabels[before.status], orderStatusLabels[after.status]),
  ...diffLine('lines', 'Položky', describeLines(before), describeLines(after)),
  ...diffLine('total', 'Celkem s DPH', czk(before.totalMinor), czk(after.totalMinor)),
  ...diffLine('shipping', 'Doprava', describeShipping(before.shipping), describeShipping(after.shipping)),
  ...diffLine('deliveryAddress', 'Doručovací adresa', describeAddress(before.deliveryAddress), describeAddress(after.deliveryAddress)),
  ...diffLine('contact', 'Kontakt', describeContact(before.contact), describeContact(after.contact)),
  ...diffLine('note', 'Poznámka', before.note ?? 'bez poznámky', after.note ?? 'bez poznámky'),
];

const encodeOrder = Schema.encodeSync(OrderSchema);
const decodeOrder = Schema.decodeUnknownSync(OrderSchema);
const encodeMovement = Schema.encodeSync(StockMovementSchema);
const decodeMovement = Schema.decodeUnknownSync(StockMovementSchema);
const movementId = Schema.decodeSync(StockMovementIdSchema);

const adapterFor = (
  actor: PrincipalRef,
  now: DateTime.Utc,
): AiApprovalAdapter<MerchandiseState, MerchandiseAiOperation> => {
  const run = (state: MerchandiseState, operation: MerchandiseAiOperation, invocationId: string) =>
    evolveMerchandiseState(state, operation, { actor, now, resourceId: invocationId }).pipe(
      Effect.map((change) => ({ entityIds: change.entityIds, state: change.state })),
      Effect.mapError((failure) => czechReason(failure.reason)),
    );
  const describe = (state: MerchandiseState, operation: MerchandiseAiOperation): AiDescribed => {
    const before = state.orders.find((order) => order.id === operation.id);
    const summary = operation._tag === 'ChangeOrderStatus' ? 'Změna stavu objednávky' : 'Úprava objednávky';
    const target = { id: operation.id, kind: 'order', label: orderLabel(before) };
    const outcome = Effect.runSyncExit(run(state, operation, 'ai-describe'));
    const after = Exit.isSuccess(outcome)
      ? outcome.value.state.orders.find((order) => order.id === operation.id)
      : undefined;
    return { diff: before === undefined || after === undefined ? [] : orderDiff(before, after), summary, target };
  };
  return {
    creates: () => false,
    describe,
    encode: (kind, entity) =>
      kind === 'order' ? encodeOrder(entity as Order) : encodeMovement(entity as StockMovement),
    entities: (state, kind) => (kind === 'order' ? state.orders : state.movements),
    getSlice: (state) => state.aiChanges as AiSlice<MerchandiseAiOperation> | undefined,
    kinds: ['order', 'movement'],
    restore: (state, snapshot, context, note) =>
      Effect.gen(function* restore() {
        if (snapshot.kind === 'movement') {
          if (snapshot.before !== undefined || snapshot.after === undefined) return state;
          // Ledger rows are never removed: a compensating movement cancels the one the change wrote.
          const written = yield* Effect.try({
            catch: () => 'Skladový pohyb změny nelze přečíst.',
            try: () => decodeMovement(snapshot.after),
          });
          const delta = -written.delta;
          const stock =
            written.variantId === undefined
              ? stockOnHandOf(state.movements, written.productId)
              : variantStockOf(state.movements, written.productId, written.variantId);
          if (stock + delta < 0) {
            return yield* Effect.fail('Na skladě už není dost kusů, aby šlo vrátit stav objednávky.');
          }
          const compensation: StockMovement = {
            at: now,
            delta,
            id: movementId(`${context.invocationId}:ai-revert:${context.suffix}`),
            note: `Vrácení schválené změny AI: ${note}`.slice(0, 2000),
            productId: written.productId,
            reason: written.reason,
            ...(written.reference === undefined ? {} : { reference: written.reference }),
            ...(written.variantId === undefined ? {} : { variantId: written.variantId }),
          };
          return { ...state, movements: [...state.movements, compensation] };
        }
        if (snapshot.before === undefined) return state;
        const before = yield* Effect.try({
          catch: () => 'Uložený stav objednávky nelze obnovit.',
          try: () => decodeOrder(snapshot.before),
        });
        const current = state.orders.find((order) => order.id === snapshot.id);
        const reason = `Vrácení změny AI: ${note}`.slice(0, 500);
        const aspects: readonly [OrderHistoryEntry['kind'], (order: Order) => string][] = [
          ['STATUS', (order) => orderStatusLabels[order.status]],
          ['LINES', (order) => describeLines(order)],
          ['SHIPPING', (order) => describeShipping(order.shipping)],
          ['ADDRESS', (order) => describeAddress(order.deliveryAddress)],
          ['CONTACT', (order) => describeContact(order.contact)],
          ['NOTE', (order) => order.note ?? 'bez poznámky'],
        ];
        // One audited entry per aspect the revert changes back, exactly like a manual edit.
        const entries: OrderHistoryEntry[] =
          current === undefined
            ? []
            : aspects.flatMap(([kind, text]) =>
                text(current) === text(before)
                  ? []
                  : [{ actor, after: text(before), at: now, before: text(current), kind, reason }],
              );
        const restored: Order = {
          ...before,
          history: [...(current?.history ?? before.history ?? []), ...entries],
          updatedAt: now,
        };
        return { ...state, orders: state.orders.map((order) => (order.id === restored.id ? restored : order)) };
      }),
    run,
    risk: (operation): AiRisk =>
      operation._tag === 'ChangeOrderStatus'
        ? operation.status === 'CANCELLED'
          ? 'high'
          : 'medium'
        : operation.lines !== undefined || operation.shipping !== undefined
          ? 'high'
          : 'low',
    setSlice: (state, slice) => ({ ...state, aiChanges: slice as MerchandiseState['aiChanges'] & object }),
  };
};

/** Runs one AI approval command against the state. Permission checks happen in persistence before this. */
export const applyMerchandiseAiCommand = (
  state: MerchandiseState,
  command: AiCommand,
  context: { readonly actor: PrincipalRef; readonly invocationId: string; readonly now: DateTime.Utc },
): Effect.Effect<{ readonly entityIds: readonly string[]; readonly state: MerchandiseState }, AiFailure> => {
  const adapter = adapterFor(context.actor, context.now);
  const aiContext: AiContext = {
    invocationId: context.invocationId,
    now: DateTime.formatIso(context.now),
    principalId: context.actor.principalId,
  };
  return Match.value(command).pipe(
    Match.tagsExhaustive({
      AiDecideChanges: (value) =>
        decideAiChanges(adapter, state, { changeIds: value.changeIds, decision: value.decision, note: value.note }, aiContext),
      AiProposeChanges: (value) =>
        proposeAiChanges(
          adapter,
          state,
          {
            agentLabel: value.agentLabel ?? 'AI agent',
            changes: value.changes,
            instruction: value.instruction,
            runId: value.runId,
          },
          aiContext,
        ),
      AiRevertBatch: (value) => revertAiBatch(adapter, state, { batchId: value.batchId, note: value.note }, aiContext),
    }),
  );
};
