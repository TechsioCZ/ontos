// AI level C for orders (specs AGENT.md §3): the agent proposes order changes, a person approves them in
// /prodej/schvalovani-ai, and an applied batch can be reverted at once. The module-neutral engine lives in
// @app/shared-contracts/ai-approvals; this file plugs the merchandise state and reducer into it.
//
// Revert keeps the stock ledger honest: an order goes back to its previous values (its audit history keeps the
// reverted step plus the return), and every stock movement the change wrote gets a compensating movement.
import {
  AiAdapterFailure,
  AiContextSchema,
  AiFailure,
  decideAiChanges,
  proposeAiChanges,
  revertAiBatch,
} from '@app/shared-contracts/ai-approvals';
import type {
  AiApprovalAdapter,
  AiContext,
  AiEntity,
  AiDescribed,
  AiDiffLine,
  AiRisk,
} from '@app/shared-contracts/ai-approvals';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { Effect, Match, Result, Schema } from 'effect';
import type { DateTime } from 'effect';
import { merchandiseAiCommandSchemas, MerchandiseLifecycleConflict } from '../../shared/actions/apply-command.ts';
import type { MerchandiseAiOperation, MerchandiseCommand } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { OrderSchema, StockMovementIdSchema, StockMovementSchema } from '../../shared/domain/merchandise-model.ts';
import type { Order, OrderHistoryEntry, StockMovement } from '../../shared/domain/merchandise-model.ts';
import type {
  describeAddress,
  describeContact,
  describeLines,
  describeShipping,
  evolveMerchandiseState,
  orderStatusLabels,
} from './persistence.service.ts';
import { stockOnHandOf, variantStockOf } from './stock-levels.ts';

interface MerchandiseAiServices {
  readonly describeAddress: typeof describeAddress;
  readonly describeContact: typeof describeContact;
  readonly describeLines: typeof describeLines;
  readonly describeShipping: typeof describeShipping;
  readonly evolveMerchandiseState: typeof evolveMerchandiseState;
  readonly orderStatusLabels: typeof orderStatusLabels;
}

type AiCommand = Extract<
  MerchandiseCommand,
  { readonly _tag: 'AiDecideChanges' | 'AiProposeChanges' | 'AiRevertBatch' }
>;

export const isMerchandiseAiCommand = Schema.is(Schema.Union(merchandiseAiCommandSchemas));

const czk = (minor: number) =>
  `${(minor / 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2, minimumFractionDigits: 0 })} Kč`;

/** Reducer reasons are English contract texts; the approver and the agent read Czech. */
const czechReason = (reason: string): string => {
  const translated = {
    'Each product variant may appear only once in an order': 'Každá varianta produktu smí být v objednávce jen jednou.',
    'Only open orders before the carrier hand-over can be edited':
      'Upravit lze jen otevřenou objednávku před předáním dopravci.',
    'Order does not exist': 'Objednávka neexistuje.',
    'The requested order transition is not allowed': 'Tento přechod mezi stavy objednávky není povolen.',
  }[reason];
  if (translated !== undefined) {
    return translated;
  }
  if (reason.startsWith('Insufficient stock for ')) {
    return `Nedostatek zásob pro ${reason.slice('Insufficient stock for '.length)}.`;
  }
  if (reason.startsWith('Choose a variant of ')) {
    return `Vyberte variantu produktu ${reason.slice('Choose a variant of '.length)}.`;
  }
  return reason;
};

const orderLabel = (order: Order | undefined) => {
  if (order === undefined) {
    return 'Neznámá objednávka';
  }
  const contact = order.contact === undefined ? '' : ` · ${order.contact.name}`;
  return `Objednávka ${order.number}${contact}`;
};

const noNote = 'bez poznámky';

const diffLine = (field: string, label: string, before: string, after: string): readonly AiDiffLine[] =>
  before === after ? [] : [{ after, before, field, label }];

/** Before -> after lines from the order the reducer would produce (the same reducer approval runs). */
const orderDiff = (before: Order, after: Order, services: MerchandiseAiServices): readonly AiDiffLine[] => {
  const { describeAddress, describeContact, describeLines, describeShipping, orderStatusLabels } = services;
  return [
    ...diffLine('status', 'Stav', orderStatusLabels[before.status], orderStatusLabels[after.status]),
    ...diffLine('lines', 'Položky', describeLines(before), describeLines(after)),
    ...diffLine('total', 'Celkem s DPH', czk(before.totalMinor), czk(after.totalMinor)),
    ...diffLine('shipping', 'Doprava', describeShipping(before.shipping), describeShipping(after.shipping)),
    ...diffLine(
      'deliveryAddress',
      'Doručovací adresa',
      describeAddress(before.deliveryAddress),
      describeAddress(after.deliveryAddress),
    ),
    ...diffLine('contact', 'Kontakt', describeContact(before.contact), describeContact(after.contact)),
    ...diffLine('note', 'Poznámka', before.note ?? noNote, after.note ?? noNote),
  ];
};

const encodeOrder = Schema.encodeEffect(OrderSchema);
const decodeOrder = Schema.decodeUnknownEffect(OrderSchema);
const encodeMovement = Schema.encodeEffect(StockMovementSchema);
const decodeMovement = Schema.decodeUnknownEffect(StockMovementSchema);
const movementId = Schema.decodeEffect(StockMovementIdSchema);

const adapterFor = (
  actor: PrincipalRef,
  now: DateTime.Utc,
  services: MerchandiseAiServices,
): AiApprovalAdapter<MerchandiseState, MerchandiseAiOperation> => {
  const {
    describeAddress,
    describeContact,
    describeLines,
    describeShipping,
    evolveMerchandiseState,
    orderStatusLabels,
  } = services;
  const run = (state: MerchandiseState, operation: MerchandiseAiOperation, invocationId: string) =>
    evolveMerchandiseState(state, operation, { actor, now, resourceId: invocationId }).pipe(
      Effect.map((change) => ({ entityIds: change.entityIds, state: change.state })),
      Effect.mapError((cause) => new AiAdapterFailure({ cause, message: czechReason(cause.reason) })),
    );
  const describe = Effect.fn('MerchandiseAi.describe')(function* describeOrderOperation(
    state: MerchandiseState,
    operation: MerchandiseAiOperation,
  ): Effect.fn.Return<AiDescribed, AiAdapterFailure> {
    const before = state.orders.find((order) => order.id === operation.id);
    const summary = Match.value(operation).pipe(
      Match.tagsExhaustive({
        ChangeOrderStatus: () => 'Změna stavu objednávky',
        EditOrder: () => 'Úprava objednávky',
      }),
    );
    const target = { id: operation.id, kind: 'order', label: orderLabel(before) };
    const outcome = yield* run(state, operation, 'ai-describe').pipe(Effect.result);
    const after = Result.isSuccess(outcome)
      ? outcome.success.state.orders.find((order) => order.id === operation.id)
      : undefined;
    return {
      diff: before === undefined || after === undefined ? [] : orderDiff(before, after, services),
      summary,
      target,
    };
  });
  return {
    creates: () => false,
    describe,
    encode: Effect.fn('MerchandiseAi.encodeSnapshot')(function* encodeOrderSnapshot(
      kind: string,
      entity: AiEntity,
    ): Effect.fn.Return<Schema.Json, AiAdapterFailure> {
      if (kind === 'order') {
        return yield* Schema.decodeUnknownEffect(Schema.toType(OrderSchema))(entity).pipe(
          Effect.flatMap(encodeOrder),
          Effect.mapError((cause) => new AiAdapterFailure({ cause, message: 'Uložený stav objednávky nelze zapsat.' })),
        );
      }
      return yield* Schema.decodeUnknownEffect(Schema.toType(StockMovementSchema))(entity).pipe(
        Effect.flatMap(encodeMovement),
        Effect.mapError((cause) => new AiAdapterFailure({ cause, message: 'Skladový pohyb změny nelze zapsat.' })),
      );
    }),
    entities: (state, kind) => (kind === 'order' ? state.orders : state.movements),
    getSlice: (state) => state.aiChanges,
    kinds: ['order', 'movement'],
    restore: Effect.fn('MerchandiseAi.restore')(function* restoreOrderSnapshot(state, snapshot, context, note) {
      if (snapshot.kind === 'movement') {
        if (snapshot.before !== undefined || snapshot.after === undefined) {
          return state;
        }
        // Ledger rows are never removed: a compensating movement cancels the one the change wrote.
        const written = yield* decodeMovement(snapshot.after).pipe(
          Effect.mapError((cause) => new AiAdapterFailure({ cause, message: 'Skladový pohyb změny nelze přečíst.' })),
        );
        const delta = -written.delta;
        const stock =
          written.variantId === undefined
            ? stockOnHandOf(state.movements, written.productId)
            : variantStockOf(state.movements, written.productId, written.variantId);
        if (stock + delta < 0) {
          return yield* new AiAdapterFailure({
            cause: new MerchandiseLifecycleConflict({
              code: 'merchandise_lifecycle_conflict',
              reason: 'Na skladě už není dost kusů, aby šlo vrátit stav objednávky.',
            }),
            message: 'Na skladě už není dost kusů, aby šlo vrátit stav objednávky.',
          });
        }
        const compensation: StockMovement = {
          at: now,
          delta,
          id: yield* movementId(`${context.invocationId}:ai-revert:${context.suffix}`).pipe(
            Effect.mapError(
              (cause) => new AiAdapterFailure({ cause, message: 'Identitu skladového pohybu změny nelze vytvořit.' }),
            ),
          ),
          note: `Vrácení schválené změny AI: ${note}`.slice(0, 2000),
          productId: written.productId,
          reason: written.reason,
        };
        if (written.reference !== undefined) {
          Object.assign(compensation, { reference: written.reference });
        }
        if (written.variantId !== undefined) {
          Object.assign(compensation, { variantId: written.variantId });
        }
        return { ...state, movements: [...state.movements, compensation] };
      }
      if (snapshot.before === undefined) {
        return state;
      }
      const before = yield* decodeOrder(snapshot.before).pipe(
        Effect.mapError((cause) => new AiAdapterFailure({ cause, message: 'Uložený stav objednávky nelze obnovit.' })),
      );
      const current = state.orders.find((order) => order.id === snapshot.id);
      const reason = `Vrácení změny AI: ${note}`.slice(0, 500);
      const aspects: readonly [OrderHistoryEntry['kind'], (order: Order) => string][] = [
        ['STATUS', (order) => orderStatusLabels[order.status]],
        ['LINES', (order) => describeLines(order)],
        ['SHIPPING', (order) => describeShipping(order.shipping)],
        ['ADDRESS', (order) => describeAddress(order.deliveryAddress)],
        ['CONTACT', (order) => describeContact(order.contact)],
        ['NOTE', (order) => order.note ?? noNote],
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
    risk: (operation): AiRisk =>
      Match.value(operation).pipe(
        Match.tagsExhaustive({
          ChangeOrderStatus: (value) => (value.status === 'CANCELLED' ? 'high' : 'medium'),
          EditOrder: (value) => (value.lines !== undefined || value.shipping !== undefined ? 'high' : 'low'),
        }),
      ),
    run,
    setSlice: (state, slice) => ({ ...state, aiChanges: slice }),
  };
};

/** Runs one AI approval command against the state. Permission checks happen in persistence before this. */
export const applyMerchandiseAiCommand = Effect.fn('Merchandise.applyAiCommand')(function* applyAiCommand(
  state: MerchandiseState,
  command: AiCommand,
  context: { readonly actor: PrincipalRef; readonly invocationId: string; readonly now: DateTime.Utc },
  services: MerchandiseAiServices,
): Effect.fn.Return<{ readonly entityIds: readonly string[]; readonly state: MerchandiseState }, AiFailure> {
  const adapter = adapterFor(context.actor, context.now, services);
  const aiContext: AiContext = yield* Schema.decodeEffect(AiContextSchema)({
    invocationId: context.invocationId,
    now: context.now,
    principalId: context.actor.principalId,
  }).pipe(
    Effect.mapError((cause) => {
      const message = 'Kontext schvalování AI nelze přečíst.';
      return new AiFailure({ cause: new AiAdapterFailure({ cause, message }), kind: 'invalid', message });
    }),
  );
  return yield* Match.value(command).pipe(
    Match.tagsExhaustive({
      AiDecideChanges: (value) =>
        decideAiChanges(
          adapter,
          state,
          { changeIds: value.changeIds, decision: value.decision, note: value.note },
          aiContext,
        ),
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
});
