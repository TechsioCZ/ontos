// Siampark provoz — commands of agenda `purchasing` (S05 sklad a zásoby + S06 nákupní objednávky).
// OWNED BY THE `purchasing` LANE. To add a command: append a Schema.TaggedStruct to `purchasingCommandSchemas`
// (tag must be globally unique, prefix it like `StockItem…`), then handle it in `evolvePurchasing`.
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
import { Effect, Match, Schema } from 'effect';
import { auditCreated, defineAgenda, entityIdOf, mintId, NoteSchema, opsConflict, PropertyRefSchema, TextSchema } from '../domain/common.ts';
import type { OpsCommandInput } from '../domain/common.ts';
import { PurchasingStateSchema, StockItemIdSchema, emptyPurchasingState } from '../domain/purchasing.ts';
import type { PurchasingState, StockItem } from '../domain/purchasing.ts';

export const purchasingCommandSchemas = [
  Schema.TaggedStruct('StockItemCreate', {
    sku: TextSchema(64),
    name: TextSchema(200),
    unit: TextSchema(16),
    location: Schema.optionalKey(PropertyRefSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
] as const;

export const PurchasingCommandSchema = Schema.Union(purchasingCommandSchemas);
export type PurchasingCommand = typeof PurchasingCommandSchema.Type;
type CommandOf<Tag extends PurchasingCommand['_tag']> = Extract<PurchasingCommand, { readonly _tag: Tag }>;

const createStockItem = Effect.fn('SiamparkOps.Purchasing.create')(function* createStockItem(
  state: PurchasingState,
  value: CommandOf<'StockItemCreate'>,
  input: OpsCommandInput,
) {
  if (state.items.some((entry) => entry.sku.toLowerCase() === value.sku.toLowerCase())) {
    return yield* opsConflict('A stock item with this SKU already exists');
  }
  const id = yield* mintId(StockItemIdSchema, input.resourceId);
  const { _tag, ...fields } = value;
  void _tag;
  const record: StockItem = { ...fields, ...auditCreated(input), id };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, items: [...state.items, record] } };
});

/** Pure reducer: applies one command to the `purchasing` state. Persistence decides when it is saved. */
export const evolvePurchasing = (state: PurchasingState, command: PurchasingCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('StockItemCreate', (value) => createStockItem(state, value, input)),
    Match.exhaustive,
  );

export const purchasingAgenda = defineAgenda({
  commandSchema: PurchasingCommandSchema,
  empty: emptyPurchasingState,
  evolve: evolvePurchasing,
  id: 'purchasing',
  sensitivity: 'restricted',
  stateSchema: PurchasingStateSchema,
});
