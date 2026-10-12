import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DateTime, Effect } from 'effect';
import { browserCrypto } from '../../../../api/browser-crypto.ts';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';
import { financeFailureFeedback, parseMoney } from './use-finance-records.ts';
import type { useFinanceRecords } from './use-finance-records.ts';

const counterpartyLabel = 'siampark-billing-finance.demo.counterparty';

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;

export const FinanceInvoiceTable = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const { money, propertyName, setEditing, setSelectedId, t, visible } = vm;
  return (
    <div className="siamparkbillingfinance:min-w-0 siamparkbillingfinance:overflow-x-auto siamparkbillingfinance:rounded-lg siamparkbillingfinance:bg-(--color-surface)">
      <Table className="siamparkbillingfinance:w-full" size="sm" variant="outline">
        <Table.Caption>{t('siampark-billing-finance.demo.invoices')}</Table.Caption>
        <Table.Header className="siamparkbillingfinance:bg-(--color-surface-subtle)">
          <Table.Row>
            {['number', 'direction', 'property', 'amount', 'states', 'due', 'detail'].map((key) => (
              <Table.ColumnHeader key={key}>{t(`siampark-billing-finance.demo.${key}`)}</Table.ColumnHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {visible.map((invoice) => (
            <Table.Row key={invoice.ref.resourceId} selected={vm.selected?.ref.resourceId === invoice.ref.resourceId}>
              <Table.Cell className="siamparkbillingfinance:font-medium siamparkbillingfinance:whitespace-nowrap">
                {invoice.documentNumber}
              </Table.Cell>
              <Table.Cell>{t(`siampark-billing-finance.demo.labels.${invoice.direction}`)}</Table.Cell>
              <Table.Cell>{propertyName(invoice.propertyRef?.resourceId)}</Table.Cell>
              <Table.Cell className="siamparkbillingfinance:font-medium siamparkbillingfinance:whitespace-nowrap siamparkbillingfinance:tabular-nums">
                {money(invoice.totalMinor)}
              </Table.Cell>
              <Table.Cell>
                <div className="siamparkbillingfinance:flex siamparkbillingfinance:flex-wrap siamparkbillingfinance:gap-1.5">
                  <Badge
                    size="sm"
                    variant={
                      ({ CONFIRMED: 'success', DRAFT: 'warning', VOIDED: 'outline' } as const)[invoice.businessState]
                    }
                  >
                    {t(`siampark-billing-finance.demo.labels.${invoice.businessState}`)}
                  </Badge>
                  <Badge
                    size="sm"
                    variant={
                      ({ PAID: 'success', PARTIALLY_PAID: 'warning', UNPAID: 'outline' } as const)[invoice.paymentState]
                    }
                  >
                    {t(`siampark-billing-finance.demo.labels.${invoice.paymentState}`)}
                  </Badge>
                  <Badge
                    size="sm"
                    variant={
                      ({ FAILED: 'danger', NOT_SYNCED: 'info', PENDING: 'warning', SYNCED: 'success' } as const)[
                        invoice.accountingSyncState
                      ]
                    }
                  >
                    {t(`siampark-billing-finance.demo.labels.${invoice.accountingSyncState}`)}
                  </Badge>
                </div>
              </Table.Cell>
              <Table.Cell>
                {invoice.dueDate}
                {invoice.businessState === 'CONFIRMED' &&
                invoice.paidMinor < invoice.totalMinor &&
                invoice.dueDate < '2026-10-05' ? (
                  <Badge size="sm" variant="danger">
                    {t('siampark-billing-finance.demo.overdue')}
                  </Badge>
                ) : null}
              </Table.Cell>
              <Table.Cell>
                <Button
                  onClick={() => {
                    setSelectedId(invoice.ref.resourceId);
                    setEditing(false);
                  }}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t('siampark-billing-finance.demo.detail')}
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

export const FinanceInvoiceDetail = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const {
    busy,
    canWrite,
    editDraft,
    money,
    paymentAmount,
    readCounterparty,
    runCommand,
    selected,
    selectedCounterparty,
    setFeedback,
    setPaymentAmount,
    snapshot,
    t,
  } = vm;
  if (selected === undefined) {
    return null;
  }
  return (
    <section
      aria-label={t('siampark-billing-finance.demo.detail')}
      className="siamparkbillingfinance:min-w-0 siamparkbillingfinance:space-y-5 siamparkbillingfinance:rounded-lg siamparkbillingfinance:border siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:bg-(--color-surface) siamparkbillingfinance:p-5"
    >
      <header className="siamparkbillingfinance:flex siamparkbillingfinance:flex-wrap siamparkbillingfinance:items-center siamparkbillingfinance:justify-between siamparkbillingfinance:gap-3 siamparkbillingfinance:border-b siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:pb-4">
        <h2 className="siamparkbillingfinance:text-lg siamparkbillingfinance:font-semibold">
          {selected.documentNumber}
        </h2>
        <p className="siamparkbillingfinance:text-xl siamparkbillingfinance:font-semibold siamparkbillingfinance:tabular-nums">
          {money(selected.totalMinor)}
        </p>
      </header>
      <div className="siamparkbillingfinance:flex siamparkbillingfinance:flex-wrap siamparkbillingfinance:items-center siamparkbillingfinance:justify-between siamparkbillingfinance:gap-3">
        <p className="siamparkbillingfinance:min-w-0 siamparkbillingfinance:break-all siamparkbillingfinance:text-sm siamparkbillingfinance:text-(--color-fg-secondary)">
          {t(counterpartyLabel)}: {selected.counterpartyRef.resourceId}
        </p>
        <Button
          disabled={busy}
          onClick={() => readCounterparty(selected)}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t('siampark-billing-finance.demo.counterpartyDetail')}
        </Button>
      </div>
      {selectedCounterparty !== undefined && (
        <section
          aria-label={t(counterpartyLabel)}
          className="siamparkbillingfinance:space-y-1 siamparkbillingfinance:rounded-lg siamparkbillingfinance:bg-(--color-surface-subtle) siamparkbillingfinance:p-4"
        >
          <h3 className="siamparkbillingfinance:font-medium">
            {selectedCounterparty.party.displayName ?? t('siampark-billing-finance.demo.unnamedCounterparty')}
          </h3>
          <p>
            {selectedCounterparty.party.partyType} ·{' '}
            {selectedCounterparty.currentRoles
              .map((role) =>
                t(`siampark-billing-finance.demo.partyRoles.${role.roleType}`, { defaultValue: role.roleType }),
              )
              .join(', ')}
          </p>
        </section>
      )}
      <p className="siamparkbillingfinance:text-sm siamparkbillingfinance:font-medium siamparkbillingfinance:tabular-nums">
        {t('siampark-billing-finance.demo.paid', { amount: money(selected.paidMinor) })}
      </p>
      {canWrite && (
        <>
          <div className="siamparkbillingfinance:grid siamparkbillingfinance:gap-4 siamparkbillingfinance:lg:grid-cols-2">
            <section className="siamparkbillingfinance:space-y-3 siamparkbillingfinance:rounded-lg siamparkbillingfinance:bg-(--color-surface-subtle) siamparkbillingfinance:p-4">
              <h3 className="siamparkbillingfinance:text-sm siamparkbillingfinance:font-medium">
                {t('siampark-billing-finance.demo.invoiceActions')}
              </h3>
              <div className="siamparkbillingfinance:flex siamparkbillingfinance:flex-wrap siamparkbillingfinance:gap-2">
                <Button
                  disabled={busy || selected.businessState !== 'DRAFT'}
                  onClick={() => editDraft(selected)}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t('siampark-billing-finance.demo.edit')}
                </Button>
                <Button
                  disabled={busy || selected.businessState !== 'DRAFT'}
                  onClick={() => runCommand({ _tag: 'ConfirmInvoice', invoiceRef: selected.ref })}
                  size="sm"
                  variant="warning"
                >
                  {t('siampark-billing-finance.demo.confirm')}
                </Button>
                <Button
                  disabled={
                    busy ||
                    selected.businessState === 'VOIDED' ||
                    selected.paidMinor > 0 ||
                    ['PENDING', 'SYNCED'].includes(selected.accountingSyncState)
                  }
                  onClick={() => runCommand({ _tag: 'VoidInvoice', invoiceRef: selected.ref })}
                  size="sm"
                  theme="outlined"
                  variant="danger"
                >
                  {t('siampark-billing-finance.demo.void')}
                </Button>
              </div>
            </section>
            <section className="siamparkbillingfinance:space-y-3 siamparkbillingfinance:rounded-lg siamparkbillingfinance:bg-(--color-surface-subtle) siamparkbillingfinance:p-4">
              <h3 className="siamparkbillingfinance:text-sm siamparkbillingfinance:font-medium">
                {t('siampark-billing-finance.demo.accountingActions')}
              </h3>
              <div className="siamparkbillingfinance:flex siamparkbillingfinance:flex-wrap siamparkbillingfinance:gap-2">
                <Button
                  disabled={
                    busy || selected.businessState !== 'CONFIRMED' || selected.accountingSyncState !== 'NOT_SYNCED'
                  }
                  onClick={() => runCommand({ _tag: 'RequestAccountingSync', invoiceRef: selected.ref })}
                  size="sm"
                  variant="warning"
                >
                  {t('siampark-billing-finance.demo.sync')}
                </Button>
                <Button
                  disabled={busy || selected.accountingSyncState !== 'FAILED'}
                  onClick={() => runCommand({ _tag: 'RetryAccountingSync', invoiceRef: selected.ref })}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t('siampark-billing-finance.demo.retry')}
                </Button>
                <Button
                  disabled={busy || selected.accountingSyncState !== 'PENDING'}
                  onClick={() => {
                    void financeBrowserRuntime.runPromise(
                      browserCrypto.randomUUIDv4.pipe(
                        Effect.match({
                          onFailure: (failure) => setFeedback(financeFailureFeedback(failure)),
                          onSuccess: (resultId) =>
                            runCommand({
                              _tag: 'ApplyAccountingObservation',
                              correlation: selected.accountingCorrelation,
                              invoiceRef: selected.ref,
                              receipt: `demo-accounting-receipt:${selected.ref.resourceId}`,
                              resultId,
                              status: 'SUCCESS',
                            }),
                        }),
                      ),
                    );
                  }}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t('siampark-billing-finance.demo.observeAccounting')}
                </Button>
              </div>
            </section>
          </div>
          <div className="siamparkbillingfinance:grid siamparkbillingfinance:items-end siamparkbillingfinance:gap-3 siamparkbillingfinance:rounded-lg siamparkbillingfinance:border siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:p-4 siamparkbillingfinance:sm:grid-cols-[minmax(0,1fr)_auto]">
            <FormInput
              id="finance-paymentAmount"
              label={t('siampark-billing-finance.demo.payment')}
              onChange={(event) => setPaymentAmount(event.target.value)}
              value={paymentAmount}
            />
            <Button
              disabled={busy || selected.businessState !== 'CONFIRMED'}
              onClick={() => {
                const confirmedPaidMinor = parseMoney(paymentAmount);
                if (confirmedPaidMinor === undefined) {
                  setFeedback('validation');
                  return;
                }
                void financeBrowserRuntime.runPromise(
                  browserCrypto.randomUUIDv4.pipe(
                    Effect.match({
                      onFailure: (failure) => setFeedback(financeFailureFeedback(failure)),
                      onSuccess: (resultId) =>
                        runCommand({
                          _tag: 'ApplyPaymentObservation',
                          confirmedPaidMinor,
                          correlation: `demo-payment:${selected.ref.resourceId}`,
                          currency: 'CZK',
                          invoiceRef: selected.ref,
                          resultId,
                        }),
                    }),
                  ),
                );
              }}
              size="sm"
              variant="warning"
            >
              {t('siampark-billing-finance.demo.observePayment')}
            </Button>
          </div>
        </>
      )}
      <p className="siamparkbillingfinance:break-all siamparkbillingfinance:text-sm siamparkbillingfinance:text-(--color-fg-secondary)">
        {selected.externalAccountingReference ?? t('siampark-billing-finance.demo.noReceipt')}
      </p>
      <div className="siamparkbillingfinance:min-w-0 siamparkbillingfinance:overflow-x-auto siamparkbillingfinance:rounded-lg siamparkbillingfinance:bg-(--color-surface)">
        <Table className="siamparkbillingfinance:w-full" size="sm" variant="outline">
          <Table.Caption>{t('siampark-billing-finance.demo.history')}</Table.Caption>
          <Table.Body>
            {snapshot?.state.accountingObservations.flatMap((record) =>
              record.invoiceRef.resourceId === selected.ref.resourceId
                ? [
                    <Table.Row key={record.attemptId}>
                      <Table.Cell>
                        {record.providerLabel} · {record.mode}
                      </Table.Cell>
                      <Table.Cell>{record.correlation}</Table.Cell>
                      <Table.Cell>{record.resultSummary}</Table.Cell>
                    </Table.Row>,
                  ]
                : [],
            )}
          </Table.Body>
        </Table>
      </div>
      <div className="siamparkbillingfinance:min-w-0 siamparkbillingfinance:overflow-x-auto siamparkbillingfinance:rounded-lg siamparkbillingfinance:bg-(--color-surface)">
        <Table className="siamparkbillingfinance:w-full" size="sm" variant="outline">
          <Table.Caption>{t('siampark-billing-finance.demo.paymentHistory')}</Table.Caption>
          <Table.Header className="siamparkbillingfinance:bg-(--color-surface-subtle)">
            <Table.Row>
              {['observedAt', 'correlation', 'resultId', 'confirmedAmount'].map((key) => (
                <Table.ColumnHeader key={key}>{t(`siampark-billing-finance.demo.${key}`)}</Table.ColumnHeader>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {snapshot?.state.paymentObservations.flatMap((record) =>
              record.invoiceRef.tenantId === selected.ref.tenantId &&
              record.invoiceRef.resourceId === selected.ref.resourceId
                ? [
                    <Table.Row key={record.resultId}>
                      <Table.Cell>{DateTime.formatIso(record.observedAt)}</Table.Cell>
                      <Table.Cell>{record.correlation}</Table.Cell>
                      <Table.Cell>{record.resultId}</Table.Cell>
                      <Table.Cell>{money(record.confirmedPaidMinor)}</Table.Cell>
                    </Table.Row>,
                  ]
                : [],
            )}
          </Table.Body>
        </Table>
      </div>
      {snapshot !== undefined &&
        !snapshot.state.paymentObservations.some(
          (record) =>
            record.invoiceRef.tenantId === selected.ref.tenantId &&
            record.invoiceRef.resourceId === selected.ref.resourceId,
        ) && (
          <p className="siamparkbillingfinance:text-sm siamparkbillingfinance:text-(--color-fg-secondary)">
            {t('siampark-billing-finance.demo.noPayments')}
          </p>
        )}
    </section>
  );
};

export const FinanceDraftForm = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const {
    amount,
    busy,
    direction,
    documentNumber,
    dueDate,
    editing,
    issueDate,
    occupancies,
    occupancyId,
    parties,
    partyId,
    partyQuery,
    properties,
    propertyId,
    resetDraft,
    saveDraft,
    searchParties,
    selected,
    setAmount,
    setDirection,
    setDocumentNumber,
    setDueDate,
    setIssueDate,
    setOccupancyId,
    setParties,
    setPartyId,
    setPartyQuery,
    setPropertyId,
    t,
  } = vm;
  if (!vm.canWrite) {
    return null;
  }
  return (
    <section
      aria-label={t('siampark-billing-finance.demo.draft')}
      className="siamparkbillingfinance:min-w-0 siamparkbillingfinance:space-y-5 siamparkbillingfinance:rounded-lg siamparkbillingfinance:border siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:bg-(--color-surface) siamparkbillingfinance:p-5"
    >
      <h2 className="siamparkbillingfinance:border-b siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:pb-4 siamparkbillingfinance:text-lg siamparkbillingfinance:font-semibold">
        {t('siampark-billing-finance.demo.draft')}
      </h2>
      <div className="siamparkbillingfinance:grid siamparkbillingfinance:items-end siamparkbillingfinance:gap-4 siamparkbillingfinance:md:grid-cols-2">
        {editing ? (
          <p className="siamparkbillingfinance:break-all siamparkbillingfinance:text-sm siamparkbillingfinance:text-(--color-fg-secondary) siamparkbillingfinance:md:col-span-2">
            {selected?.counterpartyRef.resourceId} · {vm.propertyName(selected?.propertyRef?.resourceId)}
          </p>
        ) : (
          <>
            <Select
              items={['OUTGOING', 'INCOMING'].map((value) => ({
                label: t(`siampark-billing-finance.demo.labels.${value}`),
                value,
              }))}
              label={t('siampark-billing-finance.demo.direction')}
              onValueChange={({ value: values }) => {
                const [value] = values;
                if (value === 'INCOMING' || value === 'OUTGOING') {
                  setDirection(value);
                  setParties([]);
                  setPartyId('');
                }
              }}
              value={[direction]}
            />
            <div className="siamparkbillingfinance:grid siamparkbillingfinance:items-end siamparkbillingfinance:gap-3 siamparkbillingfinance:sm:grid-cols-[minmax(0,1fr)_auto]">
              <FormInput
                id="finance-partyQuery"
                label={t('siampark-billing-finance.demo.searchParty')}
                onChange={(event) => setPartyQuery(event.target.value)}
                value={partyQuery}
              />
              <Button disabled={busy} onClick={searchParties} size="sm" theme="outlined" variant="secondary">
                {t('siampark-billing-finance.demo.search')}
              </Button>
            </div>
            <Select
              items={parties.map((record) => ({ label: record.party.title, value: record.ref.resourceId }))}
              label={t(counterpartyLabel)}
              onValueChange={({ value }) => setPartyId(value[0] ?? '')}
              value={[partyId]}
            />
            <Select
              items={[
                { label: t('siampark-billing-finance.demo.none'), value: '' },
                ...(properties?.properties.map((record) => ({
                  label: record.name,
                  value: record.propertyRef.resourceId,
                })) ?? []),
              ]}
              label={t('siampark-billing-finance.demo.property')}
              onValueChange={({ value }) => setPropertyId(value[0] ?? '')}
              value={[propertyId]}
            />
            <Select
              items={[
                { label: t('siampark-billing-finance.demo.none'), value: '' },
                ...(occupancies?.occupancies.flatMap((record) =>
                  record.customerCounterpartyRef?.resourceId === partyId
                    ? [
                        {
                          label:
                            properties?.units.find((unit) => unit.unitRef.resourceId === record.unitRef.resourceId)
                              ?.name ?? record.unitRef.resourceId,
                          value: record.occupancyRef.resourceId,
                        },
                      ]
                    : [],
                ) ?? []),
              ]}
              label={t('siampark-billing-finance.demo.occupancy')}
              onValueChange={({ value }) => setOccupancyId(value[0] ?? '')}
              value={[occupancyId]}
            />
          </>
        )}
        <FormInput
          id="finance-documentNumber"
          label={t('siampark-billing-finance.demo.number')}
          onChange={(event) => setDocumentNumber(event.target.value)}
          value={documentNumber}
        />
        <FormInput
          id="finance-amount"
          label={t('siampark-billing-finance.demo.amount')}
          onChange={(event) => setAmount(event.target.value)}
          value={amount}
        />
        <FormInput
          id="finance-issueDate"
          label={t('siampark-billing-finance.demo.issue')}
          onChange={(event) => setIssueDate(event.target.value)}
          type="date"
          value={issueDate}
        />
        <FormInput
          id="finance-dueDate"
          label={t('siampark-billing-finance.demo.due')}
          onChange={(event) => setDueDate(event.target.value)}
          type="date"
          value={dueDate}
        />
      </div>
      <div className="siamparkbillingfinance:flex siamparkbillingfinance:flex-wrap siamparkbillingfinance:gap-2 siamparkbillingfinance:border-t siamparkbillingfinance:border-(--color-border-muted) siamparkbillingfinance:pt-4">
        <Button disabled={busy} onClick={saveDraft} size="sm" variant="warning">
          {t(editing ? 'siampark-billing-finance.demo.save' : 'siampark-billing-finance.demo.create')}
        </Button>
        {editing && (
          <Button disabled={busy} onClick={resetDraft} size="sm" theme="outlined" variant="secondary">
            {t('siampark-billing-finance.demo.newInvoice')}
          </Button>
        )}
      </div>
    </section>
  );
};

export const FinancePlanTable = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const { filterPropertyId, money, propertyName, snapshot, t } = vm;
  return (
    <div className="siamparkbillingfinance:min-w-0 siamparkbillingfinance:overflow-x-auto siamparkbillingfinance:rounded-lg siamparkbillingfinance:bg-(--color-surface)">
      <Table className="siamparkbillingfinance:w-full" size="sm" variant="outline">
        <Table.Caption>{t('siampark-billing-finance.demo.plan')}</Table.Caption>
        <Table.Header className="siamparkbillingfinance:bg-(--color-surface-subtle)">
          <Table.Row>
            {['property', 'period', 'category', 'kind', 'amount', 'states'].map((key) => (
              <Table.ColumnHeader key={key}>{t(`siampark-billing-finance.demo.${key}`)}</Table.ColumnHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {snapshot?.state.financialPlanEntries.flatMap((record) =>
            filterPropertyId === '' || record.propertyRef.resourceId === filterPropertyId
              ? [
                  <Table.Row key={record.ref.resourceId} selected={vm.requestedId === record.ref.resourceId}>
                    <Table.Cell>{propertyName(record.propertyRef.resourceId)}</Table.Cell>
                    <Table.Cell>
                      {record.periodStart} → {record.periodEndExclusive}
                    </Table.Cell>
                    <Table.Cell>{record.category}</Table.Cell>
                    <Table.Cell>{t(`siampark-billing-finance.demo.labels.${record.kind}`)}</Table.Cell>
                    <Table.Cell className="siamparkbillingfinance:font-medium siamparkbillingfinance:whitespace-nowrap siamparkbillingfinance:tabular-nums">
                      {money(record.plannedMinor)}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="sm" variant={record.state === 'PLANNED' ? 'info' : 'outline'}>
                        {t(`siampark-billing-finance.demo.labels.${record.state}`)}
                      </Badge>
                    </Table.Cell>
                  </Table.Row>,
                ]
              : [],
          )}
        </Table.Body>
      </Table>
    </div>
  );
};
