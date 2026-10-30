import { Effect, Fiber, Function as Fn, Option, Schema } from 'effect';
import type { AgentWritePolicy } from '@app/shared-contracts/agent-access';
import { ConnectionPrincipalIdSchema } from '@app/shared-contracts/oauth-connections';
import type { ConnectCompanyOption, ConnectOptions } from '@app/shared-contracts/oauth-connections';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useEffect, useState } from 'react';

import { useBrowserLocationHref } from '../../browser-location.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { createDraftAndContinue, denyConnection, loadConnectOptions } from './connect-client.ts';
import {
  buildModulesRequest,
  defaultPolicy,
  failureKey,
  loadFailure,
  policyOptionState,
  readOAuthQuery,
} from './connect-view-model.ts';
import type { ConnectOutcome } from './connect-client.ts';
import type { ConnectFailure } from './connect-view-model.ts';

const ME = 'me';
const NO_PICK = { read: false, write: false };

const ModeSchema = Schema.Literals(['all', 'pick']);
type Mode = typeof ModeSchema.Type;
interface Pick {
  read: boolean;
  write: boolean;
}
type Picks = ReadonlyMap<string, Pick>;
type Notice = ConnectFailure | 'pickRequired';
type Module = ConnectCompanyOption['modules'][number];

const POLICIES: readonly AgentWritePolicy[] = ['read_only', 'approval', 'direct'];

/** Module picking starts from the full offer: read everywhere, write wherever the acting principal may write. */
const offeredPicks = (modules: readonly Module[]): Picks =>
  new Map(modules.map((module): [string, Pick] => [module.moduleId, { read: true, write: module.write }]));

/** A read-only policy cannot send write access, whatever the write boxes still show. */
const requestPicks = (picks: Picks, policy: AgentWritePolicy): Picks =>
  policy === 'read_only'
    ? new Map([...picks].map(([moduleId, pick]): [string, Pick] => [moduleId, { read: pick.read, write: false }]))
    : picks;

interface ConnectSelection {
  readonly acting: string;
  readonly companyId: ConnectCompanyOption['legalEntityId'] | undefined;
  readonly mode: Mode;
  readonly picks: Picks;
  readonly policy: AgentWritePolicy;
}
const initialSelection = (options: ConnectOptions | undefined): ConnectSelection => {
  const preferredCompanyId = options === undefined ? undefined : Option.getOrUndefined(options.preselect.legalEntityId);
  const preferredAgentId =
    options === undefined ? undefined : Option.getOrUndefined(options.preselect.agentPrincipalId);
  const company =
    options?.companies.find((candidate) => candidate.legalEntityId === preferredCompanyId) ?? options?.companies[0];
  const agent = company?.agents.find((candidate) => candidate.principalId === preferredAgentId);
  return {
    acting: agent?.principalId ?? ME,
    companyId: company?.legalEntityId,
    mode: 'all',
    picks: offeredPicks(agent?.modules ?? company?.modules ?? []),
    policy: defaultPolicy(agent?.writePolicy ?? 'direct'),
  };
};

const useConnectForm = () => {
  const href = useBrowserLocationHref();
  const oauthQuery = href === undefined ? undefined : readOAuthQuery(new URL(href).search);
  const [loadedResult, setLoadedResult] = useState<{
    readonly outcome: ConnectOutcome<ConnectOptions>;
    readonly query: string;
  }>();
  const loadResult = loadedResult !== undefined && loadedResult.query === oauthQuery ? loadedResult.outcome : undefined;
  const options = loadResult?.status === 'ok' ? loadResult.value : undefined;
  const loadNotice = loadFailure(oauthQuery, loadResult);
  const [chosen, setChosen] = useState<{ readonly query: string | undefined; readonly selection: ConnectSelection }>();
  const current = chosen !== undefined && chosen.query === oauthQuery ? chosen.selection : initialSelection(options);
  const setSelection = (selection: ConnectSelection) => setChosen({ query: oauthQuery, selection });
  const { acting, companyId, mode, picks, policy } = current;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => {
    if (oauthQuery === undefined || oauthQuery === '') {
      return Fn.constVoid;
    }
    let active = true;
    const fiber = browserRuntime.runFork(
      loadConnectOptions(oauthQuery).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (active) {
              setLoadedResult({ outcome, query: oauthQuery });
            }
          }),
        ),
      ),
    );
    return () => {
      active = false;
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [oauthQuery]);
  const company = options?.companies.find((candidate) => candidate.legalEntityId === companyId);
  const agent = acting === ME ? undefined : company?.agents.find((candidate) => candidate.principalId === acting);
  const offered: readonly Module[] = agent?.modules ?? company?.modules ?? [];
  const cap: AgentWritePolicy = agent?.writePolicy ?? 'direct';
  const selectActing = (nextCompany: ConnectCompanyOption | undefined, nextActing: string) => {
    const nextAgent =
      nextActing === ME ? undefined : nextCompany?.agents.find((candidate) => candidate.principalId === nextActing);
    setSelection({
      ...current,
      acting: nextActing,
      companyId: nextCompany?.legalEntityId,
      picks: offeredPicks(nextAgent?.modules ?? nextCompany?.modules ?? []),
      policy: defaultPolicy(nextAgent?.writePolicy ?? 'direct'),
    });
    setNotice(undefined);
  };
  const chooseCompany = (nextId: string) =>
    selectActing(
      options?.companies.find((candidate) => candidate.legalEntityId === nextId),
      ME,
    );
  const chooseMode = (nextMode: Mode) =>
    setSelection({ ...current, mode: nextMode, picks: nextMode === 'pick' ? offeredPicks(offered) : picks });
  const setPolicy = (nextPolicy: AgentWritePolicy) => setSelection({ ...current, policy: nextPolicy });
  const setModulePick = (moduleId: string, next: Pick) =>
    setChosen((previous) => {
      const selection =
        previous !== undefined && previous.query === oauthQuery ? previous.selection : initialSelection(options);
      return { query: oauthQuery, selection: { ...selection, picks: new Map(selection.picks).set(moduleId, next) } };
    });
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
    browserRuntime.runFork(
      createDraftAndContinue({
        actingPrincipalId: acting === ME ? Option.none() : Option.some(ConnectionPrincipalIdSchema.make(acting)),
        legalEntityId: company.legalEntityId,
        modules: buildModulesRequest(mode, requestPicks(picks, policy)),
        oauthQuery,
        writePolicy: policy,
      }).pipe(
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            if (outcome.status === 'failed') {
              setBusy(false);
              setNotice(outcome.reason);
              return;
            }
            globalThis.location.assign(outcome.value);
          }),
        ),
      ),
    );
  };
  const cancel = () => {
    if (oauthQuery === undefined) {
      return;
    }
    setBusy(true);
    browserRuntime.runFork(
      denyConnection(Option.none(), oauthQuery).pipe(
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            if (outcome.status === 'failed') {
              setBusy(false);
              setNotice(outcome.reason);
              return;
            }
            globalThis.location.assign(outcome.value.redirectTo);
          }),
        ),
      ),
    );
  };
  return {
    acting,
    agent,
    busy,
    cancel,
    cap,
    chooseCompany,
    chooseMode,
    company,
    loaded: href !== undefined,
    loadNotice,
    mode,
    notice,
    offered,
    options,
    picks,
    policy,
    selectActing,
    setModulePick,
    setPolicy,
    submit,
  };
};

const ActingChoices = ({
  acting,
  company,
  onSelect,
  userDisplayName,
}: {
  readonly acting: string;
  readonly company: ConnectCompanyOption;
  readonly onSelect: (value: string) => void;
  readonly userDisplayName: string;
}) => {
  const { t } = useModernI18n();
  if (company.agents.length === 0) {
    return null;
  }
  return (
    <fieldset className="grid gap-100">
      <legend className="mb-100 font-semibold">{t('shell.connect.acting.title')}</legend>
      <label className="flex items-start gap-150 rounded bg-surface px-150 py-100" htmlFor="connect-acting-me">
        <input
          checked={acting === ME}
          className="mt-050 accent-primary"
          id="connect-acting-me"
          name="acting"
          onChange={() => onSelect(ME)}
          type="radio"
        />
        <span className="grid gap-050 font-semibold">
          {t('shell.connect.acting.me', { name: userDisplayName })}
          <span className="font-normal text-fg-secondary text-sm">{t('shell.connect.acting.meHint')}</span>
        </span>
      </label>
      {company.agents.map((candidate) => (
        <label
          className="flex items-start gap-150 rounded bg-surface px-150 py-100"
          htmlFor={`connect-acting-${candidate.principalId}`}
          key={candidate.principalId}
        >
          <input
            checked={acting === candidate.principalId}
            className="mt-050 accent-primary"
            id={`connect-acting-${candidate.principalId}`}
            name="acting"
            onChange={() => onSelect(candidate.principalId)}
            type="radio"
          />
          <span className="grid gap-050 font-semibold">
            {t('shell.connect.acting.agent', { name: candidate.displayName })}
            <span className="font-normal text-fg-secondary text-sm">{t('shell.connect.acting.agentHint')}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
};

const AccessChoices = ({
  isAgent,
  mode,
  offered,
  onModeChange,
  onPickChange,
  picks,
  policy,
}: {
  readonly isAgent: boolean;
  readonly mode: Mode;
  readonly offered: readonly Module[];
  readonly onModeChange: (value: Mode) => void;
  readonly onPickChange: (moduleId: string, value: Pick) => void;
  readonly picks: Picks;
  readonly policy: AgentWritePolicy;
}) => {
  const { t } = useModernI18n();
  return (
    <fieldset className="grid gap-100">
      <legend className="mb-100 font-semibold">{t('shell.connect.access.title')}</legend>
      <label className="flex items-center gap-150 rounded bg-surface px-150 py-100">
        <input
          checked={mode === 'all'}
          className="accent-primary"
          name="access"
          onChange={() => onModeChange('all')}
          type="radio"
        />
        <span>{isAgent ? t('shell.connect.access.allAgent') : t('shell.connect.access.allMe')}</span>
      </label>
      <label className="flex items-center gap-150 rounded bg-surface px-150 py-100">
        <input
          checked={mode === 'pick'}
          className="accent-primary"
          name="access"
          onChange={() => onModeChange('pick')}
          type="radio"
        />
        <span>{t('shell.connect.access.pick')}</span>
      </label>
      {mode === 'pick' ? (
        <ul className="grid gap-100">
          {offered.map((module) => {
            const pick = picks.get(module.moduleId) ?? NO_PICK;
            const writeBlocked = !module.write || policy === 'read_only';
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-150 rounded bg-surface px-150 py-100"
                key={module.moduleId}
              >
                <span className="grid min-w-0 gap-050">
                  <span className="break-words">{module.label}</span>
                  {module.write ? null : (
                    <span className="text-fg-secondary text-sm">
                      {t(
                        isAgent
                          ? 'shell.connect.access.writeUnavailableAgent'
                          : 'shell.connect.access.writeUnavailable',
                      )}
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap gap-200">
                  <label className="flex items-center gap-100">
                    <input
                      checked={pick.read}
                      className="accent-primary"
                      onChange={(event) =>
                        onPickChange(module.moduleId, {
                          read: event.target.checked,
                          write: event.target.checked && pick.write,
                        })
                      }
                      type="checkbox"
                    />
                    {t('shell.connect.access.read')}
                  </label>
                  <label className="flex items-center gap-100">
                    <input
                      checked={pick.write && !writeBlocked}
                      className="accent-primary"
                      disabled={writeBlocked || !pick.read}
                      onChange={(event) =>
                        onPickChange(module.moduleId, { read: pick.read, write: event.target.checked })
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
  );
};

const policyHint = (policy: AgentWritePolicy, isAgent: boolean) => {
  if (policy === 'approval') {
    return 'shell.connect.policy.approvalHint';
  }
  return isAgent ? 'shell.connect.policy.directHintAgent' : 'shell.connect.policy.directHint';
};
const PolicyChoices = ({
  cap,
  isAgent,
  onPolicyChange,
  policy,
}: {
  readonly cap: AgentWritePolicy;
  readonly isAgent: boolean;
  readonly onPolicyChange: (value: AgentWritePolicy) => void;
  readonly policy: AgentWritePolicy;
}) => {
  const { t } = useModernI18n();
  return (
    <fieldset className="grid gap-100">
      <legend className="mb-100 font-semibold">{t('shell.connect.policy.title')}</legend>
      {POLICIES.map((candidate) => {
        const state = policyOptionState(candidate, cap);
        return (
          <label className="grid gap-050 rounded bg-surface px-150 py-100" key={candidate}>
            <span className="flex items-start gap-150">
              <input
                checked={policy === candidate}
                className="mt-050 accent-primary"
                disabled={state.disabled}
                name="policy"
                onChange={() => onPolicyChange(candidate)}
                type="radio"
              />
              <span className="grid gap-050">
                <span className="font-semibold">{t(`shell.connect.policy.${candidate}`)}</span>
                {candidate === 'read_only' ? null : (
                  <span className="text-fg-secondary text-sm">{t(policyHint(candidate, isAgent))}</span>
                )}
              </span>
            </span>
            {state.reasonKey === null ? null : <span className="text-fg-secondary text-sm">{t(state.reasonKey)}</span>}
          </label>
        );
      })}
    </fieldset>
  );
};

const ConnectPage = () => {
  const { t } = useModernI18n();
  const {
    acting,
    agent,
    busy,
    cancel,
    cap,
    chooseCompany,
    chooseMode,
    company,
    loaded,
    loadNotice,
    mode,
    notice,
    offered,
    options,
    picks,
    policy,
    selectActing,
    setModulePick,
    setPolicy,
    submit,
  } = useConnectForm();
  const clientName = options?.client.name ?? t('shell.connect.clientFallback');
  const clientLogoUri = options === undefined ? undefined : Option.getOrUndefined(options.client.logoUri);
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
              <div className="flex flex-wrap items-center gap-150 rounded-lg bg-surface p-200">
                {clientLogoUri === undefined || clientLogoUri === '' ? (
                  <Icon icon="icon-[mdi--application-outline]" size="md" />
                ) : (
                  <img alt="" className="size-icon-control-lg rounded-md" src={clientLogoUri} />
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
                  <ActingChoices
                    acting={acting}
                    company={company}
                    onSelect={(value) => selectActing(company, value)}
                    userDisplayName={options.user.displayName}
                  />

                  <AccessChoices
                    isAgent={agent !== undefined}
                    mode={mode}
                    offered={offered}
                    onModeChange={chooseMode}
                    onPickChange={setModulePick}
                    picks={picks}
                    policy={policy}
                  />

                  <PolicyChoices cap={cap} isAgent={agent !== undefined} onPolicyChange={setPolicy} policy={policy} />

                  {notice === undefined ? null : (
                    <StatusText aria-live="polite" showIcon status="error">
                      {failureText(notice)}
                    </StatusText>
                  )}
                  <div className="flex flex-wrap gap-150">
                    <Button disabled={busy} onClick={submit} size="md" theme="solid" type="button" variant="primary">
                      {t('shell.connect.continue')}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={cancel}
                      size="md"
                      theme="outlined"
                      type="button"
                      variant="secondary"
                    >
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
