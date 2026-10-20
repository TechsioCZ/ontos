import { RecordDiscussion } from '@app/siampark-ops/ui/record-discussion';
import { DetailList, PageHeader, SectionCard, SidePanel, formatDate, formatMoney } from '@app/admin-ui';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useRecordsPage } from './use-agreements-records.ts';
import { ContractLinksCard, ContractTermsCard, ContractTermsForm, contractMonthlyTotal } from './contract-terms.tsx';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-agreements.json';
import enResource from '../../../../../locales/en/siampark-agreements.json';
import '../../../index.css';

const LABEL_DETAIL = 'siampark-agreements.demo.detail';
const LABEL_OTHER = 'siampark-agreements.demo.kinds.OTHER';
const LABEL_CREATE = 'siampark-agreements.demo.create';
const siamparkAgreementsI18nResources = {
  cs: { 'siampark-agreements': csResource },
  en: { 'siampark-agreements': enResource },
} as const;
const AgreementsDetail = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const {
    busy,
    customerName,
    customerNameFeedback,
    editDraft,
    feedback,
    language,
    recordSignature,
    renew,
    runCommand,
    selected,
    t,
    unitName,
  } = state;
  if (selected === undefined) {
    return (
      <>
        <LinkButton
          href={`/${language}/siampark/agreements`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {t('siampark-agreements.detail.back')}
        </LinkButton>
        <PageHeader title={t(LABEL_DETAIL)} />
        <output aria-live="polite">
          {t(
            feedback === 'ready'
              ? 'siampark-agreements.detail.notFound'
              : `siampark-agreements.demo.feedback.${feedback}`,
          )}
        </output>
      </>
    );
  }
  return (
    <>
      <div>
        <LinkButton
          href={`/${language}/siampark/agreements`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {t('siampark-agreements.detail.back')}
        </LinkButton>
      </div>
      <PageHeader description={t(`siampark-agreements.demo.kinds.${selected.kind}`)} title={state.titleOf(selected)} />
      {feedback !== 'ready' && <output aria-live="polite">{t(`siampark-agreements.demo.feedback.${feedback}`)}</output>}
      <div className="siamparkagreements:grid siamparkagreements:grid-cols-1 siamparkagreements:items-start siamparkagreements:gap-6 siamparkagreements:xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="siamparkagreements:min-w-0 siamparkagreements:space-y-6">
          <div className="siamparkagreements:grid siamparkagreements:gap-6 siamparkagreements:md:grid-cols-2">
            <SectionCard title={t('siampark-agreements.detail.contract')}>
              <DetailList
                items={[
                  {
                    label: t('siampark-agreements.demo.contractKind'),
                    value: t(`siampark-agreements.demo.kinds.${selected.kind}`),
                  },
                  { label: t('siampark-agreements.demo.unit'), value: unitName(selected.unitRef?.resourceId) },
                  { label: t('siampark-agreements.demo.startDate'), value: formatDate(selected.startDate) },
                  {
                    label: t('siampark-agreements.demo.endDate'),
                    value:
                      selected.endDate === null ? t('siampark-agreements.demo.openEnd') : formatDate(selected.endDate),
                  },
                ]}
              />
            </SectionCard>
            <SectionCard title={t('siampark-agreements.demo.customer')}>
              <DetailList
                items={[
                  {
                    label: t('siampark-agreements.detail.customerName'),
                    value: customerName ?? t('siampark-agreements.detail.customerUnknown'),
                  },
                ]}
              />
              {customerNameFeedback !== undefined && (
                <output aria-live="polite">{t(`siampark-agreements.demo.feedback.${customerNameFeedback}`)}</output>
              )}
            </SectionCard>
          </div>
          <ContractTermsCard state={state} />
          <RecordDiscussion
            subject={{
              kind: 'contract',
              id: selected.contractRef.resourceId,
              label: selected.subject ?? unitName(selected.unitRef?.resourceId),
            }}
          />
          {selected.note !== null && (
            <SectionCard title={t('siampark-agreements.detail.note')}>
              <p className="siamparkagreements:whitespace-pre-wrap siamparkagreements:text-sm">{selected.note}</p>
            </SectionCard>
          )}
          <SectionCard title={t('siampark-agreements.demo.documents')}>
            {state.detailView.documents.length === 0 && (
              <p className="siamparkagreements:text-sm">{t('siampark-agreements.detail.noDocuments')}</p>
            )}
            {state.detailView.documents.map((record) => (
              <p
                className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:items-center siamparkagreements:gap-3 siamparkagreements:rounded-lg siamparkagreements:border siamparkagreements:border-(--color-border-muted) siamparkagreements:p-4 siamparkagreements:text-sm"
                key={record.documentRef.resourceId}
              >
                {record.title} · {record.fileName} ·{' '}
                <Badge size="sm" variant={record.lifecycleState === 'FINAL' ? 'success' : 'outline'}>
                  {t(`siampark-agreements.demo.documentLabels.${record.lifecycleState}`)}
                </Badge>{' '}
                {record.signedDocumentReference ?? t('siampark-agreements.demo.metadataOnly')} {record.signedBy ?? ''}{' '}
                {record.signedOn ?? ''}
                {record.lifecycleState !== 'ARCHIVED' && (
                  <Button
                    disabled={busy}
                    onClick={() => runCommand({ _tag: 'ArchiveDocument', documentRef: record.documentRef })}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {t('siampark-agreements.demo.archive')}
                  </Button>
                )}
              </p>
            ))}
          </SectionCard>
          {state.detailView.canRecordSignature && (
            <form
              className="siamparkagreements:w-full siamparkagreements:space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                recordSignature(selected);
              }}
            >
              <p className="siamparkagreements:text-sm">{t('siampark-agreements.demo.manualSignatureHint')}</p>
              {(
                [
                  ['signedBy', state.signedBy, state.setSignedBy],
                  ['signedFileName', state.signedFileName, state.setSignedFileName],
                  ['signedReference', state.signedReference, state.setSignedReference],
                  ['signedOn', state.signedOn, state.setSignedOn],
                ] as const
              ).map(([field, value, change]) => (
                <FormInput
                  disabled={busy}
                  id={`contract-${field}`}
                  key={field}
                  label={t(`siampark-agreements.demo.${field}`)}
                  onChange={(event) => change(event.target.value)}
                  required
                  type={field === 'signedOn' ? 'date' : 'text'}
                  value={value}
                />
              ))}
              <Button disabled={busy} size="sm" type="submit" variant="warning">
                {t('siampark-agreements.demo.recordSignature')}
              </Button>
            </form>
          )}

          {state.detailView.signatureObservations.map((record) => (
            <p
              className="siamparkagreements:space-y-2 siamparkagreements:break-words siamparkagreements:rounded-lg siamparkagreements:bg-(--color-surface-subtle) siamparkagreements:p-4 siamparkagreements:text-sm siamparkagreements:text-(--color-fg-secondary)"
              key={record.observationId}
            >
              <Badge variant="info">{t('siampark-agreements.demo.simulated')}</Badge> {record.correlation} ·{' '}
              {t(`siampark-agreements.demo.signatureLabels.${record.state}`)}
              <br />
              {t('siampark-agreements.demo.provider')}: {record.providerLabel} · {record.integrationKind}
              <br />
              {t('siampark-agreements.demo.attemptedAt')}: {record.attemptedAt}
              {record.completedAt !== null && (
                <>
                  <br />
                  {t('siampark-agreements.demo.completedAt')}: {record.completedAt}
                </>
              )}
              <br />
              {t('siampark-agreements.demo.ownerReference')}: {record.ownerResourceRef.resourceId}
              <br />
              {t('siampark-agreements.demo.signer')}: {record.signer.displayName ?? record.signer.partyRef.resourceId} ·{' '}
              {record.signer.contact}
              <br />
              {t('siampark-agreements.demo.requestSummary')}: {record.requestSummary}
              <br />
              {t('siampark-agreements.demo.resultSummary')}: {record.resultSummary}
            </p>
          ))}
        </div>
        <div className="siamparkagreements:min-w-0 siamparkagreements:space-y-6">
          <SectionCard title={t('siampark-agreements.detail.status')}>
            <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
              <Badge
                size="sm"
                variant={
                  ({ ACTIVE: 'success', DRAFT: 'outline', EXPIRED: 'warning', TERMINATED: 'danger' } as const)[
                    selected.lifecycleState
                  ]
                }
              >
                {t(`siampark-agreements.demo.lifecycleLabels.${selected.lifecycleState}`)}
              </Badge>
              <Badge
                size="sm"
                variant={
                  ({ DECLINED: 'danger', NOT_SENT: 'outline', SENT: 'info', SIGNED: 'success' } as const)[
                    selected.signatureState
                  ]
                }
              >
                {t(`siampark-agreements.demo.signatureLabels.${selected.signatureState}`)}
              </Badge>
            </div>
          </SectionCard>
          <ContractLinksCard state={state} />
          {selected.supersedesContractRef !== null && (
            <SectionCard title={t('siampark-agreements.demo.supersedes')}>
              <LinkButton
                href={`/${language}/siampark/agreements?resourceId=${selected.supersedesContractRef.resourceId}`}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(LABEL_DETAIL)}
              </LinkButton>
            </SectionCard>
          )}
          <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
            {state.detailView.canEdit && (
              <Button disabled={busy} onClick={editDraft} size="sm" theme="outlined" variant="secondary">
                {t('siampark-agreements.demo.editDraft')}
              </Button>
            )}
            {state.detailView.canActivate && (
              <Button
                disabled={busy}
                onClick={() => runCommand({ _tag: 'ActivateContract', contractRef: selected.contractRef })}
                size="sm"
                variant="warning"
              >
                {t('siampark-agreements.demo.activate')}
              </Button>
            )}
            {state.detailView.canRenew && (
              <>
                <Button
                  disabled={busy || selected.hasSuccessorDraft}
                  onClick={() => renew(selected)}
                  size="sm"
                  variant="warning"
                >
                  {t('siampark-agreements.demo.renew')}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => runCommand({ _tag: 'TerminateContract', contractRef: selected.contractRef })}
                  size="sm"
                  theme="outlined"
                  variant="danger"
                >
                  {t('siampark-agreements.demo.terminate')}
                </Button>
              </>
            )}
            {selected.occupancyRef !== null && (
              <a
                className="siamparkagreements:inline-flex siamparkagreements:items-center siamparkagreements:text-sm siamparkagreements:underline siamparkagreements:underline-offset-4"
                href={`/${language}/siampark/occupancy?resourceId=${selected.occupancyRef.resourceId}`}
              >
                {t('siampark-agreements.demo.occupancy')}
              </a>
            )}
          </div>
        </div>
      </div>
      <ContractTermsForm state={state} />
    </>
  );
};
const AgreementsDraftForm = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const {
    busy,
    createContract,
    editingDraft,
    endDate,
    feedback,
    occupancies,
    occupancyId,
    saveDraft,
    selected,
    setEndDate,
    setOccupancyId,
    setStartDate,
    startDate,
    t,
    unitName,
  } = state;
  if (!state.formOpen) {
    return null;
  }
  const confirmedLeases = (occupancies?.occupancies ?? []).filter(
    (record) => record.kind === 'LONG_TERM_LEASE' && record.state === 'CONFIRMED',
  );
  const commercialCustomers = state.customers.flatMap((item) =>
    item.status === 'ACTIVE' ? [{ label: item.displayName ?? item.partyId, value: item.partyId }] : [],
  );
  const customerValues = state.customerId.length === 0 ? [] : [state.customerId];
  const formLabel = editingDraft ? 'siampark-agreements.demo.editDraft' : LABEL_CREATE;
  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={() => state.setFormOpen(false)} theme="outlined" variant="secondary">
            {t('siampark-agreements.detail.close')}
          </Button>
          <Button
            disabled={busy}
            isLoading={feedback === 'saving'}
            onClick={editingDraft ? saveDraft : createContract}
            variant="primary"
          >
            {t(editingDraft ? 'siampark-agreements.demo.saveDraft' : LABEL_CREATE)}
          </Button>
        </>
      }
      closeLabel={t('siampark-agreements.detail.close')}
      closeOnInteractOutside={false}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#contract-start-date')}
      onOpenChange={(open) => {
        if (!open && !busy) {
          state.setFormOpen(false);
        }
      }}
      open
      resizeLabel={t('siampark-agreements.detail.resizePanel')}
      size="lg"
      title={t(formLabel)}
    >
      <div className="siamparkagreements:space-y-4 siamparkagreements:py-2">
        {feedback !== 'ready' && (
          <output aria-live="polite">{t(`siampark-agreements.demo.feedback.${feedback}`)}</output>
        )}
        {!editingDraft && (
          <Select
            items={(['OTHER', 'LEASE'] as const).map((value) => ({
              label: t(`siampark-agreements.demo.kinds.${value}`),
              value,
            }))}
            onValueChange={({ value }) => state.selectContractKind(value[0] === 'LEASE' ? 'LEASE' : 'OTHER')}
            value={[state.contractKind]}
          >
            <Select.Label>{t('siampark-agreements.demo.contractKind')}</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {(['OTHER', 'LEASE'] as const).map((value) => (
                  <Select.Item item={{ label: t(`siampark-agreements.demo.kinds.${value}`), value }} key={value}>
                    <Select.ItemText>{t(`siampark-agreements.demo.kinds.${value}`)}</Select.ItemText>
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select>
        )}
        {state.formView.showCommercialCustomer && (
          <Select
            items={commercialCustomers}
            onValueChange={({ value }) => state.setCustomerId(value[0] ?? '')}
            value={customerValues}
          >
            <Select.Label>{t('siampark-agreements.demo.customer')}</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText placeholder={t('siampark-agreements.demo.choose')} />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {commercialCustomers.map((item) => (
                  <Select.Item item={item} key={item.value}>
                    <Select.ItemText>{item.label}</Select.ItemText>
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select>
        )}
        {state.formView.showRentalFeedback && (
          <output aria-live="polite">{t(`siampark-agreements.demo.feedback.${state.rentalFeedback}`)}</output>
        )}
        {editingDraft && <p>{selected?.kind === 'OTHER' ? t(LABEL_OTHER) : unitName(selected?.unitRef?.resourceId)}</p>}
        {state.formView.showRentalSelector && (
          <Select
            items={confirmedLeases.map((record) => ({
              label: unitName(record.unitRef.resourceId),
              value: record.occupancyRef.resourceId,
            }))}
            onValueChange={({ value }) => {
              setOccupancyId(value[0] ?? '');
              const record = occupancies?.occupancies.find(
                (candidate) => candidate.occupancyRef.resourceId === value[0],
              );
              if (record !== undefined) {
                setStartDate(record.startDate);
                setEndDate(record.endDate ?? '');
              }
            }}
            value={occupancyId.length > 0 ? [occupancyId] : []}
          >
            <Select.Label>{t('siampark-agreements.demo.occupancy')}</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText placeholder={t('siampark-agreements.demo.choose')} />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {confirmedLeases.map((record) => (
                  <Select.Item
                    item={{ label: unitName(record.unitRef.resourceId), value: record.occupancyRef.resourceId }}
                    key={record.occupancyRef.resourceId}
                  >
                    <Select.ItemText>{unitName(record.unitRef.resourceId)}</Select.ItemText>
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select>
        )}
        <div className="siamparkagreements:grid siamparkagreements:gap-4 siamparkagreements:md:grid-cols-2">
          <FormInput
            id="contract-start-date"
            label={t('siampark-agreements.demo.startDate')}
            onChange={(event) => setStartDate(event.target.value)}
            type="date"
            value={startDate}
          />
          <FormInput
            id="contract-end-date"
            label={t('siampark-agreements.demo.endDate')}
            onChange={(event) => setEndDate(event.target.value)}
            type="date"
            value={endDate}
          />
        </div>
      </div>
    </SidePanel>
  );
};
const RecordsPageContent = () => {
  const state = useRecordsPage();
  const {
    busy,
    expiringOnly,
    feedback,
    refresh,
    setExpiringOnly,

    snapshot,
    t,
    unitName,
    visible,
  } = state;
  return (
    <>
      <UltramodernRouteHead />
      <section className="siamparkagreements:w-full siamparkagreements:min-w-0 siamparkagreements:max-w-none siamparkagreements:space-y-6 siamparkagreements:p-0 siamparkagreements:text-(--color-page-fg)">
        {state.linkedResourceId === undefined ? (
          <>
            <PageHeader
              actions={
                <Button
                  disabled={busy || snapshot === undefined}
                  onClick={() => state.resetDraftForm()}
                  size="sm"
                  variant="primary"
                >
                  {t('siampark-agreements.detail.newContract')}
                </Button>
              }
              description={t('siampark-agreements.pages.records.description')}
              meta={
                <output aria-live="polite">
                  <Badge
                    size="sm"
                    variant={
                      (
                        {
                          conflict: 'warning',
                          forbidden: 'danger',
                          loading: 'info',
                          ready: 'success',
                          saving: 'info',
                          unavailable: 'danger',
                          validation: 'warning',
                        } as const
                      )[feedback]
                    }
                  >
                    {t(`siampark-agreements.demo.feedback.${feedback}`)}
                  </Badge>
                </output>
              }
              title={t('siampark-agreements.pages.records.title')}
            />
            <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:items-center siamparkagreements:justify-between siamparkagreements:gap-4 siamparkagreements:border-b siamparkagreements:border-(--color-border-muted) siamparkagreements:pb-4">
              <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
                <Button
                  aria-pressed={!expiringOnly}
                  onClick={() => setExpiringOnly(false)}
                  size="sm"
                  theme="borderless"
                  variant={expiringOnly ? 'secondary' : 'warning'}
                >
                  {t('siampark-agreements.demo.all')}
                </Button>
                <Button
                  aria-pressed={expiringOnly}
                  onClick={() => setExpiringOnly(true)}
                  size="sm"
                  theme="borderless"
                  variant={expiringOnly ? 'warning' : 'secondary'}
                >
                  {t('siampark-agreements.demo.expiring')}
                </Button>
              </div>
              <Button disabled={busy} onClick={refresh} size="sm" theme="outlined" variant="secondary">
                {t('siampark-agreements.demo.refresh')}
              </Button>
            </div>
            {snapshot !== undefined && visible.length === 0 && (
              <p className="siamparkagreements:rounded-lg siamparkagreements:bg-(--color-surface-subtle) siamparkagreements:p-5 siamparkagreements:text-sm siamparkagreements:text-(--color-fg-secondary)">
                {t('siampark-agreements.demo.empty')}
              </p>
            )}
            <div className="siamparkagreements:overflow-x-auto siamparkagreements:rounded-lg siamparkagreements:bg-(--color-surface)">
              <Table size="sm" variant="outline">
                <Table.Caption>{t('siampark-agreements.demo.list')}</Table.Caption>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>{t('siampark-agreements.demo.unit')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-agreements.demo.period')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-agreements.terms.column')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-agreements.demo.lifecycle')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-agreements.demo.signature')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(LABEL_DETAIL)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visible.map((record) => (
                    <Table.Row key={record.contractRef.resourceId}>
                      <Table.Cell>
                        <span className="siamparkagreements:font-medium">{state.titleOf(record)}</span>
                        {record.kind === 'LEASE' && (
                          <span className="siamparkagreements:block siamparkagreements:text-xs siamparkagreements:text-(--color-fg-secondary)">
                            {state.counterpartyOf(record)?.displayName ?? ''}
                            {record.subject === undefined ? '' : ` · ${record.subject}`}
                          </span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {formatDate(record.startDate)} –{' '}
                        {record.endDate === null ? t('siampark-agreements.demo.openEnd') : formatDate(record.endDate)}
                      </Table.Cell>
                      <Table.Cell>
                        <span className="siamparkagreements:tabular-nums">
                          {contractMonthlyTotal(record) === undefined
                            ? '—'
                            : formatMoney(contractMonthlyTotal(record) ?? 0)}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
                          <Badge
                            size="sm"
                            variant={
                              (
                                {
                                  ACTIVE: 'success',
                                  DRAFT: 'outline',
                                  EXPIRED: 'warning',
                                  TERMINATED: 'danger',
                                } as const
                              )[record.lifecycleState]
                            }
                          >
                            {t(`siampark-agreements.demo.lifecycleLabels.${record.lifecycleState}`)}
                          </Badge>
                          {record.expiringSoon && (
                            <Badge variant="warning">{t('siampark-agreements.demo.expiring')}</Badge>
                          )}
                          {record.hasSuccessorDraft && (
                            <Badge variant="info">{t('siampark-agreements.demo.successorExists')}</Badge>
                          )}
                          {record.isExpired && <Badge variant="warning">{t('siampark-agreements.demo.expired')}</Badge>}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge
                          size="sm"
                          variant={
                            ({ DECLINED: 'danger', NOT_SENT: 'outline', SENT: 'info', SIGNED: 'success' } as const)[
                              record.signatureState
                            ]
                          }
                        >
                          {t(`siampark-agreements.demo.signatureLabels.${record.signatureState}`)}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <LinkButton
                          href={`/${state.language}/siampark/agreements?resourceId=${record.contractRef.resourceId}`}
                          size="sm"
                          theme="outlined"
                          variant="secondary"
                        >
                          {t(LABEL_DETAIL)}
                        </LinkButton>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          </>
        ) : (
          <AgreementsDetail state={state} />
        )}
        <AgreementsDraftForm state={state} />
      </section>
    </>
  );
};
export const RecordsPage = () => {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-agreements"
      fallbackLanguage="en"
      resources={siamparkAgreementsI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={search} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
