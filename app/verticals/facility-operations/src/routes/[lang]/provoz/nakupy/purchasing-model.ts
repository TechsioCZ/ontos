// Browser helpers of the Sklad a nákupy page (ops-purchasing lane).
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import { formatDateTime, formatMoney, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DateTime, Effect, Result, Schema } from 'effect';
import { PurchaseOrderHistorySchema } from '../../../../../shared/domain/purchasing.ts';
import { useEffect, useState } from 'react';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type {
  PurchaseOrder,
  PurchasingState,
  StockItem,
  StockRef,
  Supplier,
  StockWarehouse,
} from '../../../../../shared/domain/purchasing.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CommandOutcome, FailureReason } from '../../../../ui/use-agenda.ts';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { quantityUnitLabel } from '../../../../ui/quantity-unit.ts';

export type RunCommand = (command: OpsCommand) => Effect.Effect<CommandOutcome>;

/** Translator scoped to `facility-operations.purchasing.*`. */
export const usePurchasingT = () => {
  const { t } = useModernI18n();
  return (key: string, options?: Parameters<typeof t>[1]) => t(`facility-operations.purchasing.${key}`, options);
};

const pragueDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
/** Business date in Europe/Prague (`YYYY-MM-DD`); UTC would be one day early between 00:00 and 02:00. */
export const todayIso = () => pragueDate.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));

export const formatQuantity = (value: number, unit: string) =>
  `${formatNumber(value)} ${quantityUnitLabel(value, unit)}`;
export const formatAmount = (minor: number, currency = 'CZK') => formatMoney(minor, currency);
/** Whole CZK typed by the user → minor units; `undefined` when not a non-negative number. */
export const parseAmountMinor = (text: string): number | undefined => {
  const value = Number(text.replaceAll(/\s/gu, '').replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(value) || value < 0 ? undefined : Math.round(value * 100);
};
export const parsePositiveInt = (text: string): number | undefined => {
  const value = Number(text.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
};
export const parseInteger = (text: string): number | undefined => {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(value) ? value : undefined;
};
/** Serial numbers typed one per line or separated by commas. */
export const parseSerials = (text: string) =>
  text
    .split(/[\n,;]+/u)
    .map((value) => value.trim())
    .filter((value) => value !== '');

export const principalLabel = (ref: PrincipalRef, me: PrincipalRef | undefined, you: string) =>
  me !== undefined && me.tenantId === ref.tenantId && me.principalId === ref.principalId ? you : '';

export const dateTimeIso = (value: DateTime.Utc) => DateTime.formatIso(value);
/** `13. 10. 2026 14:05` of a stored audit timestamp. */
export const formatStamp = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));

export interface Lookup {
  readonly item: (id: string | undefined) => StockItem | undefined;
  readonly order: (id: string | undefined) => PurchaseOrder | undefined;
  readonly supplier: (id: string | undefined) => Supplier | undefined;
  readonly warehouse: (id: string | undefined) => StockWarehouse | undefined;
}
export const lookupOf = (state: PurchasingState): Lookup => {
  const items = new Map<string, StockItem>(state.items.map((entry) => [entry.id, entry]));
  const suppliers = new Map<string, Supplier>(state.suppliers.map((entry) => [entry.id, entry]));
  const warehouses = new Map<string, StockWarehouse>(state.warehouses.map((entry) => [entry.id, entry]));
  const orders = new Map<string, PurchaseOrder>(state.orders.map((entry) => [entry.id, entry]));
  return {
    item: (id) => (id === undefined ? undefined : items.get(id)),
    order: (id) => (id === undefined ? undefined : orders.get(id)),
    supplier: (id) => (id === undefined ? undefined : suppliers.get(id)),
    warehouse: (id) => (id === undefined ? undefined : warehouses.get(id)),
  };
};

export const failureKey = (reason: FailureReason | 'required') =>
  reason === 'required' ? 'facility-operations.common.required' : `facility-operations.common.errors.${reason}`;

export interface RefOption {
  readonly ref: StockRef;
  readonly value: string;
}

export type TaskOptionsState =
  | { readonly status: 'loading' }
  | { readonly cause: Effect.Error<ReturnType<typeof executeWorkRecords>>; readonly status: 'failed' }
  | { readonly options: readonly RefOption[]; readonly status: 'ready' };

/** Open Nájempark work tasks (work-tasks public records read) for movement traceability. */
export const useTaskOptions = (): TaskOptionsState => {
  const [state, setState] = useState<TaskOptionsState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      executeWorkRecords({}, 'facility-operations.purchasing.tasks').pipe(
        Effect.match({
          onFailure: (cause): TaskOptionsState => ({ cause, status: 'failed' }),
          onSuccess: (response): TaskOptionsState => ({
            options: response.items.flatMap((task) =>
              task.state === 'CANCELLED'
                ? []
                : [
                    {
                      ref: { id: task.ref.resourceId, kind: 'task' as const, label: task.title },
                      value: `task:${task.ref.resourceId}`,
                    },
                  ],
            ),
            status: 'ready',
          }),
        }),
        Effect.tap((next) =>
          Effect.sync(() => {
            if (alive) {
              setState(next);
            }
          }),
        ),
      ),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
};

const encodeHistoryEntry = Schema.encodeResult(Schema.fromJsonString(PurchaseOrderHistorySchema));

/** Source-order occurrence numbers distinguish identical immutable events and remain stable as history grows. */
export const historyRows = (history: PurchaseOrder['history']) =>
  Result.gen(function* projectHistoryRows() {
    const occurrences = new Map<string, number>();
    const rows: { readonly entry: PurchaseOrder['history'][number]; readonly key: string }[] = [];
    for (const entry of history) {
      const identity = yield* encodeHistoryEntry(entry);
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      rows.push({ entry, key: `${identity}:${occurrence}` });
    }
    return rows.toReversed();
  });
