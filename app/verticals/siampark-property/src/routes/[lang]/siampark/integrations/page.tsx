import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { executeRecords as executeAccounting } from '@app/siampark-billing-finance/clients/records';
import { executeRecords as executeBookings } from '@app/siampark-occupancy/clients/records';
import { executeRecords as executeSignatures } from '@app/siampark-agreements/clients/records';
import { executeRecords as executeNotifications } from '@app/siampark-relationships/clients/records';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DateTime, Effect, Match, Random } from 'effect';
import { useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-property.json';
import enResource from '../../../../../locales/en/siampark-property.json';
import '../../../index.css';

const siamparkPropertyI18nResources = {
  cs: { 'siampark-property': csResource },
  en: { 'siampark-property': enResource },
} as const;

const loadOutcomes = Effect.fn('Property.Integrations.loadOutcomes')(function* loadOutcomes() {
  const requestId = Random.nextInt.pipe(Effect.map((id) => `siampark-integrations:${id}`));
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
  const key = 'siampark-property.pages.integrations';
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
    `/${language ?? 'cs'}/siampark/${owner}?resourceId=${encodeURIComponent(resourceId)}`;
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="siamparkproperty:w-full siamparkproperty:min-w-0 siamparkproperty:max-w-none siamparkproperty:space-y-6 siamparkproperty:p-0 siamparkproperty:text-(--color-page-fg)"
      >
        <header className="siamparkproperty:flex siamparkproperty:flex-wrap siamparkproperty:items-start siamparkproperty:justify-between siamparkproperty:gap-4 siamparkproperty:border-b siamparkproperty:border-(--color-border-muted) siamparkproperty:pb-5">
          <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2">
            <h1
              className="siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tracking-tight"
              id={headingId}
            >
              {t(`${key}.title`)}
            </h1>
            <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
              {t(`${key}.simulation`)}
            </p>
          </div>
          <Button disabled={pending} onClick={refresh} size="sm" variant="warning">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output
          aria-live="polite"
          className="siamparkproperty:block siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)"
        >
          {message}
        </output>
        {records !== undefined && (
          <div className="siamparkproperty:space-y-6">
            <section
              aria-label={t(`${key}.accounting`)}
              className="siamparkproperty:min-w-0 siamparkproperty:space-y-4 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-5"
            >
              <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">{t(`${key}.accounting`)}</h2>

              <div className="siamparkproperty:min-w-0 siamparkproperty:overflow-x-auto siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface)">
                <Table className="siamparkproperty:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.accounting`)}</Table.Caption>
                  <Table.Header className="siamparkproperty:bg-(--color-surface-subtle)">
                    <Table.Row>
                      {['correlation', 'attempt', 'attemptedAt', 'state', 'summary'].map((column) => (
                        <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {records.accounting.state.accountingObservations.map((item) => (
                      <Table.Row key={item.attemptId}>
                        <Table.Cell className="siamparkproperty:font-medium">
                          <Link href={ownerHref('finance', item.invoiceRef.resourceId)}>{item.correlation}</Link>
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:whitespace-nowrap">
                          {item.revision} · {item.providerLabel} · {item.mode}
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:whitespace-nowrap siamparkproperty:tabular-nums">
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
                        <Table.Cell className="siamparkproperty:min-w-64 siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                          {item.requestSummary} · {item.resultSummary} · {item.receipt ?? '—'}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
              <div className="siamparkproperty:flex siamparkproperty:flex-wrap siamparkproperty:items-center siamparkproperty:justify-between siamparkproperty:gap-3">
                <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                  {t(`${key}.retry`)}
                </p>
                <Link href={`/${language ?? 'cs'}/siampark/finance`}>{t(`${key}.finance`)}</Link>
              </div>
            </section>
            <section
              aria-label={t(`${key}.booking`)}
              className="siamparkproperty:min-w-0 siamparkproperty:space-y-4 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-5"
            >
              <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">{t(`${key}.booking`)}</h2>
              {records.booking.bookingObservations.length === 0 && (
                <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="siamparkproperty:min-w-0 siamparkproperty:overflow-x-auto siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface)">
                <Table className="siamparkproperty:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.booking`)}</Table.Caption>
                  <Table.Header className="siamparkproperty:bg-(--color-surface-subtle)">
                    <Table.Row>
                      {['correlation', 'attempt', 'attemptedAt', 'state', 'summary'].map((column) => (
                        <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {records.booking.bookingObservations.map((item) => (
                      <Table.Row key={item.observationId}>
                        <Table.Cell className="siamparkproperty:font-medium">
                          <Link
                            href={
                              item.occupancyRef === null
                                ? `/${language ?? 'cs'}/siampark/occupancy`
                                : ownerHref('occupancy', item.occupancyRef.resourceId)
                            }
                          >
                            {item.correlation}
                          </Link>
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:whitespace-nowrap">
                          {t(`${key}.attempt`)} {item.attempts} · {item.providerLabel} · {item.mode}
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:whitespace-nowrap siamparkproperty:tabular-nums">
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
                        <Table.Cell className="siamparkproperty:min-w-64 siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                          {item.requestSummary} · {item.resultSummary}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
              <Link href={`/${language ?? 'cs'}/siampark/occupancy`}>{t(`${key}.occupancy`)}</Link>
            </section>
            <section
              aria-label={t(`${key}.signature`)}
              className="siamparkproperty:min-w-0 siamparkproperty:space-y-4 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-5"
            >
              <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">{t(`${key}.signature`)}</h2>
              {records.signature.signatureObservations.length === 0 && (
                <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="siamparkproperty:min-w-0 siamparkproperty:overflow-x-auto siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface)">
                <Table className="siamparkproperty:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.signature`)}</Table.Caption>
                  <Table.Header className="siamparkproperty:bg-(--color-surface-subtle)">
                    <Table.Row>
                      {['correlation', 'attempt', 'attemptedAt', 'state', 'summary'].map((column) => (
                        <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {records.signature.signatureObservations.map((item) => (
                      <Table.Row key={item.observationId}>
                        <Table.Cell className="siamparkproperty:font-medium">
                          <Link href={ownerHref('agreements', item.contractRef.resourceId)}>{item.correlation}</Link>
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:whitespace-nowrap">
                          {item.providerLabel} · {item.mode}
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:whitespace-nowrap siamparkproperty:tabular-nums">
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
                        <Table.Cell className="siamparkproperty:min-w-64 siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                          {item.requestSummary} · {item.resultSummary}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
              <Link href={`/${language ?? 'cs'}/siampark/agreements`}>{t(`${key}.agreements`)}</Link>
            </section>
            <section
              aria-label={t(`${key}.email`)}
              className="siamparkproperty:min-w-0 siamparkproperty:space-y-4 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-5"
            >
              <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">{t(`${key}.email`)}</h2>
              {records.notification.emailObservations.length === 0 && (
                <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
                  {t(`${key}.empty`)}
                </p>
              )}
              <div className="siamparkproperty:min-w-0 siamparkproperty:overflow-x-auto siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface)">
                <Table className="siamparkproperty:w-full" size="sm" variant="outline">
                  <Table.Caption>{t(`${key}.email`)}</Table.Caption>
                  <Table.Header className="siamparkproperty:bg-(--color-surface-subtle)">
                    <Table.Row>
                      {['correlation', 'attempt', 'attemptedAt', 'state', 'summary'].map((column) => (
                        <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {records.notification.emailObservations.map((item) => (
                      <Table.Row key={item.observationId}>
                        <Table.Cell className="siamparkproperty:font-medium">
                          <Link href={ownerHref('relationships', item.ownerResourceRef.resourceId)}>
                            {item.correlation}
                          </Link>
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:whitespace-nowrap">
                          {item.providerLabel} · {item.mode}
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:whitespace-nowrap siamparkproperty:tabular-nums">
                          <time dateTime={DateTime.formatIso(item.attemptedAt)}>
                            {DateTime.formatIso(item.attemptedAt)}
                          </time>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge size="sm" variant="success">
                            {t(`${key}.states.${item.status}`)}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell className="siamparkproperty:min-w-64 siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">
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
        <section className="siamparkproperty:space-y-2 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-5">
          <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">{t(`${key}.other`)}</h2>
          <p className="siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)">{t(`${key}.payroll`)}</p>
        </section>
      </section>
    </>
  );
};

export const IntegrationsPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="siampark-property"
    fallbackLanguage="en"
    resources={siamparkPropertyI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <IntegrationsPageContent />
  </FederatedI18nBoundary>
);

export default IntegrationsPage;
