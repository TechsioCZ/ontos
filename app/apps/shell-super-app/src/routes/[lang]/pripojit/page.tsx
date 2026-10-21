import type { AgentWritePolicy } from '@app/shared-contracts/agent-access';
import type { ConnectCompanyOption, ConnectOptions } from '@app/shared-contracts/oauth-connections';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useEffect, useState } from 'react';

import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { createDraftAndContinue, denyConnection, loadConnectOptions } from './connect-client.ts';
import {
  buildModulesRequest,
  defaultPolicy,
  failureKey,
  policyOptionState,
  readOAuthQuery,
} from './connect-view-model.ts';
import type { ConnectFailure } from './connect-view-model.ts';

const ME = 'me';
const NO_PICK = { read: false, write: false };

type Mode = 'all' | 'pick';
type Pick = { read: boolean; write: boolean };
type Picks = ReadonlyMap<string, Pick>;
type Notice = ConnectFailure | 'pickRequired';
type Module = ConnectCompanyOption['modules'][number];

const POLICIES: readonly AgentWritePolicy[] = ['read_only', 'approval', 'direct'];

const allReadPicks = (modules: readonly Module[]): Picks =>
  new Map(modules.map((module): [string, Pick] => [module.moduleId, { read: true, write: false }]));

/** A read-only policy cannot send write access, whatever the write boxes still show. */
const requestPicks = (picks: Picks, policy: AgentWritePolicy): Picks =>
  policy === 'read_only'
    ? new Map([...picks].map(([moduleId, pick]): [string, Pick] => [moduleId, { read: pick.read, write: false }]))
    : picks;

const ConnectPage = () => {
  const { t } = useModernI18n();
  const [loaded, setLoaded] = useState(false);
  const [oauthQuery, setOAuthQuery] = useState<string>();
  const [options, setOptions] = useState<ConnectOptions>();
  const [loadNotice, setLoadNotice] = useState<ConnectFailure>();
  const [companyId, setCompanyId] = useState<string>();
  const [acting, setActing] = useState<string>(ME);
  const [mode, setMode] = useState<Mode>('all');
  const [picks, setPicks] = useState<Picks>(new Map());
  const [policy, setPolicy] = useState<AgentWritePolicy>('approval');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  useEffect(() => {
    const query = readOAuthQuery(window.location.search);
    setLoaded(true);
    if (query === '') {
      setLoadNotice('expired');
      return undefined;
    }
    setOAuthQuery(query);
    let active = true;
    void browserRuntime.runPromise(loadConnectOptions(query)).then((outcome) => {
      if (!active) {
        return;
      }
      if (outcome.status === 'failed') {
        setLoadNotice(outcome.reason);
        return;
      }
      const value = outcome.value;
      const company =
        value.companies.find((candidate) => candidate.legalEntityId === value.preselect.legalEntityId) ??
        value.companies[0];
      const preselectedAgent = company?.agents.find(
        (candidate) => candidate.principalId === value.preselect.agentPrincipalId,
      );
      setOptions(value);
      setCompanyId(company?.legalEntityId);
      setActing(preselectedAgent?.principalId ?? ME);
      setPolicy(defaultPolicy(preselectedAgent?.writePolicy ?? 'direct'));
      setPicks(allReadPicks(preselectedAgent?.modules ?? company?.modules ?? []));
    });
    return () => {
      active = false;
    };
  }, []);

  const clientName = options?.client.name ?? t('shell.connect.clientFallback');
  const company = options?.companies.find((candidate) => candidate.legalEntityId === companyId);
  const agent = acting === ME ? undefined : company?.agents.find((candidate) => candidate.principalId === acting);
  const offered: readonly Module[] = agent?.modules ?? company?.modules ?? [];
  const cap: AgentWritePolicy = agent?.writePolicy ?? 'direct';

  // A company or acting-principal change resets the access and policy choices to what the new ceiling allows.
  const selectActing = (nextCompany: ConnectCompanyOption | undefined, nextActing: string) => {
    const nextAgent =
      nextActing === ME ? undefined : nextCompany?.agents.find((candidate) => candidate.principalId === nextActing);
    setActing(nextActing);
    setPolicy(defaultPolicy(nextAgent?.writePolicy ?? 'direct'));
    setPicks(allReadPicks(nextAgent?.modules ?? nextCompany?.modules ?? []));
    setNotice(undefined);
  };

  const chooseCompany = (nextId: string) => {
    setCompanyId(nextId);
    selectActing(options?.companies.find((candidate) => candidate.legalEntityId === nextId), ME);
  };

  const chooseMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === 'pick') {
      setPicks(allReadPicks(offered));
    }
  };

  const setModulePick = (moduleId: string, next: Pick) => {
    setPicks((previous) => new Map(previous).set(moduleId, next));
  };

  const submit = () => {
    if (oauthQuery === undefined || company === undefined) {
      return;
    }
    if (mode === 'pick' && !offered.some((module) => picks.get(module.moduleId)?.read === true)) {
      setNotice('pickRequired');
      return;
    }
    setBusy(true);
    setNotice(undefined);
    void browserRuntime
      .runPromise(
        createDraftAndContinue({
          actingPrincipalId: acting === ME ? null : acting,
          legalEntityId: company.legalEntityId,
          modules: buildModulesRequest(mode, requestPicks(picks, policy)),
          oauthQuery,
          writePolicy: policy,
        }),
      )
      .then((outcome) => {
        if (outcome.status === 'failed') {
          setBusy(false);
          setNotice(outcome.reason);
          return;
        }
        globalThis.location.assign(outcome.value);
      });
  };

  const cancel = () => {
    if (oauthQuery === undefined) {
      return;
    }
    setBusy(true);
    void browserRuntime.runPromise(denyConnection(null, oauthQuery)).then((outcome) => {
      if (outcome.status === 'failed') {
        setBusy(false);
        setNotice(outcome.reason);
        return;
      }
      globalThis.location.assign(outcome.value.redirectTo);
    });
  };

  const failureText = (reason: Notice) =>
    reason === 'pickRequired' ? t('shell.connect.access.pickRequired') : t(failureKey(reason), { client: clientName });

  return (
    <>
      <UltramodernRouteHead />
      <main className="flex min-h-dvh items-start justify-center bg-surface px-200 py-400 text-fg-primary">
        <div className="grid w-full max-w-[640px] gap-300 rounded-lg border border-border-primary bg-base p-300">
          {loaded && loadNotice === undefined && options === undefined ? (
            <p className="text-fg-secondary text-sm">{t('shell.connect.loading')}</p>
          ) : null}
          {loadNotice === undefined ? null : (
            <StatusText aria-live="polite" showIcon status="error">
              {t(failureKey(loadNotice), { client: clientName })}
            </StatusText>
          )}
          {options === undefined ? null : (
            <>
              <h1 className="font-semibold text-xl">{t('shell.connect.title', { client: clientName })}</h1>
              <div className="flex flex-wrap items-center gap-150 rounded-lg border border-border-primary p-200">
                {options.client.logoUri === null || options.client.logoUri === '' ? (
                  <Icon icon="icon-[mdi--application-outline]" size="md" />
                ) : (
                  <img alt="" className="size-icon-control-lg rounded-md" src={options.client.logoUri} />
                )}
                <div className="grid min-w-0 flex-1 gap-100">
                  <span className="break-words font-semibold">{options.client.name}</span>
                  <div className="flex flex-wrap gap-100">
                    <Badge size="sm" variant="info">
                      {options.client.host}
                    </Badge>
                    <Badge size="sm" variant={options.client.kind === 'loopback' ? 'warning' : 'success'}>
                      {t(
                        options.client.kind === 'loopback'
                          ? 'shell.connect.badge.loopback'
                          : 'shell.connect.badge.verified',
                      )}
                    </Badge>
                  </div>
                </div>
              </div>

              <section className="grid gap-100">
                <h2 className="font-semibold">{t('shell.connect.company.title')}</h2>
                {company === undefined ? (
                  <StatusText aria-live="polite" showIcon status="error">
                    {t('shell.connect.company.none')}
                  </StatusText>
                ) : (
                  <>
                    <p className="text-fg-secondary text-sm">{t('shell.connect.company.question')}</p>
                    {options.companies.length > 1 ? (
                      <select
                        className="rounded border border-border-primary bg-base px-150 py-100"
                        onChange={(event) => chooseCompany(event.target.value)}
                        value={company.legalEntityId}
                      >
                        {options.companies.map((candidate) => (
                          <option key={candidate.legalEntityId} value={candidate.legalEntityId}>
                            {candidate.legalName}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="font-semibold">{company.legalName}</p>
                    )}
                  </>
                )}
              </section>

              {company === undefined ? null : (
                <>
                  {company.agents.length === 0 ? null : (
                    <fieldset className="grid gap-100">
                      <legend className="mb-100 font-semibold">{t('shell.connect.acting.title')}</legend>
                      <label className="flex items-start gap-150 rounded border border-border-primary px-150 py-100">
                        <input
                          checked={acting === ME}
                          className="mt-050 accent-primary"
                          name="acting"
                          onChange={() => selectActing(company, ME)}
                          type="radio"
                        />
                        <span className="grid gap-050">
                          <span className="font-semibold">{t('shell.connect.acting.me', { name: options.user.displayName })}</span>
                          <span className="text-fg-secondary text-sm">{t('shell.connect.acting.meHint')}</span>
                        </span>
                      </label>
                      {company.agents.map((candidate) => (
                        <label
                          className="flex items-start gap-150 rounded border border-border-primary px-150 py-100"
                          key={candidate.principalId}
                        >
                          <input
                            checked={acting === candidate.principalId}
                            className="mt-050 accent-primary"
                            name="acting"
                            onChange={() => selectActing(company, candidate.principalId)}
                            type="radio"
                          />
                          <span className="grid gap-050">
                            <span className="font-semibold">
                              {t('shell.connect.acting.agent', { name: candidate.displayName })}
                            </span>
                            <span className="text-fg-secondary text-sm">{t('shell.connect.acting.agentHint')}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  <fieldset className="grid gap-100">
                    <legend className="mb-100 font-semibold">{t('shell.connect.access.title')}</legend>
                    <label className="flex items-center gap-150 rounded border border-border-primary px-150 py-100">
                      <input
                        checked={mode === 'all'}
                        className="accent-primary"
                        name="access"
                        onChange={() => chooseMode('all')}
                        type="radio"
                      />
                      <span>{agent === undefined ? t('shell.connect.access.allMe') : t('shell.connect.access.allAgent')}</span>
                    </label>
                    <label className="flex items-center gap-150 rounded border border-border-primary px-150 py-100">
                      <input
                        checked={mode === 'pick'}
                        className="accent-primary"
                        name="access"
                        onChange={() => chooseMode('pick')}
                        type="radio"
                      />
                      <span>{t('shell.connect.access.pick')}</span>
                    </label>
                    {mode === 'pick' ? (
                      <ul className="grid gap-100">
                        {offered.map((module) => {
                          const pick = picks.get(module.moduleId) ?? NO_PICK;
                          return (
                            <li
                              className="flex flex-wrap items-center justify-between gap-150 rounded border border-border-primary px-150 py-100"
                              key={module.moduleId}
                            >
                              <span className="min-w-0 break-words">{module.label}</span>
                              <span className="flex flex-wrap gap-200">
                                <label className="flex items-center gap-050">
                                  <input
                                    checked={pick.read}
                                    className="accent-primary"
                                    onChange={(event) =>
                                      setModulePick(module.moduleId, {
                                        read: event.target.checked,
                                        write: event.target.checked && pick.write,
                                      })
                                    }
                                    type="checkbox"
                                  />
                                  {t('shell.connect.access.read')}
                                </label>
                                <label className="flex items-center gap-050">
                                  <input
                                    checked={pick.write}
                                    className="accent-primary"
                                    disabled={!module.write || policy === 'read_only' || !pick.read}
                                    onChange={(event) =>
                                      setModulePick(module.moduleId, { read: pick.read, write: event.target.checked })
                                    }
                                    type="checkbox"
                                  />
                                  {t('shell.connect.access.write')}
                                </label>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </fieldset>

                  <fieldset className="grid gap-100">
                    <legend className="mb-100 font-semibold">{t('shell.connect.policy.title')}</legend>
                    {POLICIES.map((candidate) => {
                      const state = policyOptionState(candidate, cap);
                      return (
                        <label
                          className="grid gap-050 rounded border border-border-primary px-150 py-100"
                          key={candidate}
                        >
                          <span className="flex items-start gap-150">
                            <input
                              checked={policy === candidate}
                              className="mt-050 accent-primary"
                              disabled={state.disabled}
                              name="policy"
                              onChange={() => setPolicy(candidate)}
                              type="radio"
                            />
                            <span className="grid gap-050">
                              <span className="font-semibold">{t(`shell.connect.policy.${candidate}`)}</span>
                              {candidate === "read_only" ? null : (
                                <span className="text-fg-secondary text-sm">
                                  {t(candidate === "approval" ? "shell.connect.policy.approvalHint" : "shell.connect.policy.directHint")}
                                </span>
                              )}
                            </span>
                          </span>
                          {state.reasonKey === null ? null : (
                            <span className="text-fg-secondary text-sm">{t(state.reasonKey)}</span>
                          )}
                        </label>
                      );
                    })}
                  </fieldset>

                  {notice === undefined ? null : (
                    <StatusText aria-live="polite" showIcon status="error">
                      {failureText(notice)}
                    </StatusText>
                  )}
                  <div className="flex flex-wrap gap-150">
                    <Button disabled={busy} onClick={submit} size="md" theme="solid" type="button" variant="primary">
                      {t('shell.connect.continue')}
                    </Button>
                    <Button disabled={busy} onClick={cancel} size="md" type="button" variant="secondary">
                      {t('shell.connect.cancel')}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
};

export default ConnectPage;
