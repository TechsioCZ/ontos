import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DetailList, formatMoney, SidePanel } from '@app/admin-ui';
import { Effect } from 'effect';
import { useRef, useState } from 'react';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CustomerDirectory, CustomerEntry } from './customers-directory.ts';
import { lineAmounts, sumAmounts } from './orders-model.ts';
import { createOrder, isRevisionConflict } from './orders-records.ts';
import { OrderLineEditor } from './order-line-editor.tsx';
import type { DraftLine, DraftLinePatch } from './order-line-editor.tsx';

const key = (path: string) => `merchandise.pages.orders.${path}`;

interface Draft {
  readonly lines: readonly DraftLine[];
  readonly partyId: string;
}

const isValidQuantity = (quantity: number) => Number.isInteger(quantity) && quantity >= 1;

const firstValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

interface OrderCreateDialogProps {
  readonly customers: CustomerDirectory;
  readonly onCreated: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly products: readonly ProductRecord[];
  readonly revision: number;
}

export const OrderCreateDialog = ({
  customers,
  onCreated,
  onOpenChange,
  open,
  products,
  revision,
}: OrderCreateDialogProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const lineSequence = useRef(1);
  const newLine = (): DraftLine => {
    lineSequence.current += 1;
    return { key: `line-${lineSequence.current}`, productId: null, quantity: 1 };
  };
  const emptyDraft = (): Draft => ({ lines: [newLine()], partyId: '' });

  const [draft, setDraft] = useState<Draft>(() => ({
    lines: [{ key: 'line-1', productId: null, quantity: 1 }],
    partyId: '',
  }));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const activeProducts = products.filter((product) => product.active);

  const updateLine = (lineKey: string, patch: DraftLinePatch) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)),
    }));

  const removeLine = (lineKey: string) =>
    setDraft((current) => ({ ...current, lines: current.lines.filter((line) => line.key !== lineKey) }));

  const partyError = draft.partyId.trim() === '' ? t(key('create.errorCustomer')) : undefined;
  const lineErrors = draft.lines.map((line) => {
    if (line.productId === null) {
      return t(key('create.errorProduct'));
    }
    return isValidQuantity(line.quantity) ? undefined : t(key('create.errorQuantity'));
  });
  const valid = partyError === undefined && lineErrors.every((error) => error === undefined);

  const priced = draft.lines.flatMap((line) => {
    const product = activeProducts.find((item) => item.id === line.productId);
    return product === undefined || !isValidQuantity(line.quantity)
      ? []
      : [lineAmounts(product.currentPriceMinor, line.quantity, product.vatRate)];
  });
  const totals = sumAmounts(priced);

  const close = () => {
    setDraft(emptyDraft());
    setSubmitted(false);
    setServerError(null);
    onOpenChange(false);
  };

  const submit = () => {
    setSubmitted(true);
    if (!valid) {
      return;
    }
    const lines = draft.lines.flatMap((line) =>
      line.productId === null ? [] : [{ productId: line.productId, quantity: line.quantity }],
    );
    setBusy(true);
    setServerError(null);
    void browserRuntime.runPromise(
      createOrder({ lines, partyId: draft.partyId.trim(), revision }).pipe(
        Effect.match({
          onFailure: (error) => {
            setServerError(isRevisionConflict(error) ? t(key('create.conflict')) : t(key('create.failed')));
            setBusy(false);
          },
          onSuccess: () => {
            toaster.create({ title: t(key('toast.created')), type: 'success' });
            setBusy(false);
            close();
            onCreated();
          },
        }),
      ),
    );
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={close} theme="outlined" variant="secondary">
            {t(key('create.cancel'))}
          </Button>
          <Button isLoading={busy} loadingText={t(key('create.submitting'))} onClick={submit} variant="primary">
            {t(key('create.submit'))}
          </Button>
        </>
      }
      description={t(key('create.description'))}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      open={open}
      size="lg"
      title={t(key('create.title'))}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {serverError !== null && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <Combobox<CustomerEntry>
          error={customers.status === 'error' ? t(key('create.customersFailed')) : undefined}
          helpText={submitted && partyError !== undefined ? partyError : t(key('create.customerHelp'))}
          items={customers.active.map((customer) => ({
            data: customer,
            label: customer.name ?? customer.partyId,
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
          validateStatus={submitted && partyError !== undefined ? 'error' : 'default'}
          value={draft.partyId === '' ? [] : [draft.partyId]}
        />

        <div className="flex flex-col gap-150">
          <span className="font-medium text-sm">{t(key('create.lines'))}</span>
          {draft.lines.map((line, index) => (
            <OrderLineEditor
              canRemove={draft.lines.length > 1}
              error={submitted ? lineErrors[index] : undefined}
              key={line.key}
              line={line}
              onChange={(patch) => updateLine(line.key, patch)}
              onRemove={() => removeLine(line.key)}
              products={activeProducts}
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
          {activeProducts.length === 0 && <p className="text-fg-secondary text-xs">{t(key('create.noProducts'))}</p>}
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
  );
};
