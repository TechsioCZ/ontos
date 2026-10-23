import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { executeRecords as executeAccounting } from '@app/finance-billing/clients/records';
import { executeRecords as executeBookings } from '@app/property-leasing/clients/records';
import { executeRecords as executeSignatures } from '@app/legal-agreements/clients/records';
import { executeRecords as executeNotifications } from '@app/crm-activities/clients/records';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Table } from '@techsio/ui-kit/organisms/table';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { DateTime, Effect, Match, Random } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/property-portfolio.json';
import enResource from '../../../../../locales/en/property-portfolio.json';
import '../../../index.css';

const propertyPortfolioI18nResources = {
  cs: { 'property-portfolio': csResource },
  en: { 'property-portfolio': enResource },
} as const;

const loadOutcomes = Effect.fn('Property.Integrations.loadOutcomes')(function* loadOutcomes() {
  const requestId = Random.nextInt.pipe(Effect.map((id) => `property-integrations:${id}`));
  return yield* Effect.all(
    {
      accounting: requestId.pipe(Effect.flatMap((id) => executeAccounting({}, id))),
      booking: requestId.pipe(Effect.flatMap((id) => executeBookings({}, id))),
      notification: requestId.pipe(Effect.flatMap((id) => executeNotifications({}, id))),
      signature: requestId.pipe(Effect.flatMap((id) => executeSignatures({}, id))),
    },
    // Four independent owners: read them side by side instead of one after another.
    { concurrency: 4 },
  );
});

interface IntegrationsInput {
  readonly legalEntityId: string;
}
const integrationsData = definePageData({
  key: (input: IntegrationsInput) => input.legalEntityId,
  load: () => loadOutcomes(),
  runtime: browserRuntime,
});
const integrationsInput = (context: ModulePageProps['context']): IntegrationsInput => ({
  legalEntityId: context?.legalEntityId ?? '',
});
export const preloadPage = modulePagePreload((props) => integrationsData.preload(integrationsInput(props.context)));

const IntegrationsPageContent = ({ legalEntityId }: IntegrationsInput) => {
  const { language, t } = useModernI18n();
  const headingId = 'integrations-heading';
  const key = 'property-portfolio.pages.integrations';
  const snapshot = useSyncExternalStore(
    integrationsData.subscribe,
    () => integrationsData.snapshot({ legalEntityId }),
    () => pageDataPending,
  );
  useEffect(() => {
    integrationsData.ensure({ legalEntityId });
  }, [legalEntityId]);
  const records = snapshot.state === 'ready' ? snapshot.value : undefined;
  const loading = snapshot.state === 'pending' || snapshot.refreshing;
  const message =
    snapshot.state === 'failed'
      ? Match.value(snapshot.error).pipe(
          Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
          Match.orElse(() => t(`${key}.unavailable`)),
        )
      : '';
  const refresh = () => {
    void browserRuntime.runPromise(integrationsData.refresh({ legalEntityId }));
  };

  const ownerHref = (owner: string, resourceId: string) =>
    `/${language ?? 'cs'}/${owner}?resourceId=${encodeURIComponent(resourceId)}`;
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="propertyportfolio:w-full propertyportfolio:min-w-0 propertyportfolio:max-w-none propertyportfolio:space-y-6 propertyportfolio:p-0 propertyportfolio:text-(--color-page-fg)"
      >
        <header className="propertyportfolio:flex propertyportfolio:flex-wrap propertyportfolio:items-start propertyportfolio:justify-between propertyportfolio:gap-4 propertyportfolio:pb-5">
          <div className="propertyportfolio:min-w-0 propertyportfolio:space-y-2">
            <h1
              className="propertyportfolio:text-3xl propertyportfolio:font-semibold propertyportfolio:tracking-tight"
              id={headingId}
            >
              {t(`${key}.title`)}
            </h1>
            <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
              {t(`${key}.simulation`)}
            </p>
          </div>
          <Button isLoading={loading} onClick={refresh} size="sm" variant="warning">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output
          aria-live="polite"
          className="propertyportfolio:block propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)"
        >
          {message}
        </output>
        {records !== undefined && (
          <div className="propertyportfolio:space-y-6">
            <section
              aria-label={t(`${key}.accounting`)}
              className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:p-5"
            >
              <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.accounting`)}</h2>

              <div className="propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto">
                <Table className="propertyportfolio:w-full" size="sm" variant="line">
                  <Table.Caption>{t(`${key}.accounting`)}</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      {['correlation', 'attempt', 'attemptedAt', 'state', 'summary'].map((column) => (
                        <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {records.accounting.state.accountingObservations.map((item) => (
                      <Table.Row key={item.attemptId}>
                        <Table.Cell className="propertyportfolio:font-medium">
                          <Link href={ownerHref('finance', item.invoiceRef.resourceId)}>{item.correlation}</Link>
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:whitespace-nowrap">
                          {item.revision} · {item.providerLabel} · {item.mode}
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:whitespace-nowrap propertyportfolio:tabular-nums">
                          <time dateTime={DateTime.formatIso(item.attemptedAt)}>
                            {DateTime.formatIso(item.attemptedAt)}
                          </time>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge
                            size="sm"
                            variant={
                              ({ FAILED: 'danger', PENDING: 'warning', SUCCESS: 'success' } as const)[item.status]
                            }
                          >
                            {t(`${key}.states.${item.status}`)}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:min-w-64 propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                          {item.requestSummary} · {item.resultSummary} · {item.receipt ?? '—'}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
              <div className="propertyportfolio:flex propertyportfolio:flex-wrap propertyportfolio:items-center propertyportfolio:justify-between propertyportfolio:gap-3">
                <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                  {t(`${key}.retry`)}
                </p>
                <Link href={`/${language ?? 'cs'}/finance`}>{t(`${key}.finance`)}</Link>
              </div>
            </section>
            <section
              aria-label={t(`${key}.booking`)}
              className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:p-5"
            >
              <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.booking`)}</h2>
              {records.booking.bookingObservations.length === 0 && (
                <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto">
                <Table className="propertyportfolio:w-full" size="sm" variant="line">
                  <Table.Caption>{t(`${key}.booking`)}</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      {['correlation', 'attempt', 'attemptedAt', 'state', 'summary'].map((column) => (
                        <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {records.booking.bookingObservations.map((item) => (
                      <Table.Row key={item.observationId}>
                        <Table.Cell className="propertyportfolio:font-medium">
                          <Link
                            href={
                              item.occupancyRef === null
                                ? `/${language ?? 'cs'}/najmy`
                                : ownerHref('najmy', item.occupancyRef.resourceId)
                            }
                          >
                            {item.correlation}
                          </Link>
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:whitespace-nowrap">
                          {t(`${key}.attempt`)} {item.attempts} · {item.providerLabel} · {item.mode}
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:whitespace-nowrap propertyportfolio:tabular-nums">
                          <time dateTime={item.attemptedAt}>{item.attemptedAt}</time>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge
                            size="sm"
                            variant={
                              ({ CONFLICT: 'warning', FAILED: 'danger', SUCCESS: 'success' } as const)[item.state]
                            }
                          >
                            {t(`${key}.states.${item.state}`)}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:min-w-64 propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                          {item.requestSummary} · {item.resultSummary}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
              <Link href={`/${language ?? 'cs'}/najmy`}>{t(`${key}.occupancy`)}</Link>
            </section>
            <section
              aria-label={t(`${key}.signature`)}
              className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:p-5"
            >
              <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.signature`)}</h2>
              {records.signature.signatureObservations.length === 0 && (
                <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto">
                <Table className="propertyportfolio:w-full" size="sm" variant="line">
                  <Table.Caption>{t(`${key}.signature`)}</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      {['correlation', 'attempt', 'attemptedAt', 'state', 'summary'].map((column) => (
                        <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {records.signature.signatureObservations.map((item) => (
                      <Table.Row key={item.observationId}>
                        <Table.Cell className="propertyportfolio:font-medium">
                          <Link href={ownerHref('smlouvy', item.contractRef.resourceId)}>{item.correlation}</Link>
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:whitespace-nowrap">
                          {item.providerLabel} · {item.mode}
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:whitespace-nowrap propertyportfolio:tabular-nums">
                          <time dateTime={item.attemptedAt}>{item.attemptedAt}</time>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge
                            size="sm"
                            variant={({ DECLINED: 'danger', SENT: 'info', SIGNED: 'success' } as const)[item.state]}
                          >
                            {t(`${key}.states.${item.state}`)}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:min-w-64 propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                          {item.requestSummary} · {item.resultSummary}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
              <Link href={`/${language ?? 'cs'}/smlouvy`}>{t(`${key}.agreements`)}</Link>
            </section>
            <section
              aria-label={t(`${key}.email`)}
              className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:p-5"
            >
              <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.email`)}</h2>
              {records.notification.emailObservations.length === 0 && (
                <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto">
                <Table className="propertyportfolio:w-full" size="sm" variant="line">
                  <Table.Caption>{t(`${key}.email`)}</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      {['correlation', 'attempt', 'attemptedAt', 'state', 'summary'].map((column) => (
                        <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {records.notification.emailObservations.map((item) => (
                      <Table.Row key={item.observationId}>
                        <Table.Cell className="propertyportfolio:font-medium">
                          <Link href={ownerHref('aktivity', item.ownerResourceRef.resourceId)}>
                            {item.correlation}
                          </Link>
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:whitespace-nowrap">
                          {item.providerLabel} · {item.mode}
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:whitespace-nowrap propertyportfolio:tabular-nums">
                          <time dateTime={DateTime.formatIso(item.attemptedAt)}>
                            {DateTime.formatIso(item.attemptedAt)}
                          </time>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge size="sm" variant="success">
                            {t(`${key}.states.${item.status}`)}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell className="propertyportfolio:min-w-64 propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                          {item.requestSummary} · {item.resultSummary} · {item.receipt}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            </section>
          </div>
        )}
        <section className="ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base propertyportfolio:space-y-2 propertyportfolio:p-5">
          <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.other`)}</h2>
          <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">{t(`${key}.payroll`)}</p>
        </section>
      </section>
    </>
  );
};

export const IntegrationsPage = ({ context }: Pick<ModulePageProps, 'context'>) => (
  <FederatedI18nBoundary
    defaultNamespace="property-portfolio"
    fallbackLanguage="en"
    resources={propertyPortfolioI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <IntegrationsPageContent {...integrationsInput(context)} />
  </FederatedI18nBoundary>
);

export default IntegrationsPage;
