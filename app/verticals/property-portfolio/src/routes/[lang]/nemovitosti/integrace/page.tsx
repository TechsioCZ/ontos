import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { executeRecords as executeAccounting } from '@app/finance-billing/clients/records';
import { executeRecords as executeBookings } from '@app/property-leasing/clients/records';
import { executeRecords as executeSignatures } from '@app/legal-agreements/clients/records';
import { executeRecords as executeNotifications } from '@app/crm-activities/clients/records';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DateTime, Effect, Match, Random } from 'effect';
import { useState } from 'react';
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
    { concurrency: 1 },
  );
});

const IntegrationsPageContent = () => {
  const { language, t } = useModernI18n();
  const headingId = 'integrations-heading';
  const key = 'property-portfolio.pages.integrations';
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [records, setRecords] = useState<Effect.Success<ReturnType<typeof loadOutcomes>>>();
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      loadOutcomes().pipe(
        Effect.match({
          onFailure: (error) => {
            setRecords(undefined);
            setMessage(
              Match.value(error).pipe(
                Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
            setPending(false);
          },
          onSuccess: (result) => {
            setRecords(result);
            setMessage('');
            setPending(false);
          },
        }),
      ),
    );
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
        <header className="propertyportfolio:flex propertyportfolio:flex-wrap propertyportfolio:items-start propertyportfolio:justify-between propertyportfolio:gap-4 propertyportfolio:border-b propertyportfolio:border-(--color-border-muted) propertyportfolio:pb-5">
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
          <Button disabled={pending} onClick={refresh} size="sm" variant="warning">
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
              className="propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:rounded-lg propertyportfolio:border propertyportfolio:border-(--color-border-muted) propertyportfolio:bg-(--color-surface) propertyportfolio:p-5"
            >
              <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.accounting`)}</h2>

              <div className="propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto propertyportfolio:rounded-lg propertyportfolio:bg-(--color-surface)">
                <Table className="propertyportfolio:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.accounting`)}</Table.Caption>
                  <Table.Header className="propertyportfolio:bg-(--color-surface-subtle)">
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
              className="propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:rounded-lg propertyportfolio:border propertyportfolio:border-(--color-border-muted) propertyportfolio:bg-(--color-surface) propertyportfolio:p-5"
            >
              <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.booking`)}</h2>
              {records.booking.bookingObservations.length === 0 && (
                <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto propertyportfolio:rounded-lg propertyportfolio:bg-(--color-surface)">
                <Table className="propertyportfolio:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.booking`)}</Table.Caption>
                  <Table.Header className="propertyportfolio:bg-(--color-surface-subtle)">
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
              className="propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:rounded-lg propertyportfolio:border propertyportfolio:border-(--color-border-muted) propertyportfolio:bg-(--color-surface) propertyportfolio:p-5"
            >
              <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.signature`)}</h2>
              {records.signature.signatureObservations.length === 0 && (
                <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto propertyportfolio:rounded-lg propertyportfolio:bg-(--color-surface)">
                <Table className="propertyportfolio:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.signature`)}</Table.Caption>
                  <Table.Header className="propertyportfolio:bg-(--color-surface-subtle)">
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
              className="propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:rounded-lg propertyportfolio:border propertyportfolio:border-(--color-border-muted) propertyportfolio:bg-(--color-surface) propertyportfolio:p-5"
            >
              <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.email`)}</h2>
              {records.notification.emailObservations.length === 0 && (
                <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto propertyportfolio:rounded-lg propertyportfolio:bg-(--color-surface)">
                <Table className="propertyportfolio:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.email`)}</Table.Caption>
                  <Table.Header className="propertyportfolio:bg-(--color-surface-subtle)">
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
        <section className="propertyportfolio:space-y-2 propertyportfolio:rounded-lg propertyportfolio:bg-(--color-surface-subtle) propertyportfolio:p-5">
          <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">{t(`${key}.other`)}</h2>
          <p className="propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)">{t(`${key}.payroll`)}</p>
        </section>
      </section>
    </>
  );
};

export const IntegrationsPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="property-portfolio"
    fallbackLanguage="en"
    resources={propertyPortfolioI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <IntegrationsPageContent />
  </FederatedI18nBoundary>
);

export default IntegrationsPage;
