// Browser helpers of the Sklad a nákupy page (ops-purchasing lane).
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import { formatDateTime, formatMoney, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DateTime, Effect } from 'effect';
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

export type RunCommand = (command: OpsCommand) => Promise<CommandOutcome>;

/** Translator scoped to `facility-operations.purchasing.*`. */
export const usePurchasingT = () => {
  const { t } = useModernI18n();
  return (key: string, options?: Record<string, unknown>) => t(`facility-operations.purchasing.${key}`, options);
};

const pragueDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
/** Business date in Europe/Prague (`YYYY-MM-DD`); UTC would be one day early between 00:00 and 02:00. */
export const todayIso = () => pragueDate.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));

export const formatQuantity = (value: number, unit: string) =>
  `${formatNumber(value)} ${quantityUnitLabel(value, unit)}`;
export const formatAmount = (minor: number, currency = 'CZK') => formatMoney(minor, currency);
/** Whole CZK typed by the user → minor units; `undefined` when not a non-negative number. */
export const parseAmountMinor = (text: string): number | undefined => {
  const value = Number(text.replace(/\s/g, '').replace(',', '.'));
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
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter((value) => value !== '');

export const principalLabel = (ref: PrincipalRef, me: PrincipalRef | undefined, you: string) =>
  me !== undefined && me.tenantId === ref.tenantId && me.principalId === ref.principalId ? you : '';

export const dateTimeIso = (value: DateTime.Utc) => DateTime.formatIso(value);
/** `13. 10. 2026 14:05` of a stored audit timestamp. */
export const formatStamp = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));

export interface Lookup {
  readonly item: (id: string | undefined) => StockItem | undefined;
  readonly supplier: (id: string | undefined) => Supplier | undefined;
  readonly warehouse: (id: string | undefined) => StockWarehouse | undefined;
  readonly order: (id: string | undefined) => PurchaseOrder | undefined;
}
export const lookupOf = (state: PurchasingState): Lookup => {
  const items = new Map(state.items.map((entry) => [entry.id as string, entry]));
  const suppliers = new Map(state.suppliers.map((entry) => [entry.id as string, entry]));
  const warehouses = new Map(state.warehouses.map((entry) => [entry.id as string, entry]));
  const orders = new Map(state.orders.map((entry) => [entry.id as string, entry]));
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
  readonly value: string;
  readonly ref: StockRef;
}

export type TaskOptionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly options: readonly RefOption[]; readonly status: 'ready' };

/** Open Siampark work tasks (work-tasks public records read) for movement traceability. */
export const useTaskOptions = (): TaskOptionsState => {
  const [state, setState] = useState<TaskOptionsState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      executeWorkRecords({}, 'facility-operations.purchasing.tasks').pipe(
        Effect.match({
          onFailure: (): TaskOptionsState => ({ status: 'failed' }),
          onSuccess: (response): TaskOptionsState => ({
            options: response.items
              .filter((task) => task.state !== 'CANCELLED')
              .map((task) => ({
                ref: { id: task.ref.resourceId, kind: 'task' as const, label: task.title },
                value: `task:${task.ref.resourceId}`,
              })),
            status: 'ready',
          }),
        }),
        Effect.map((next) => {
          if (alive) {
            setState(next);
          }
        }),
      ),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
};
