import { pendingProposalMessage } from '../../../../api/action-result.ts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Combobox } from '@app/admin-ui/form-controls';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import {
  DetailList,
  formatMoney,
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  comboboxTranslations,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { DateTime, Effect } from 'effect';
import { constVoid } from 'effect/Function';
import { useRef, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CustomerDirectory, CustomerEntry } from './customers-directory.ts';
import { lineAmounts, sumAmounts } from './orders-model.ts';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductRecordState } from '../../provoz/produkty/product-reads.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { NewOrderLine } from './orders-records.ts';
import { createOrder, isRevisionConflict } from './orders-records.ts';
import { OrderLineEditor } from './order-line-editor.tsx';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { activeVariants, lineClassification, lineProduct } from './order-line-draft.ts';
import { useTaxLabels } from '../../provoz/produkty/product-tax-classification.ts';
import type { CompanyVat } from '../../provoz/produkty/product-tax-classification.ts';
import type { DraftLine, DraftLinePatch } from './order-line-draft.ts';

const key = (path: string) => `merchandise.pages.orders.${path}`;

interface Draft {
  readonly lines: readonly DraftLine[];
  readonly partyId: string;
}

const isValidQuantity = (quantity: number) => Number.isInteger(quantity) && quantity >= 1;

const emptyLine = (lineKey: string): DraftLine => ({
  key: lineKey,
  picked: null,
  quantity: 1,
  quantityText: '1',
  record: { status: 'idle' },
  variantId: null,
});

const firstValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

/** The form opens with one empty line and no customer; anything picked or typed after that is the draft. */
const blankDraft: Draft = { lines: [emptyLine('line-1')], partyId: '' };

/** What the user chose: the customer and, per line, product, variant and quantity. A loading product record is not. */
const sameDraft = (left: Draft, right: Draft): boolean =>
  left.partyId === right.partyId &&
  left.lines.length === right.lines.length &&
  left.lines.every((line, index) => {
    const other = right.lines[index];
    return (
      other !== undefined &&
      line.picked?.id === other.picked?.id &&
      line.variantId === other.variantId &&
      line.quantityText === other.quantityText
    );
  });

/** The order lines the draft sends: lines without a product are not sent. */
const linesOf = (value: Draft) =>
  value.lines.flatMap((line) => {
    if (line.picked === null) {
      return [];
    }
    const next: { -readonly [Key in keyof NewOrderLine]: NewOrderLine[Key] } = {
      productId: line.picked.id,
      quantity: line.quantity,
    };
    if (line.variantId !== null) {
      next.variantId = line.variantId;
    }
    return [next];
  });

interface OrderCreateDialogProps {
  readonly customers: CustomerDirectory;
  readonly onCreated: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly revision: number;
  /** The company's VAT rates from the staff records read; each line's VAT comes from its product's classification. */
  readonly vat: CompanyVat;
}

export const OrderCreateDialog = ({
  customers,
  onCreated,
  onOpenChange,
  open,
  revision,
  vat,
}: OrderCreateDialogProps) => {
  const { language, t } = useModernI18n();
  const taxLabels = useTaxLabels();
  const ratesConfirmation = taxLabels.confirmation(vat, DateTime.nowUnsafe());
  const now = DateTime.nowUnsafe();
  const toaster = useToast();
  const lineSequence = useRef(1);
  const newLine = (): DraftLine => {
    lineSequence.current += 1;
    return emptyLine(`line-${lineSequence.current}`);
  };

  // The order is only on screen until Uložit sends it; picking and typing never write.
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [serverError, setServerError] = useState<string | null>(null);

  const updateLine = (lineKey: string, patch: DraftLinePatch) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)),
    }));

  /** A record that arrives after the line picked another product is dropped. */
  const receiveRecord = (lineKey: string, productId: ProductId, record: ProductRecordState) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.key === lineKey && line.picked?.id === productId ? { ...line, record } : line,
      ),
    }));

  const removeLine = (lineKey: string) =>
    setDraft((current) => ({ ...current, lines: current.lines.filter((line) => line.key !== lineKey) }));

  const partyErrorOf = (value: Draft) => (value.partyId.trim() === '' ? t(key('create.errorCustomer')) : undefined);
  // The server snapshots the rate Tax gives the classification; without a usable one the line cannot be ordered.
  const rateErrorOf = (product: ProductRecord) => {
    const classification = lineClassification(product, vat, now);
    return classification?.current === undefined
      ? taxLabels.rateMissing(product.taxClassificationCode, classification?.problem)
      : undefined;
  };
  const lineErrorsOf = (value: Draft) =>
    value.lines.map((line) => {
      if (line.picked === null) {
        return t(key('create.errorProduct'));
      }
      const product = lineProduct(line);
      if (product === null) {
        return t(key(line.record.status === 'error' ? 'create.productFailed' : 'create.productLoading'));
      }
      if (activeVariants(product).length > 0 && line.variantId === null) {
        return t(key('create.errorVariant'));
      }
      return rateErrorOf(product) ?? (isValidQuantity(line.quantity) ? undefined : t(key('create.errorQuantity')));
    });
  const partyError = partyErrorOf(draft);
  const lineErrors = lineErrorsOf(draft);

  const priced = draft.lines.flatMap((line) => {
    const product = lineProduct(line);
    const variant = product?.variantRecords?.find((entry) => entry.id === line.variantId);
    const vatRate = lineClassification(product, vat, now)?.current?.ratePercent;
    return product === null || vatRate === undefined || !isValidQuantity(line.quantity)
      ? []
      : [lineAmounts(variant?.priceMinor ?? product.currentPriceMinor, line.quantity, vatRate)];
  });
  const totals = sumAmounts(priced);

  const createFrom = (value: Draft): Effect.Effect<SaveOutcome> =>
    createOrder({ lines: linesOf(value), partyId: value.partyId.trim(), revision }).pipe(
      Effect.match({
        onFailure: (error): SaveOutcome => {
          const proposal = pendingProposalMessage(error);
          setServerError(proposal ?? (isRevisionConflict(error) ? t(key('create.conflict')) : t(key('create.failed'))));
          return proposal === undefined ? 'failed' : 'proposed';
        },
        onSuccess: (): SaveOutcome => {
          setServerError(null);
          toaster.create({ title: t(key('toast.created')), type: 'success' });
          return 'saved';
        },
      }),
    );

  const save = useDraftSave<Draft, never>({
    equals: sameDraft,
    initial: blankDraft,
    isValid: (value) => partyErrorOf(value) === undefined && lineErrorsOf(value).every((error) => error === undefined),
    // The panel stays mounted while closed: only the open panel asks before leaving.
    open,
    runtime: browserRuntime,
    save: createFrom,
    value: draft,
  });
  // Field messages show once the draft cannot be sent.
  const submitted = save.status === 'invalid';

  /** Every way out (Zrušit, the panel's dismissal, a created order) starts the next open from an empty form. */
  const startOver = () => {
    const next = { lines: [newLine()], partyId: '' };
    setDraft(next);
    setServerError(null);
    save.adopt(next);
  };
  const leave = () => {
    startOver();
    onOpenChange(false);
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => save.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: save, navigation: blocker, onDiscard: startOver });
  const labels = saveLabelsFor(language);
  const handleSave = () => {
    save.save();
    save.afterSave((status) => {
      if (status === 'saved') {
        leave();
        onCreated();
      }
    });
  };

  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={() => guard.request(leave)} theme="outlined" variant="secondary">
              {t(key('create.cancel'))}
            </Button>
            <SaveBar
              error={serverError}
              labels={labels}
              onReloadLatest={constVoid}
              onSave={handleSave}
              status={save.status}
            />
          </>
        }
        description={t(key('create.description'))}
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            leave();
          }
        }}
        open={open}
        resizeLabel={t('merchandise.sidePanel.resize')}
        size="lg"
        title={t(key('create.title'))}
      >
        <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
          {/* Not clearable: ui-kit names the clear control "Clear value" in English; picking another customer replaces it. */}
          <Combobox<CustomerEntry>
            clearable={false}
            error={customers.status === 'error' ? t(key('create.customersFailed')) : undefined}
            helpText={submitted && partyError !== undefined ? partyError : t(key('create.customerHelp'))}
            items={customers.active.map((customer) => ({
              data: customer,
              label: customer.name ?? t('merchandise.pages.orders.customers.unknown'),
              value: customer.partyId,
            }))}
            label={t(key('create.customer'))}
            loading={customers.status === 'loading'}
            loadingMessage={t('merchandise.loading')}
            noResultsMessage={t(key('create.noCustomerMatch'))}
            onChange={(values) => {
              setDraft((current) => ({ ...current, partyId: firstValue(values) ?? '' }));
            }}
            onRetry={() => customers.reload()}
            placeholder={t(key('create.customerPlaceholder'))}
            renderItem={(item) => (
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.label}</span>
                {item.data?.companyId !== null && item.data?.companyId !== undefined && item.data.companyId !== '' && (
                  <span className="text-fg-secondary text-xs">{`IČO ${item.data.companyId}`}</span>
                )}
              </span>
            )}
            required
            retryLabel={t(key('states.retry'))}
            translations={comboboxTranslations}
            validateStatus={submitted && partyError !== undefined ? 'error' : 'default'}
            value={draft.partyId === '' ? [] : [draft.partyId]}
          />

          <div className="flex flex-col gap-150">
            <span className="font-medium text-sm">{t(key('create.lines'))}</span>
            {ratesConfirmation !== undefined && (
              <StatusText showIcon size="sm" status="warning">
                {ratesConfirmation}
              </StatusText>
            )}
            {draft.lines.map((line, index) => (
              <OrderLineEditor
                canRemove={draft.lines.length > 1}
                error={submitted ? lineErrors[index] : undefined}
                key={line.key}
                line={line}
                onChange={(patch) => updateLine(line.key, patch)}
                onRecord={(productId, record) => receiveRecord(line.key, productId, record)}
                onRemove={() => removeLine(line.key)}
                vat={vat}
              />
            ))}
            <div>
              <Button
                icon="icon-[mdi--plus]"
                onClick={() => setDraft((current) => ({ ...current, lines: [...current.lines, newLine()] }))}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(key('create.addLine'))}
              </Button>
            </div>
          </div>

          <DetailList
            items={[
              {
                label: t(key('detail.netTotal')),
                value: <span className="tabular-nums">{formatMoney(totals.net)}</span>,
              },
              {
                label: t(key('detail.vatTotal')),
                value: <span className="tabular-nums">{formatMoney(totals.vat)}</span>,
              },
              {
                label: t(key('detail.grossTotal')),
                value: <span className="tabular-nums">{formatMoney(totals.gross)}</span>,
              },
            ]}
          />
          <p className="text-fg-secondary text-xs">{t(key('create.priceNote'))}</p>
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
