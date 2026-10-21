import type { ConnectDraftSummary } from '@app/shared-contracts/oauth-connections';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useEffect, useState } from 'react';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { approveDraftAndConsent, denyConnection, loadDraftSummary } from '../connect-client.ts';
import { failureKey, readOAuthQuery, summaryModuleLabels } from '../connect-view-model.ts';
import type { ConnectFailure } from '../connect-view-model.ts';

const ConsentPage = () => {
  const { t } = useModernI18n();
  const [loaded, setLoaded] = useState(false);
  const [oauthQuery, setOAuthQuery] = useState<string>();
  const [summary, setSummary] = useState<ConnectDraftSummary>();
  const [loadNotice, setLoadNotice] = useState<ConnectFailure>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ConnectFailure>();

  useEffect(() => {
    const query = readOAuthQuery(window.location.search);
    setLoaded(true);
    if (query === '') {
      setLoadNotice('expired');
      return undefined;
    }
    setOAuthQuery(query);
    let active = true;
    void browserRuntime.runPromise(loadDraftSummary(query)).then((outcome) => {
      if (!active) {
        return;
      }
      if (outcome.status === 'failed') {
        setLoadNotice(outcome.reason);
        return;
      }
      setSummary(outcome.value);
    });
    return () => {
      active = false;
    };
  }, []);

  const clientName = summary?.client.name ?? t('shell.connect.clientFallback');
  const approve = () => {
    if (summary === undefined || oauthQuery === undefined) {
      return;
    }
    setBusy(true);
    setNotice(undefined);
    void browserRuntime.runPromise(approveDraftAndConsent(summary.grantId, oauthQuery)).then((outcome) => {
      if (outcome.status === 'failed') {
        setBusy(false);
        setNotice(outcome.reason);
        return;
      }
      globalThis.location.assign(outcome.value);
    });
  };

  const deny = () => {
    if (summary === undefined || oauthQuery === undefined) {
      return;
    }
    setBusy(true);
    setNotice(undefined);
    void browserRuntime.runPromise(denyConnection(summary.grantId, oauthQuery)).then((outcome) => {
      if (outcome.status === 'failed') {
        setBusy(false);
        setNotice(outcome.reason);
        return;
      }
      globalThis.location.assign(outcome.value.redirectTo);
    });
  };

  const isAgent = summary?.acting.kind === 'agent';
  const labels = summary === undefined ? undefined : summaryModuleLabels(summary.modules);

  return (
    <>
      <UltramodernRouteHead />
      <main className="flex min-h-dvh items-start justify-center bg-surface px-200 py-400 text-fg-primary">
        <div className="grid w-full max-w-[640px] gap-300 rounded-lg border border-border-primary bg-base p-300">
          {loaded && loadNotice === undefined && summary === undefined ? (
            <p className="text-fg-secondary text-sm">{t('shell.connect.consent.loading')}</p>
          ) : null}
          {loadNotice === undefined ? null : (
            <StatusText aria-live="polite" showIcon status={loadNotice === 'connected' ? 'success' : 'error'}>
              {t(failureKey(loadNotice), { client: clientName })}
            </StatusText>
          )}
          {summary === undefined || labels === undefined ? null : (
            <>
              <h1 className="font-semibold text-xl">{t('shell.connect.consent.title', { client: clientName })}</h1>
              <div className="flex flex-wrap items-center gap-150 rounded-lg border border-border-primary p-200">
                {summary.client.logoUri === null || summary.client.logoUri === '' ? (
                  <Icon icon="icon-[mdi--application-outline]" size="md" />
                ) : (
                  <img alt="" className="size-icon-control-lg rounded-md" src={summary.client.logoUri} />
                )}
                <div className="grid min-w-0 flex-1 gap-100">
                  <span className="break-words font-semibold">{summary.client.name}</span>
                  <div className="flex flex-wrap gap-100">
                    <Badge size="sm" variant="info">
                      {summary.client.host}
                    </Badge>
                    <Badge size="sm" variant={summary.client.kind === 'loopback' ? 'warning' : 'success'}>
                      {t(
                        summary.client.kind === 'loopback'
                          ? 'shell.connect.badge.loopback'
                          : 'shell.connect.badge.verified',
                      )}
                    </Badge>
                  </div>
                </div>
              </div>

              <ul className="grid gap-150 rounded-lg border border-border-primary p-200 text-sm">
                <li>
                  {t('shell.connect.consent.companyLabel')}: <strong>{summary.legalName}</strong>
                </li>
                <li>
                  {t('shell.connect.consent.actingLabel')}: <strong>{summary.acting.displayName}</strong>{' '}
                  {isAgent
                    ? t('shell.connect.consent.actingAgent', { name: summary.delegatedBy?.displayName ?? '' })
                    : t('shell.connect.consent.actingMe')}
                </li>
                {labels === 'all' ? (
                  <li>
                    {t('shell.connect.consent.readLabel')}:{' '}
                    {isAgent ? t('shell.connect.consent.allAgent') : t('shell.connect.consent.allMe')}
                  </li>
                ) : (
                  <li>
                    {t('shell.connect.consent.readLabel')}: {labels.read.join(', ')}
                  </li>
                )}
                {labels === 'all' || labels.write.length === 0 || summary.writePolicy === 'read_only' ? null : (
                  <li>
                    {t('shell.connect.consent.writeModulesLabel')}: {labels.write.join(', ')}
                  </li>
                )}
                <li>
                  {t('shell.connect.consent.policyLabel')}:{' '}
                  <strong>{t(`shell.connect.consent.policyValue.${summary.writePolicy}`)}</strong> —{' '}
                  {t(`shell.connect.consent.policyHint.${summary.writePolicy}`)}
                </li>
              </ul>

              <p className="text-fg-secondary text-sm">{t('shell.connect.consent.validity')}</p>
              <p className="text-sm">
                {t('shell.connect.consent.redirectBefore')} <strong>{summary.client.host}</strong>.
              </p>

              {notice === undefined ? null : (
                <StatusText aria-live="polite" showIcon status="error">
                  {t(failureKey(notice), { client: clientName })}
                </StatusText>
              )}
              <div className="flex flex-wrap gap-150">
                <Button disabled={busy} onClick={approve} size="md" theme="solid" type="button" variant="primary">
                  {t('shell.connect.consent.allow')}
                </Button>
                <Button disabled={busy} onClick={deny} size="md" theme="outlined" type="button" variant="secondary">
                  {t('shell.connect.consent.deny')}
                </Button>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
};

export default ConsentPage;
