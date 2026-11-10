import { RecordDiscussion } from '@app/facility-operations/ui/record-discussion';
import { DetailList, PageHeader, SectionCard, formatDate, formatMoney, surfaceTileClassName } from '@app/admin-ui';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Match } from 'effect';
import { useRecordsPage } from './use-agreements-records.ts';
import { AgreementsDraftForm } from './agreements-draft-form.tsx';
import { agreementsInputOf } from './agreements-data.ts';
import type { AgreementsInput } from './agreements-data.ts';
import { ContractLinksCard, ContractTermsCard, ContractTermsForm, contractMonthlyTotal } from './contract-terms.tsx';
import { AgreementDocumentDetail, AgreementDocumentStatus } from './document-detail.tsx';
import type { AgreementDocumentState } from './document-selection.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import csResource from '../../../../locales/cs/legal-agreements.json';
import enResource from '../../../../locales/en/legal-agreements.json';
import '../../index.css';

/**
 * A signed document is either a reachable file (shown as a link) or a paper original recorded only by its
 * reference; internal reference schemes such as `demo://` are never shown raw.
 */
const SignedDocumentReference = ({
  fallback,
  reference,
}: {
  readonly fallback: string;
  readonly reference: string | null;
}) => {
  if (reference === null) {
    return <span>{fallback}</span>;
  }
  if (/^https?:\/\//u.test(reference)) {
    return (
      <a className="legalagreements:underline" href={reference} rel="noreferrer" target="_blank">
        Otevřít podepsaný dokument
      </a>
    );
  }
  return <span>Podepsaný originál evidovaný ve spisu smlouvy (elektronická kopie není nahraná)</span>;
};

const LABEL_DETAIL = 'legal-agreements.demo.detail';
const legalAgreementsI18nResources = {
  cs: { 'legal-agreements': csResource },
  en: { 'legal-agreements': enResource },
} as const;
const AgreementDocumentPanel = ({
  language,
  state,
}: {
  readonly language: string;
  readonly state: AgreementDocumentState;
}) =>
  Match.value(state).pipe(
    Match.tag('Found', (found) => (
      <AgreementDocumentDetail
        archived={found.archived}
        document={found.document}
        language={language}
        parent={found.parent}
      />
    )),
    Match.orElse((missing) => <AgreementDocumentStatus language={language} state={missing} />),
  );

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
          href={`/${language}/smlouvy`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {t('legal-agreements.detail.back')}
        </LinkButton>
        <PageHeader title={t(LABEL_DETAIL)} />
        <output aria-live="polite">
          {t(feedback === 'ready' ? 'legal-agreements.detail.notFound' : `legal-agreements.demo.feedback.${feedback}`)}
        </output>
      </>
    );
  }
  return (
    <>
      <div>
        <LinkButton
          href={`/${language}/smlouvy`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {t('legal-agreements.detail.back')}
        </LinkButton>
      </div>
      <PageHeader description={t(`legal-agreements.demo.kinds.${selected.kind}`)} title={state.titleOf(selected)} />
      {feedback !== 'ready' && <output aria-live="polite">{t(`legal-agreements.demo.feedback.${feedback}`)}</output>}
      {state.proposal !== undefined && (
        <output aria-live="polite">{t('legal-agreements.demo.approvalRequired')}</output>
      )}
      <div className="legalagreements:grid legalagreements:grid-cols-1 legalagreements:items-start legalagreements:gap-6 legalagreements:xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="legalagreements:min-w-0 legalagreements:space-y-6">
          <div className="legalagreements:grid legalagreements:gap-6 legalagreements:md:grid-cols-2">
            <SectionCard title={t('legal-agreements.detail.contract')}>
              <DetailList
                items={[
                  {
                    label: t('legal-agreements.demo.contractKind'),
                    value: t(`legal-agreements.demo.kinds.${selected.kind}`),
                  },
                  { label: t('legal-agreements.demo.unit'), value: unitName(selected.unitRef?.resourceId) },
                  { label: t('legal-agreements.demo.startDate'), value: formatDate(selected.startDate) },
                  {
                    label: t('legal-agreements.demo.endDate'),
                    value:
                      selected.endDate === null ? t('legal-agreements.demo.openEnd') : formatDate(selected.endDate),
                  },
                ]}
              />
            </SectionCard>
            <SectionCard title={t('legal-agreements.demo.customer')}>
              <DetailList
                items={[
                  {
                    label: t('legal-agreements.detail.customerName'),
                    value: customerName ?? t('legal-agreements.detail.customerUnknown'),
                  },
                ]}
              />
              {customerNameFeedback !== undefined && (
                <output aria-live="polite">{t(`legal-agreements.demo.feedback.${customerNameFeedback}`)}</output>
              )}
            </SectionCard>
          </div>
          <ContractTermsCard state={state} />
          <RecordDiscussion
            subject={{
              id: selected.contractRef.resourceId,
              kind: 'contract',
              label: selected.subject ?? unitName(selected.unitRef?.resourceId),
            }}
          />
          {selected.note !== null && (
            <SectionCard title={t('legal-agreements.detail.note')}>
              <p className="legalagreements:whitespace-pre-wrap legalagreements:text-sm">{selected.note}</p>
            </SectionCard>
          )}
          <SectionCard title={t('legal-agreements.demo.documents')}>
            {state.detailView.documents.length === 0 && (
              <p className="legalagreements:text-sm">{t('legal-agreements.detail.noDocuments')}</p>
            )}
            {state.detailView.documents.map((record) => (
              <p
                className={`${surfaceTileClassName} legalagreements:flex legalagreements:flex-wrap legalagreements:items-center legalagreements:gap-3 legalagreements:p-4 legalagreements:text-sm`}
                key={record.documentRef.resourceId}
              >
                {record.title} · {record.fileName} ·{' '}
                <Badge size="sm" variant={record.lifecycleState === 'FINAL' ? 'success' : 'outline'}>
                  {t(`legal-agreements.demo.documentLabels.${record.lifecycleState}`)}
                </Badge>{' '}
                <SignedDocumentReference
                  fallback={t('legal-agreements.demo.metadataOnly')}
                  reference={record.signedDocumentReference}
                />
                {record.signedBy === undefined ? '' : ` · podepsal(a) ${record.signedBy}`}
                {record.signedOn === undefined ? '' : ` · ${formatDate(record.signedOn)}`}
                {record.lifecycleState !== 'ARCHIVED' && (
                  <Button
                    disabled={busy}
                    onClick={() => runCommand({ _tag: 'ArchiveDocument', documentRef: record.documentRef })}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {t('legal-agreements.demo.archive')}
                  </Button>
                )}
              </p>
            ))}
          </SectionCard>
          {state.detailView.canRecordSignature && (
            <form
              className="legalagreements:w-full legalagreements:space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                recordSignature(selected);
              }}
            >
              <p className="legalagreements:text-sm">{t('legal-agreements.demo.manualSignatureHint')}</p>
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
                  label={t(`legal-agreements.demo.${field}`)}
                  onChange={(event) => change(event.target.value)}
                  required
                  type={field === 'signedOn' ? 'date' : 'text'}
                  value={value}
                />
              ))}
              <Button disabled={busy} size="sm" type="submit" variant="warning">
                {t('legal-agreements.demo.recordSignature')}
              </Button>
            </form>
          )}
        </div>
        <div className="legalagreements:min-w-0 legalagreements:space-y-6">
          <SectionCard title={t('legal-agreements.detail.status')}>
            <div className="legalagreements:flex legalagreements:flex-wrap legalagreements:gap-2">
              <Badge
                size="sm"
                variant={
                  ({ ACTIVE: 'success', DRAFT: 'outline', EXPIRED: 'warning', TERMINATED: 'danger' } as const)[
                    selected.lifecycleState
                  ]
                }
              >
                {t(`legal-agreements.demo.lifecycleLabels.${selected.lifecycleState}`)}
              </Badge>
              <Badge
                size="sm"
                variant={
                  ({ DECLINED: 'danger', NOT_SENT: 'outline', SENT: 'info', SIGNED: 'success' } as const)[
                    selected.signatureState
                  ]
                }
              >
                {t(`legal-agreements.demo.signatureLabels.${selected.signatureState}`)}
              </Badge>
            </div>
          </SectionCard>
          <ContractLinksCard state={state} />
          {selected.supersedesContractRef !== null && (
            <SectionCard title={t('legal-agreements.demo.supersedes')}>
              <LinkButton
                href={`/${language}/smlouvy?resourceId=${selected.supersedesContractRef.resourceId}`}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(LABEL_DETAIL)}
              </LinkButton>
            </SectionCard>
          )}
          <div className="legalagreements:flex legalagreements:flex-wrap legalagreements:gap-2">
            {state.detailView.canEdit && (
              <Button disabled={busy} onClick={editDraft} size="sm" theme="outlined" variant="secondary">
                {t('legal-agreements.demo.editDraft')}
              </Button>
            )}
            {state.detailView.canActivate && (
              <Button
                disabled={busy}
                onClick={() => runCommand({ _tag: 'ActivateContract', contractRef: selected.contractRef })}
                size="sm"
                variant="warning"
              >
                {t('legal-agreements.demo.activate')}
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
                  {t('legal-agreements.demo.renew')}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => runCommand({ _tag: 'TerminateContract', contractRef: selected.contractRef })}
                  size="sm"
                  theme="outlined"
                  variant="danger"
                >
                  {t('legal-agreements.demo.terminate')}
                </Button>
              </>
            )}
            {selected.occupancyRef !== null && (
              <a
                className="legalagreements:inline-flex legalagreements:items-center legalagreements:text-sm legalagreements:underline legalagreements:underline-offset-4"
                href={`/${language}/najmy?resourceId=${selected.occupancyRef.resourceId}`}
              >
                {t('legal-agreements.demo.occupancy')}
              </a>
            )}
          </div>
        </div>
      </div>
      <ContractTermsForm state={state} />
    </>
  );
};
const RecordsPageContent = ({ input }: { readonly input: AgreementsInput }) => {
  const state = useRecordsPage(input);
  const {
    busy,
    expiringOnly,
    feedback,
    retry,
    setExpiringOnly,

    snapshot,
    t,
    visible,
  } = state;
  if (state.selectorIssue !== undefined || state.linkedDocumentId !== undefined) {
    return (
      <>
        <UltramodernRouteHead />
        <section className="legalagreements:w-full legalagreements:min-w-0 legalagreements:max-w-none legalagreements:space-y-6 legalagreements:p-0 legalagreements:text-(--color-page-fg)">
          <AgreementDocumentPanel language={state.language} state={state.documentState} />
          <AgreementsDraftForm state={state} />
        </section>
      </>
    );
  }
  return (
    <>
      <UltramodernRouteHead />
      <section className="legalagreements:w-full legalagreements:min-w-0 legalagreements:max-w-none legalagreements:space-y-6 legalagreements:p-0 legalagreements:text-(--color-page-fg)">
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
                  {t('legal-agreements.detail.newContract')}
                </Button>
              }
              description={t('legal-agreements.pages.records.description')}
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
                    {t(`legal-agreements.demo.feedback.${feedback}`)}
                  </Badge>
                </output>
              }
              title={t('legal-agreements.pages.records.title')}
            />
            <div className="legalagreements:flex legalagreements:flex-wrap legalagreements:items-center legalagreements:justify-between legalagreements:gap-4 legalagreements:pb-4">
              <div className="legalagreements:flex legalagreements:flex-wrap legalagreements:gap-2">
                <Button
                  aria-pressed={!expiringOnly}
                  onClick={() => setExpiringOnly(false)}
                  size="sm"
                  theme="borderless"
                  variant={expiringOnly ? 'secondary' : 'warning'}
                >
                  {t('legal-agreements.demo.all')}
                </Button>
                <Button
                  aria-pressed={expiringOnly}
                  onClick={() => setExpiringOnly(true)}
                  size="sm"
                  theme="borderless"
                  variant={expiringOnly ? 'warning' : 'secondary'}
                >
                  {t('legal-agreements.demo.expiring')}
                </Button>
              </div>
              {(feedback === 'unavailable' || feedback === 'forbidden') && (
                <Button disabled={busy} onClick={retry} size="sm" theme="outlined" variant="secondary">
                  {t('legal-agreements.demo.retry')}
                </Button>
              )}
            </div>
            {snapshot !== undefined && visible.length === 0 && (
              <p
                className={`${surfaceTileClassName} legalagreements:p-5 legalagreements:text-sm legalagreements:text-(--color-fg-secondary)`}
              >
                {t('legal-agreements.demo.empty')}
              </p>
            )}
            <div className="legalagreements:overflow-x-auto">
              <Table size="sm" variant="line">
                <Table.Caption>{t('legal-agreements.demo.list')}</Table.Caption>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>{t('legal-agreements.demo.unit')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('legal-agreements.demo.period')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('legal-agreements.terms.column')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('legal-agreements.demo.lifecycle')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('legal-agreements.demo.signature')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(LABEL_DETAIL)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visible.map((record) => (
                    <Table.Row key={record.contractRef.resourceId}>
                      <Table.Cell>
                        <span className="legalagreements:font-medium">{state.titleOf(record)}</span>
                        {record.kind === 'LEASE' && (
                          <span className="legalagreements:block legalagreements:text-xs legalagreements:text-(--color-fg-secondary)">
                            {state.counterpartyOf(record)?.displayName ?? ''}
                            {record.subject === undefined ? '' : ` · ${record.subject}`}
                          </span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {formatDate(record.startDate)} –{' '}
                        {record.endDate === null ? t('legal-agreements.demo.openEnd') : formatDate(record.endDate)}
                      </Table.Cell>
                      <Table.Cell>
                        <span className="legalagreements:tabular-nums">
                          {contractMonthlyTotal(record) === undefined
                            ? '—'
                            : formatMoney(contractMonthlyTotal(record) ?? 0)}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="legalagreements:flex legalagreements:flex-wrap legalagreements:gap-2">
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
                            {t(`legal-agreements.demo.lifecycleLabels.${record.lifecycleState}`)}
                          </Badge>
                          {record.expiringSoon && (
                            <Badge variant="warning">{t('legal-agreements.demo.expiring')}</Badge>
                          )}
                          {record.hasSuccessorDraft && (
                            <Badge variant="info">{t('legal-agreements.demo.successorExists')}</Badge>
                          )}
                          {record.isExpired && <Badge variant="warning">{t('legal-agreements.demo.expired')}</Badge>}
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
                          {t(`legal-agreements.demo.signatureLabels.${record.signatureState}`)}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <LinkButton
                          href={`/${state.language}/smlouvy?resourceId=${record.contractRef.resourceId}`}
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
export { preloadPage } from './agreements-data.ts';

/** Rendered by the Shell with the props its `preloadPage` received; standalone it reads the query from the router. */
export const RecordsPage = (props: Partial<ModulePageProps>) => {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const input = agreementsInputOf(props, search);
  return (
    <FederatedI18nBoundary
      defaultNamespace="legal-agreements"
      fallbackLanguage="en"
      resources={legalAgreementsI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent input={input} key={props.search ?? search} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
