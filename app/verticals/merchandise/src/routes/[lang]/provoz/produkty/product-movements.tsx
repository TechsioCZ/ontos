import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { formatDateTime } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useRef, useState } from 'react';
import type { ProductRecord, StockMovement } from '../../../../../shared/apis/records.ts';
import type { StockMovementReason } from '../../../../../shared/domain/merchandise-model.ts';
import { WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { runCommand } from './products-api.ts';
import { formatDelta } from './products-format.ts';
import {
  PRODUCT_LIMITS,
  fieldError,
  focusFirstInvalid,
  tooLongMessage,
  useCommandFailure,
  useProductLabel,
} from './product-forms.tsx';

type ManualReason = Exclude<StockMovementReason, 'ORDER'>;
type VariantRow = NonNullable<ProductRecord['variantRecords']>[number];
const variantLabel = (variant: VariantRow) => `${variant.name} (${variant.sku})`;
const MANUAL_REASONS: readonly ManualReason[] = ['RECEIPT', 'ISSUE', 'ADJUSTMENT'];

const movementVariant = {
  ADJUSTMENT: 'warning',
  ISSUE: 'info',
  ORDER: 'outline',
  RECEIPT: 'success',
} as const;

/** Výdej is a negative delta, příjem a positive one, korekce keeps the signed value as typed. */
const signedDelta = (reason: ManualReason, quantity: number): number => {
  const magnitude = Math.abs(Math.round(quantity));
  if (reason === 'ISSUE') {
    return -magnitude;
  }
  if (reason === 'RECEIPT') {
    return magnitude;
  }
  return Math.round(quantity);
};

/** Stock ledger rows for one product, newest first. Products with variants show which variant moved. */
export const MovementsTable = ({
  movements,
  variants = [],
}: {
  readonly movements: readonly StockMovement[];
  readonly variants?: readonly VariantRow[] | undefined;
}) => {
  const k = useProductLabel();
  const byId = new Map(variants.map((variant) => [variant.id, variant] as const));
  const showVariant = variants.length > 0;
  const rows = movements.toSorted((left, right) => DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at));

  if (rows.length === 0) {
    return <p className="text-fg-secondary text-sm">{k('movements.empty')}</p>;
  }
  return (
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>{k('movements.columnDate')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('movements.columnType')}</Table.ColumnHeader>
          {showVariant && <Table.ColumnHeader>Varianta</Table.ColumnHeader>}
          <Table.ColumnHeader align="end">{k('movements.columnDelta')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('movements.columnNote')}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((movement) => (
          <Table.Row key={movement.id}>
            <Table.Cell>{formatDateTime(DateTime.formatIso(movement.at))}</Table.Cell>
            <Table.Cell>
              <Badge size="sm" variant={movementVariant[movement.reason]}>
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
            <Table.Cell>{movement.note ?? movement.reference ?? '—'}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};

/** Validation message key for a typed quantity, or undefined when the movement can be sent. */
const quantityErrorKey = (reason: ManualReason, quantity: number, stockOnHand: number): string | undefined => {
  if (!Number.isInteger(quantity) || quantity === 0) {
    return reason === 'ADJUSTMENT' ? 'validation.delta' : 'validation.quantity';
  }
  if (reason !== 'ADJUSTMENT' && quantity < 0) {
    return 'validation.quantity';
  }
  return stockOnHand + signedDelta(reason, quantity) < 0 ? 'validation.stock' : undefined;
};

/** Typed movement fields. The product panel owns them, so Esc and outside clicks can see an unsent movement. */
export interface MovementDraft {
  readonly note: string;
  readonly quantity: number;
  /** The quantity input's text, kept as typed so "2,5" reaches validation instead of becoming 25. */
  readonly quantityText: string;
  readonly reason: ManualReason;
  /** Required on a product with variants: the storefront sells variant stock, not the product total. */
  readonly variantId?: string | undefined;
}

export const EMPTY_MOVEMENT_DRAFT: MovementDraft = { note: '', quantity: 1, quantityText: '1', reason: 'RECEIPT' };

/** True when the movement form holds something the user typed or picked beyond the empty defaults. */
export const isMovementDraftDirty = (draft: MovementDraft): boolean =>
  draft.reason !== EMPTY_MOVEMENT_DRAFT.reason ||
  draft.quantity !== EMPTY_MOVEMENT_DRAFT.quantity ||
  draft.note.trim() !== EMPTY_MOVEMENT_DRAFT.note ||
  draft.variantId !== undefined;

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
  variants = [],
}: {
  readonly draft: MovementDraft;
  readonly onCommitted: (message: string) => void;
  readonly onDraftChange: (patch: Partial<MovementDraft>) => void;
  readonly onReload: () => void;
  readonly productId: ProductRecord['id'];
  readonly revision: number;
  readonly stockOnHand: number;
  readonly variants?: readonly VariantRow[] | undefined;
}) => {
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
    const movement = {
      _tag: 'RecordStockMovement' as const,
      delta: signedDelta(reason, quantity),
      productId,
      reason,
      ...(variant === undefined ? {} : { variantId: variant.id }),
    };
    const expected = Math.max(revision, savedRevision.current);
    runCommand(trimmed === '' ? movement : { ...movement, note: trimmed }, expected, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setServerError(failure(outcome.reason, onReload));
        return;
      }
      savedRevision.current = outcome.revision;
      onDraftChange(EMPTY_MOVEMENT_DRAFT);
      setSubmitted(false);
      onCommitted(k('messages.movementRecorded'));
    });
  };

  return (
    <form
      className="flex flex-col gap-200 border-border-primary border-t pt-200"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
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
            items={variants.map((entry) => ({
              label: `${variantLabel(entry)} – skladem ${entry.stockOnHand}`,
              value: entry.id,
            }))}
            label="Varianta"
            name="movementVariant"
            onValueChange={(details) => {
              const [next] = details.value;
              onDraftChange({ variantId: variants.some((entry) => entry.id === next) ? next : undefined });
            }}
            placeholder="Vyberte variantu"
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
          items={MANUAL_REASONS.map((value) => ({ label: k(`movementType.${value}`), value }))}
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
          formatOptions={WHOLE_NUMBER_FORMAT}
          id="movement-quantity"
          label={k('fields.quantity')}
          locale="cs-CZ"
          min={isAdjustment ? -available : 1}
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
        <Button isLoading={busy} loadingText={k('movements.submit')} theme="outlined" type="submit" variant="secondary">
          {k('movements.submit')}
        </Button>
      </div>
    </form>
  );
};
