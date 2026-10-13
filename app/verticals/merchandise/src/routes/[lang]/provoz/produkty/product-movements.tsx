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
import { NO_ARIA_MAX, WHOLE_NUMBER_FORMAT } from '../../../../form-number.ts';
import { runCommand } from './products-api.ts';
import { formatDelta } from './products-format.ts';
import { fieldError, focusFirstInvalid, useCommandFailure, useProductLabel } from './product-forms.tsx';

type ManualReason = Exclude<StockMovementReason, 'ORDER'>;
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

/** Stock ledger rows for one product, newest first. */
export const MovementsTable = ({ movements }: { readonly movements: readonly StockMovement[] }) => {
  const k = useProductLabel();
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
            <Table.Cell align="end" className="tabular-nums">
              {formatDelta(movement.delta)}
            </Table.Cell>
            <Table.Cell>{movement.note ?? '—'}</Table.Cell>
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

/**
 * Manual stock movement. Výdej is sent as a negative delta; korekce takes the signed value as typed.
 * The form stays open after a save, so it sends the newer of the page revision and the one its own
 * last command returned; a second movement before the page reload finishes is not a false conflict.
 */
export const MovementForm = ({
  onCommitted,
  onReload,
  productId,
  revision,
  stockOnHand,
}: {
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly productId: ProductRecord['id'];
  readonly revision: number;
  readonly stockOnHand: number;
}) => {
  const k = useProductLabel();
  const failure = useCommandFailure();
  const [reason, setReason] = useState<ManualReason>('RECEIPT');
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Only read when sending, so a ref: the revision the last own command returned.
  const savedRevision = useRef(revision);

  const isAdjustment = reason === 'ADJUSTMENT';
  const errorKey = quantityErrorKey(reason, quantity, stockOnHand);

  const submit = () => {
    setSubmitted(true);
    if (errorKey !== undefined) {
      focusFirstInvalid([['movement-quantity', true]]);
      return;
    }
    setBusy(true);
    setServerError(null);
    const trimmed = note.trim();
    const movement = { _tag: 'RecordStockMovement' as const, delta: signedDelta(reason, quantity), productId, reason };
    const expected = Math.max(revision, savedRevision.current);
    runCommand(trimmed === '' ? movement : { ...movement, note: trimmed }, expected, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setServerError(failure(outcome.reason, onReload));
        return;
      }
      savedRevision.current = outcome.revision;
      setQuantity(1);
      setNote('');
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
          min={isAdjustment ? -stockOnHand : 1}
          name="movementQuantity"
          onChange={setQuantity}
          step={1}
          value={quantity}
          {...fieldError(submitted, errorKey === undefined ? undefined : k(errorKey))}
        >
          <NumericInput.Control>
            <NumericInput.Input {...NO_ARIA_MAX} />
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
      />
      <div className="flex justify-end">
        <Button isLoading={busy} loadingText={k('movements.submit')} theme="outlined" type="submit" variant="secondary">
          {k('movements.submit')}
        </Button>
      </div>
    </form>
  );
};
