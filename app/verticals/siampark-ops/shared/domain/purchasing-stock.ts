// Pure stock computations over the purchasing ledger (S05). Used by the reducer (guards) and the UI (overview,
// material plan, replenishment suggestions). OWNED BY THE `purchasing` LANE (ops-purchasing).
import type {
  PurchaseOrder,
  PurchasingState,
  StockItem,
  StockItemId,
  StockMovement,
  StockWarehouseId,
} from './purchasing.ts';

/** Signed change of one movement for the given warehouse (transfers move stock between two warehouses). */
export const movementDeltaIn = (movement: StockMovement, warehouseId: StockWarehouseId): number => {
  if (movement.kind === 'transfer') {
    if (movement.warehouseId === warehouseId) {
      return movement.quantity;
    }
    return movement.fromWarehouseId === warehouseId ? -movement.quantity : 0;
  }
  return movement.warehouseId === warehouseId ? movement.quantity : 0;
};

/** Total change of one movement for the item (a transfer does not change the total). */
export const movementTotalDelta = (movement: StockMovement): number =>
  movement.kind === 'transfer' ? 0 : movement.quantity;

export const itemMovements = (state: Pick<PurchasingState, 'movements'>, itemId: StockItemId) =>
  state.movements.filter((movement) => movement.itemId === itemId);

/** Stock on hand of an item, computed from the stored ledger. */
export const onHandOf = (state: Pick<PurchasingState, 'movements'>, itemId: StockItemId): number =>
  itemMovements(state, itemId).reduce((sum, movement) => sum + movementTotalDelta(movement), 0);

export const onHandIn = (
  state: Pick<PurchasingState, 'movements'>,
  itemId: StockItemId,
  warehouseId: StockWarehouseId,
): number => itemMovements(state, itemId).reduce((sum, movement) => sum + movementDeltaIn(movement, warehouseId), 0);

/** Stock per warehouse (only warehouses with a non-zero balance or any movement). */
export const onHandByWarehouse = (
  state: Pick<PurchasingState, 'movements'>,
  itemId: StockItemId,
): ReadonlyMap<StockWarehouseId, number> => {
  const result = new Map<StockWarehouseId, number>();
  for (const movement of itemMovements(state, itemId)) {
    const touched =
      movement.kind === 'transfer' && movement.fromWarehouseId !== undefined
        ? [movement.warehouseId, movement.fromWarehouseId]
        : [movement.warehouseId];
    for (const warehouseId of touched) {
      result.set(warehouseId, (result.get(warehouseId) ?? 0) + movementDeltaIn(movement, warehouseId));
    }
  }
  return result;
};

/** Serial numbers currently in stock → warehouse where they are. */
export const serialsInStock = (
  state: Pick<PurchasingState, 'movements'>,
  itemId: StockItemId,
): ReadonlyMap<string, StockWarehouseId> => {
  const result = new Map<string, StockWarehouseId>();
  for (const movement of itemMovements(state, itemId)) {
    for (const serial of movement.serialNumbers ?? []) {
      if (movement.kind === 'transfer' || movement.quantity > 0) {
        result.set(serial, movement.warehouseId);
      } else {
        result.delete(serial);
      }
    }
  }
  return result;
};

/** Quantity of one batch (šarže) in a warehouse. */
export const batchQuantityIn = (
  state: Pick<PurchasingState, 'movements'>,
  itemId: StockItemId,
  batch: string,
  warehouseId: StockWarehouseId,
): number =>
  itemMovements(state, itemId)
    .filter((movement) => movement.batch === batch)
    .reduce((sum, movement) => sum + movementDeltaIn(movement, warehouseId), 0);

/** Batches with a positive balance per warehouse. */
export const batchesInStock = (
  state: Pick<PurchasingState, 'movements'>,
  itemId: StockItemId,
): ReadonlyArray<{ readonly batch: string; readonly warehouseId: StockWarehouseId; readonly quantity: number }> => {
  const totals = new Map<string, { batch: string; warehouseId: StockWarehouseId; quantity: number }>();
  for (const movement of itemMovements(state, itemId)) {
    if (movement.batch === undefined) {
      continue;
    }
    const touched =
      movement.kind === 'transfer' && movement.fromWarehouseId !== undefined
        ? [movement.warehouseId, movement.fromWarehouseId]
        : [movement.warehouseId];
    for (const warehouseId of touched) {
      const key = `${movement.batch}\u0000${warehouseId}`;
      const current = totals.get(key) ?? { batch: movement.batch, quantity: 0, warehouseId };
      current.quantity += movementDeltaIn(movement, warehouseId);
      totals.set(key, current);
    }
  }
  return [...totals.values()].filter((entry) => entry.quantity > 0);
};

/** Ordered but not yet received quantity of an item on open purchase orders. */
export const OPEN_ORDER_STATUSES: ReadonlySet<PurchaseOrder['status']> = new Set(['approved', 'ordered', 'partially_delivered']);

export const lineRemaining = (line: PurchaseOrder['lines'][number]) => Math.max(0, line.quantity - line.receivedQuantity);

export const orderRemainingQuantity = (order: PurchaseOrder) =>
  order.lines.reduce((sum, line) => sum + lineRemaining(line), 0);

export const orderTotalMinor = (order: Pick<PurchaseOrder, 'lines'>) =>
  order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);

export const orderOpenValueMinor = (order: PurchaseOrder) =>
  order.lines.reduce((sum, line) => sum + lineRemaining(line) * line.unitPriceMinor, 0);

export const expectedReceiptsOf = (state: Pick<PurchasingState, 'orders'>, itemId: StockItemId) =>
  state.orders
    .filter((order) => OPEN_ORDER_STATUSES.has(order.status))
    .flatMap((order) =>
      order.lines
        .filter((line) => line.itemId === itemId && lineRemaining(line) > 0)
        .map((line) => ({ expectedDate: order.expectedDate, order, quantity: lineRemaining(line) })),
    );

export const plannedIssuesOf = (state: Pick<PurchasingState, 'plannedIssues'>, itemId: StockItemId) =>
  state.plannedIssues.filter((entry) => entry.itemId === itemId && entry.status === 'planned');

export type StockLevel = 'below_minimum' | 'above_maximum' | 'ok';

/** S05-02: strictly below minimum (7 < 8) is „pod minimem“; equal to the minimum is fine. */
export const stockLevelOf = (item: Pick<StockItem, 'minimum' | 'maximum'>, onHand: number): StockLevel => {
  if (onHand < item.minimum) {
    return 'below_minimum';
  }
  return item.maximum > 0 && onHand > item.maximum ? 'above_maximum' : 'ok';
};

/** Adds whole days to a `YYYY-MM-DD` business date. */
export const addDays = (isoDate: string, days: number): string =>
  DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(`${isoDate}T12:00:00Z`), { days }));

export interface MaterialPlan {
  readonly item: StockItem;
  readonly onHand: number;
  readonly expectedReceipts: number;
  readonly plannedIssues: number;
  /** S05: plán = aktuální stav + očekávané příjmy − plánované výdeje. */
  readonly projected: number;
  readonly level: StockLevel;
  /** Rule-based replenishment: order up to the maximum when the projected stock falls below the minimum. */
  readonly suggestedQuantity: number;
  /**
   * Expected availability of the shortage: the latest open order's expected date when open orders cover the
   * planned issues, otherwise today + the item's manually stored lead time.
   */
  readonly availableFrom: string | undefined;
  readonly nextExpectedDate: string | undefined;
}

export const materialPlanOf = (state: PurchasingState, item: StockItem, today: string): MaterialPlan => {
  const onHand = onHandOf(state, item.id);
  const receipts = expectedReceiptsOf(state, item.id);
  const expectedReceipts = receipts.reduce((sum, entry) => sum + entry.quantity, 0);
  const plannedIssues = plannedIssuesOf(state, item.id).reduce((sum, entry) => sum + entry.quantity, 0);
  const projected = onHand + expectedReceipts - plannedIssues;
  const level = stockLevelOf(item, onHand);
  const target = Math.max(item.maximum, item.minimum);
  const suggestedQuantity = projected < item.minimum ? Math.max(0, target - projected) : 0;
  const dates = receipts.flatMap((entry) => (entry.expectedDate === undefined ? [] : [entry.expectedDate])).toSorted();
  const nextExpectedDate = dates[0];
  const short = onHand - plannedIssues < 0 || onHand <= 0;
  const coveredByOrders = projected >= 0 && dates.length > 0;
  const availableFrom = short ? (coveredByOrders ? dates.at(-1) : addDays(today, item.leadTimeDays)) : undefined;
  return {
    availableFrom,
    expectedReceipts,
    item,
    level,
    nextExpectedDate,
    onHand,
    plannedIssues,
    projected,
    suggestedQuantity,
  };
};

/** Sum of issued quantities per month (`YYYY-MM`) for the issue summary by period. */
export const issuesByMonth = (movements: readonly StockMovement[]): ReadonlyMap<string, number> => {
  const result = new Map<string, number>();
  for (const movement of movements) {
    if (movement.kind === 'issue') {
      const month = movement.date.slice(0, 7);
      result.set(month, (result.get(month) ?? 0) + Math.abs(movement.quantity));
    }
  }
  return result;
};
