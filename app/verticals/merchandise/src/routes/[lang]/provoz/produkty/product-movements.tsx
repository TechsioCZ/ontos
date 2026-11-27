import {
  isStockQuantity,
  MAX_QUANTITY,
  MIN_STOCK_QUANTITY,
  normalizeQuantity,
} from '../../../../../shared/domain/order-quantity.ts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput, FormNumericInput } from '@app/admin-ui/form-controls';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { selectItem } from '../../../../ui/select-item.ts';
import { formatDateTime } from '@app/admin-ui';
import { DateTime, Effect } from 'effect';
import { useRef, useState } from 'react';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { LedgerMovement, ProductRecord } from '../../../../../shared/apis/records.ts';
import { QUANTITY_FORMAT } from '../../../../form-number.ts';
import { loadOlderMovements, runCommand } from './products-api.ts';
import { writeThroughSymmyVariant } from './symmy-write-through.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { formatDelta, formatQuantity } from './products-format.ts';
import { PRODUCT_LIMITS, fieldError, focusFirstInvalid, tooLongMessage } from './product-form-validation.ts';
import { useCommandFailure, useProductLabel } from './product-form-labels.ts';
import { EMPTY_MOVEMENT_DRAFT } from './product-movement-draft.ts';
import type { ManualReason, MovementDraft } from './product-movement-draft.ts';

type VariantRow = NonNullable<ProductRecord['variantRecords']>[number];
const NO_VARIANTS: readonly VariantRow[] = [];
const variantLabel = (variant: VariantRow) => `${variant.name} (${variant.sku})`;
const MANUAL_REASONS: readonly ManualReason[] = ['RECEIPT', 'ISSUE', 'ADJUSTMENT'];

const movementVariant = {
  ADJUSTMENT: 'warning',
  ISSUE: 'info',
  ORDER: 'neutral',
  RECEIPT: 'success',
} as const;

/** Výdej is a negative delta, příjem a positive one, korekce keeps the signed value as typed. */
const signedDelta = (reason: ManualReason, quantity: number): number => {
  const magnitude = Math.abs(quantity);
  if (reason === 'ISSUE') {
    return -magnitude;
  }
  if (reason === 'RECEIPT') {
    return magnitude;
  }
  return quantity;
};

/**
 * Stock ledger rows for one product, newest recorded first, each with the stock right after it; products with variants
 * show which variant moved. `movements` is the newest page of the ledger in ledger order (oldest first); older pages
 * load on request and stay below it. Remount it (key) when the newest page changes, so loaded pages never leave a gap.
 */
export const MovementsTable = ({
  hasOlder,
  movements,
  productId,
  variants = NO_VARIANTS,
}: {
  readonly hasOlder: boolean;
  readonly movements: readonly LedgerMovement[];
  readonly productId: ProductRecord['id'];
  readonly variants?: readonly VariantRow[] | undefined;
}) => {
  const k = useProductLabel();
  const byId = new Map(variants.map((variant) => [variant.id, variant] as const));
  const showVariant = variants.length > 0;
  const [older, setOlder] = useState<{ readonly hasOlder: boolean; readonly rows: readonly LedgerMovement[] }>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const rows = [...movements.toReversed(), ...(older?.rows ?? [])];
  const moreOlder = older?.hasOlder ?? hasOlder;
  const loadOlder = () => {
    const oldest = rows.at(-1);
    if (loading || oldest === undefined) {
      return;
    }
    setLoading(true);
    setFailed(false);
    loadOlderMovements(productId, oldest.id, (outcome) => {
      setLoading(false);
      if (!outcome.ok) {
        setFailed(true);
        return;
      }
      setOlder((current) => ({
        hasOlder: outcome.hasOlder,
        rows: [...(current?.rows ?? []), ...outcome.movements.toReversed()],
      }));
    });
  };

  if (rows.length === 0) {
    return <p className="text-fg-secondary text-sm">{k('movements.empty')}</p>;
  }
  return (
    <div className="flex flex-col gap-200">
      <Table appearance="line" size="sm">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>{k('movements.columnDate')}</Table.ColumnHeader>
            <Table.ColumnHeader>{k('movements.columnType')}</Table.ColumnHeader>
            {showVariant && <Table.ColumnHeader>Varianta</Table.ColumnHeader>}
            <Table.ColumnHeader align="end">{k('movements.columnDelta')}</Table.ColumnHeader>
            <Table.ColumnHeader align="end">{k('movements.columnBalance')}</Table.ColumnHeader>
            <Table.ColumnHeader>{k('movements.columnNote')}</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((movement) => (
            <Table.Row key={movement.id}>
              <Table.Cell>{formatDateTime(DateTime.formatIso(movement.at))}</Table.Cell>
              <Table.Cell>
                <Badge severity={movementVariant[movement.reason]} size="sm">
                  {k(`movementType.${movement.reason}`)}
                </Badge>
              </Table.Cell>
              {showVariant && (
                <Table.Cell>
                  {movement.variantId === undefined
                    ? 'Celý produkt (bez varianty)'
                    : (() => {
                        const variant = byId.get(movement.variantId);
                        return variant === undefined ? movement.variantId : variantLabel(variant);
                      })()}
                </Table.Cell>
              )}
              <Table.Cell align="end" className="tabular-nums">
                {formatDelta(movement.delta)}
              </Table.Cell>
              <Table.Cell align="end" className="tabular-nums">
                {formatQuantity(movement.balanceAfter)}
              </Table.Cell>
              <Table.Cell>{movement.note ?? movement.reference ?? '—'}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {failed && (
        <StatusText showIcon status="error">
          {k('movements.loadOlderFailed')}
        </StatusText>
      )}
      {moreOlder && (
        <div className="flex justify-center">
          <Button
            appearance="outline"
            isLoading={loading}
            loadingText={k('movements.loadOlder')}
            onClick={loadOlder}
            severity="secondary"
            size="sm"
            type="button"
          >
            {k('movements.loadOlder')}
          </Button>
        </div>
      )}
    </div>
  );
};

/** Validation message key for a typed quantity, or undefined when the movement can be sent. */
const quantityErrorKey = (reason: ManualReason, quantity: number, stockOnHand: number): string | undefined => {
  if (!isStockQuantity(quantity)) {
    return reason === 'ADJUSTMENT' ? 'validation.delta' : 'validation.quantity';
  }
  if (reason !== 'ADJUSTMENT' && quantity < 0) {
    return 'validation.quantity';
  }
  return normalizeQuantity(stockOnHand + signedDelta(reason, quantity)) < 0 ? 'validation.stock' : undefined;
};

/**
 * Manual stock movement. Výdej is sent as a negative delta; korekce takes the signed value as typed.
 * The form stays open after a save, so it sends the newer of the page revision and the one its own
 * last command returned; a second movement before the page reload finishes is not a false conflict.
 */
export const MovementForm = ({
  draft,
  onCommitted,
  onDraftChange,
  onReload,
  productId,
  revision,
  stockOnHand,
  symmyTarget,
  variants = NO_VARIANTS,
}: {
  readonly draft: MovementDraft;
  readonly onCommitted: (message: string) => void;
  readonly onDraftChange: (patch: Partial<MovementDraft>) => void;
  readonly onReload: () => void;
  readonly productId: ProductRecord['id'];
  readonly revision: number;
  readonly stockOnHand: number;
  /** A Symmy product: the Pricing/Inventory variant the new on-hand is written to first, so Symmy reads it back. */
  readonly symmyTarget?:
    | ((variantId: string | undefined) => { readonly catalogProductId: string; readonly catalogVariantId: string } | undefined)
    | undefined;
  readonly variants?: readonly VariantRow[] | undefined;
}) => {
  const { t } = useModernI18n();
  const k = useProductLabel();
  const failure = useCommandFailure();
  const { note, quantity, quantityText, reason, variantId } = draft;
  const needsVariant = variants.length > 0;
  const variant = variants.find((entry) => entry.id === variantId);
  const variantMissing = needsVariant && variant === undefined;
  const available = needsVariant ? (variant?.stockOnHand ?? 0) : stockOnHand;
  const setReason = (value: ManualReason) => {
    onDraftChange({ reason: value });
  };
  const setNote = (value: string) => {
    onDraftChange({ note: value });
  };
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Only read when sending, so a ref: the revision the last own command returned.
  const savedRevision = useRef(revision);

  const isAdjustment = reason === 'ADJUSTMENT';
  const errorKey = quantityErrorKey(reason, quantity, available);
  const noteError = tooLongMessage(k, note, PRODUCT_LIMITS.note);

  const submit = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (variantMissing || errorKey !== undefined || noteError !== undefined) {
      focusFirstInvalid([
        ['movement-variant', variantMissing],
        ['movement-quantity', errorKey !== undefined],
        ['movement-note', noteError !== undefined],
      ]);
      return;
    }
    setBusy(true);
    setServerError(null);
    const trimmed = note.trim();
    const stockMovement = {
      _tag: 'RecordStockMovement',
      delta: signedDelta(reason, quantity),
      productId,
      reason,
    } satisfies MerchandiseCommand;
    const movement = variant === undefined ? stockMovement : { ...stockMovement, variantId: variant.id };
    const expected = Math.max(revision, savedRevision.current);
    const record = (at: number, corrected?: number) =>
      runCommand(trimmed === '' ? movement : { ...movement, note: trimmed }, at, (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setServerError(failure(outcome.reason, onReload, outcome.proposal));
          return;
        }
        savedRevision.current = outcome.revision;
        onDraftChange(EMPTY_MOVEMENT_DRAFT);
        setSubmitted(false);
        const recorded = k('messages.movementRecorded');
        onCommitted(corrected === undefined ? recorded : `${recorded} Stav byl srovnán se skladem v ERP: ${corrected}.`);
      });
    const target = symmyTarget?.(variant?.id);
    if (target === undefined) {
      record(expected);
      return;
    }
    // A Symmy product: the movement is applied to Inventory's CURRENT on-hand first (never to this row's figure, which
    // can lag behind the ERP); when that fails, nothing is recorded here. When the row differed from the ERP before the
    // movement, one correction brings it to the ERP figure first, so after the save both hold the same on-hand.
    const syncThenRecord = (before: number, after: number) => {
      const correction = normalizeQuantity(before - available);
      if (correction === 0) {
        record(expected);
        return;
      }
      const sync = { _tag: 'RecordStockMovement', delta: correction, note: 'Srovnání se stavem skladu v ERP', productId, reason: 'ADJUSTMENT' } satisfies MerchandiseCommand;
      runCommand(variant === undefined ? sync : { ...sync, variantId: variant.id }, expected, (outcome) => {
        if (!outcome.ok) {
          setBusy(false);
          setServerError(failure(outcome.reason, onReload, outcome.proposal));
          return;
        }
        savedRevision.current = outcome.revision;
        record(outcome.revision, after);
      });
    };
    void browserRuntime.runPromise(
      writeThroughSymmyVariant({
        ...target,
        reason: trimmed === '' ? 'Úprava v Produkty' : trimmed,
        stockDelta: movement.delta,
      }).pipe(
        Effect.match({
          onFailure: (message) => {
            setBusy(false);
            setServerError(message);
          },
          onSuccess: ({ stock }) => {
            if (stock === undefined) {
              record(expected);
              return;
            }
            syncThenRecord(stock.before, stock.after);
          },
        }),
      ),
    );
  };

  return (
    <form
      className="flex flex-col gap-200 border-border-primary border-t pt-200"
      // Enter in a field does not record the movement; only its button does.
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <h3 className="font-semibold text-md">{k('movements.recordTitle')}</h3>
      {serverError !== null && (
        <StatusText showIcon status="error">
          {serverError}
        </StatusText>
      )}
      {needsVariant && (
        <div className="flex flex-col gap-100">
          <SelectTemplate
            id="movement-variant"
            items={variants.map((entry) =>
              selectItem(entry.id, `${variantLabel(entry)} – skladem ${entry.stockOnHand}`),
            )}
            label={t('merchandise.ui.variant')}
            name="movementVariant"
            onValueChange={(details) => {
              const [next] = details.value;
              onDraftChange({ variantId: variants.some((entry) => entry.id === next) ? next : undefined });
            }}
            placeholder={t('merchandise.ui.selectVariant')}
            value={variantId === undefined ? [] : [variantId]}
          />
          {submitted && variantMissing ? (
            <StatusText showIcon status="error">
              Vyberte variantu. E-shop prodává sklad jednotlivých variant.
            </StatusText>
          ) : (
            <p className="text-fg-secondary text-xs">
              E-shop prodává sklad jednotlivých variant, proto pohyb patří k jedné variantě.
            </p>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <SelectTemplate
          items={MANUAL_REASONS.map((value) => selectItem(value, k(`movementType.${value}`)))}
          label={k('movements.typeField')}
          name="movementType"
          onValueChange={(details) => {
            const [next] = details.value;
            const picked = MANUAL_REASONS.find((value) => value === next);
            if (picked !== undefined) {
              setReason(picked);
            }
          }}
          placeholder={k('selectPlaceholder')}
          value={[reason]}
        />
        {/* Real bounds for the ARIA range, without clamping on blur: an out-of-range quantity stays visible to validation. */}
        <FormNumericInput
          clampValueOnBlur={false}
          formatOptions={QUANTITY_FORMAT}
          id="movement-quantity"
          label={k('fields.quantity')}
          locale="cs-CZ"
          max={MAX_QUANTITY}
          min={isAdjustment ? -Math.min(available, MAX_QUANTITY) : MIN_STOCK_QUANTITY}
          name="movementQuantity"
          onValueChange={(details) => {
            onDraftChange({ quantity: details.valueAsNumber, quantityText: details.value });
          }}
          step={1}
          value={quantityText}
          {...fieldError(submitted, errorKey === undefined ? undefined : k(errorKey))}
        >
          <NumericInput.Control>
            <NumericInput.Input aria-valuemax={undefined} />
          </NumericInput.Control>
        </FormNumericInput>
      </div>
      {isAdjustment && <p className="text-fg-secondary text-xs">{k('movements.quantityHint')}</p>}
      <FormInput
        autoComplete="off"
        id="movement-note"
        label={k('fields.note')}
        name="movementNote"
        onChange={(event) => setNote(event.target.value)}
        value={note}
        {...fieldError(submitted, noteError)}
      />
      <div className="flex justify-end">
        <Button
          appearance="outline"
          isLoading={busy}
          loadingText={k('movements.submit')}
          onClick={submit}
          severity="secondary"
          type="button"
        >
          {k('movements.submit')}
        </Button>
      </div>
    </form>
  );
};
