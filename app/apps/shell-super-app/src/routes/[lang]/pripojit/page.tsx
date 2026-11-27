import {
  ChoiceField,
  FormReact,
  FormRoot,
  FormRootError,
  MemberCheckboxField,
  RadioField,
  SubmitButton,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
  useFormPending,
} from '@app/core-runtime/ui/form';
import type { AgentWritePolicy } from '@app/shared-contracts/agent-access';
import { ConnectDraftRequestSchema, ConnectionPrincipalIdSchema } from '@app/shared-contracts/oauth-connections';
import type { ConnectCompanyOption, ConnectOptions } from '@app/shared-contracts/oauth-connections';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Fiber, Function as Fn, Option, Schema, SchemaTransformation, Struct } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useRef, useState } from 'react';

import { useBrowserLocationHref } from '../../browser-location.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { createDraftAndContinue, denyConnection, loadConnectOptions } from './connect-client.ts';
import {
  buildModulesRequest,
  ConnectFailureSchema,
  defaultPolicy,
  failureKey,
  loadFailure,
  policyOptionState,
  readOAuthQuery,
} from './connect-view-model.ts';
import type { ConnectOutcome } from './connect-client.ts';

const ME = 'me';

const ModeSchema = Schema.Literals(['all', 'pick']);
// A radio group holds its choice as text; the form decodes it to one of the literals.
const ModeChoiceSchema = Schema.String.pipe(Schema.decodeTo(ModeSchema, SchemaTransformation.passthroughSupertype()));
const PolicyChoiceSchema = Schema.String.pipe(
  Schema.decodeTo(ConnectDraftRequestSchema.fields.writePolicy, SchemaTransformation.passthroughSupertype()),
);
type Module = ConnectCompanyOption['modules'][number];

const POLICIES: readonly AgentWritePolicy[] = ['read_only', 'approval', 'direct'];

/** Why the connect API refused the draft or the cancel; each reason names its `shell.connect.error.*` message. */
class ConnectRefused extends Schema.TaggedError<ConnectRefused>()('ConnectRefused', { reason: ConnectFailureSchema }) {}

const modulePicks = (reads: readonly string[], writes: readonly string[]) => {
  const written = new Set(writes);
  return new Map(
    reads.map((moduleId): [string, { read: boolean; write: boolean }] => [
      moduleId,
      { read: true, write: written.has(moduleId) },
    ]),
  );
};

/**
 * The draft of a connection: the company, the policy and the signed query come from the draft payload; who acts,
 * whether every module is shared and which modules are read or written are the screen's own choices. Picking
 * modules needs at least one module to read.
 */
const connectForm = FormReact.make(
  fromPayload(ConnectDraftRequestSchema.mapFields(Struct.pick(['legalEntityId', 'oauthQuery'])))
    .addField('acting', Schema.String)
    .addField('mode', ModeChoiceSchema)
    .addField('reads', Schema.Array(Schema.String))
    .addField('writePolicy', PolicyChoiceSchema)
    .addField('writes', Schema.Array(Schema.String))
    .refine(({ mode, reads }) => mode === 'all' || reads.length > 0 || 'shell.connect.access.pickRequired'),
  {
    fields: {
      acting: RadioField,
      legalEntityId: ChoiceField,
      mode: RadioField,
      oauthQuery: TextField,
      reads: MemberCheckboxField,
      writePolicy: RadioField,
      writes: MemberCheckboxField,
    },
    onSubmit: (_submit, { decoded }) =>
      createDraftAndContinue({
        actingPrincipalId:
          decoded.acting === ME ? Option.none() : Option.some(ConnectionPrincipalIdSchema.make(decoded.acting)),
        legalEntityId: decoded.legalEntityId,
        // A read-only policy cannot send write access, whatever the write boxes still hold.
        modules: buildModulesRequest(
          decoded.mode,
          modulePicks(decoded.reads, decoded.writePolicy === 'read_only' ? [] : decoded.writes),
        ),
        oauthQuery: decoded.oauthQuery,
        writePolicy: decoded.writePolicy,
      }).pipe(
        Effect.flatMap((outcome) =>
          outcome.status === 'failed'
            ? Effect.fail(new ConnectRefused({ reason: outcome.reason }))
            : Effect.sync(() => globalThis.location.assign(outcome.value)),
        ),
      ),
    runtime: browserAtomRuntime,
    submitErrors: ({ reason }) => [{ message: failureKey(reason), path: '' as const }],
  },
);
interface ConnectValues {
  readonly acting: string;
  readonly legalEntityId: string;
  readonly mode: string;
  readonly oauthQuery: string;
  readonly reads: readonly string[];
  readonly writePolicy: string;
  readonly writes: readonly string[];
}

/** Cancelling before any draft exists: the client hears the refusal; the page then follows its redirect. */
const cancelConnection = browserAtomRuntime.fn((oauthQuery: string) =>
  denyConnection(Option.none(), oauthQuery).pipe(
    Effect.flatMap((outcome) =>
      outcome.status === 'failed'
        ? Effect.fail(new ConnectRefused({ reason: outcome.reason }))
        : Effect.sync(() => globalThis.location.assign(outcome.value.redirectTo)),
    ),
  ),
);

/** What the acting principal is offered in the chosen company: its modules and its writing ceiling. */
const offerFor = (options: ConnectOptions, legalEntityId: string, acting: string) => {
  const company = options.companies.find((candidate) => candidate.legalEntityId === legalEntityId);
  const agent = acting === ME ? undefined : company?.agents.find((candidate) => candidate.principalId === acting);
  const cap: AgentWritePolicy = agent?.writePolicy ?? 'direct';
  const modules: readonly Module[] = agent?.modules ?? company?.modules ?? [];
  return { agent, cap, company, modules };
};

/** Writing is offered wherever the acting principal may write, unless the policy only reads. */
const offeredWrites = (modules: readonly Module[], policy: string): readonly string[] =>
  policy === 'read_only' ? [] : modules.flatMap((module) => (module.write ? [module.moduleId] : []));

/** Module picking starts from the full offer under the safest policy the ceiling allows. */
const offeredAccess = (modules: readonly Module[], cap: AgentWritePolicy) => {
  const writePolicy = defaultPolicy(cap);
  return { reads: modules.map((module) => module.moduleId), writePolicy, writes: offeredWrites(modules, writePolicy) };
};

const initialValues = (options: ConnectOptions, oauthQuery: string): ConnectValues | undefined => {
  const preferredCompanyId = Option.getOrUndefined(options.preselect.legalEntityId);
  const preferredAgentId = Option.getOrUndefined(options.preselect.agentPrincipalId);
  const company =
    options.companies.find((candidate) => candidate.legalEntityId === preferredCompanyId) ?? options.companies[0];
  if (company === undefined) {
    return undefined;
  }
  const acting = company.agents.find((candidate) => candidate.principalId === preferredAgentId)?.principalId ?? ME;
  const { cap, modules } = offerFor(options, company.legalEntityId, acting);
  return { acting, legalEntityId: company.legalEntityId, mode: 'all', oauthQuery, ...offeredAccess(modules, cap) };
};

/**
 * The choices one change of the person implies: another company acts as the person, another acting principal
 * starts from its own offer, picking modules starts from the full offer, a read-only policy writes nothing and
 * leaving it offers writing again, and a module no longer read is no longer written. `undefined`: nothing follows.
 */
const followingChoices = (
  options: ConnectOptions,
  previous: ConnectValues,
  next: ConnectValues,
): ConnectValues | undefined => {
  if (next.legalEntityId !== previous.legalEntityId || next.acting !== previous.acting) {
    const acting = next.legalEntityId === previous.legalEntityId ? next.acting : ME;
    const { cap, modules } = offerFor(options, next.legalEntityId, acting);
    return { ...next, acting, ...offeredAccess(modules, cap) };
  }
  const { modules } = offerFor(options, next.legalEntityId, next.acting);
  if (next.mode !== previous.mode && next.mode === 'pick') {
    return {
      ...next,
      reads: modules.map((module) => module.moduleId),
      writes: offeredWrites(modules, next.writePolicy),
    };
  }
  const read = new Set(next.reads);
  if (
    next.writePolicy !== previous.writePolicy &&
    (next.writePolicy === 'read_only' || previous.writePolicy === 'read_only')
  ) {
    return { ...next, writes: offeredWrites(modules, next.writePolicy).filter((id) => read.has(id)) };
  }
  const writes = next.writes.filter((id) => read.has(id));
  return writes.length === next.writes.length ? undefined : { ...next, writes };
};

/** Applies the choices each change implies, read from the values the change left. */
const useFollowingChoices = (options: ConnectOptions, values: ConnectValues) => {
  const setValues = useAtomSet(connectForm.setValues);
  const previous = useRef(values);
  useAtomSubscribe(connectForm.values, (current) => {
    if (Option.isNone(current)) {
      return;
    }
    const following = followingChoices(options, previous.current, current.value);
    previous.current = following ?? current.value;
    if (following !== undefined) {
      setValues(following);
    }
  });
};

const policyHint = (policy: string, isAgent: boolean) => {
  if (policy === 'approval') {
    return 'shell.connect.policy.approvalHint';
  }
  return isAgent ? 'shell.connect.policy.directHintAgent' : 'shell.connect.policy.directHint';
};

const ActingChoices = ({
  acting,
  company,
  userDisplayName,
}: {
  readonly acting: string;
  readonly company: ConnectCompanyOption;
  readonly userDisplayName: string;
}) => {
  const { t } = useModernI18n();
  if (company.agents.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-100">
      <connectForm.acting
        describedBy="connect-acting-hint"
        items={[
          { label: t('shell.connect.acting.me', { name: userDisplayName }), value: ME },
          ...company.agents.map((candidate) => ({
            label: t('shell.connect.acting.agent', { name: candidate.displayName }),
            value: candidate.principalId,
          })),
        ]}
        label={t('shell.connect.acting.title')}
      />
      <p className="text-fg-secondary text-sm" id="connect-acting-hint">
        {t(acting === ME ? 'shell.connect.acting.meHint' : 'shell.connect.acting.agentHint')}
      </p>
    </div>
  );
};

const AccessChoices = ({
  isAgent,
  modules,
  values,
}: {
  readonly isAgent: boolean;
  readonly modules: readonly Module[];
  readonly values: ConnectValues;
}) => {
  const { t } = useModernI18n();
  return (
    <div className="grid gap-100">
      <connectForm.mode
        items={[
          { label: isAgent ? t('shell.connect.access.allAgent') : t('shell.connect.access.allMe'), value: 'all' },
          { label: t('shell.connect.access.pick'), value: 'pick' },
        ]}
        label={t('shell.connect.access.title')}
      />
      {values.mode === 'pick' ? (
        <ul className="grid gap-100">
          {modules.map((module) => {
            const read = values.reads.includes(module.moduleId);
            const writeBlocked = !module.write || values.writePolicy === 'read_only';
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
                  <connectForm.reads label={t('shell.connect.access.read')} member={module.moduleId} />
                  <connectForm.writes
                    disabled={writeBlocked || !read}
                    label={t('shell.connect.access.write')}
                    member={module.moduleId}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};

const PolicyChoices = ({
  cap,
  isAgent,
  policy,
}: {
  readonly cap: AgentWritePolicy;
  readonly isAgent: boolean;
  readonly policy: string;
}) => {
  const { t } = useModernI18n();
  // A policy above the ceiling cannot be chosen; the ceiling's reason says why it is missing.
  const reasonKey = POLICIES.map((candidate) => policyOptionState(candidate, cap).reasonKey).find(
    (key) => key !== null,
  );
  return (
    <div className="grid gap-100">
      <connectForm.writePolicy
        describedBy="connect-policy-hint"
        items={POLICIES.flatMap((candidate) =>
          policyOptionState(candidate, cap).disabled
            ? []
            : [{ label: t(`shell.connect.policy.${candidate}`), value: candidate }],
        )}
        label={t('shell.connect.policy.title')}
      />
      <span className="grid gap-050 text-fg-secondary text-sm" id="connect-policy-hint">
        {policy === 'read_only' ? null : <span>{t(policyHint(policy, isAgent))}</span>}
        {reasonKey === undefined ? null : <span>{t(reasonKey)}</span>}
      </span>
    </div>
  );
};

const CancelButton = ({ onCancel }: { readonly onCancel: () => void }) => {
  const { t } = useModernI18n();
  return (
    <Button
      appearance="outline"
      disabled={useFormPending()}
      onClick={onCancel}
      severity="secondary"
      size="md"
      type="button"
    >
      {t('shell.connect.cancel')}
    </Button>
  );
};

interface ChoicesProps {
  /** The translated reason the last cancel failed. */
  readonly cancelNotice: string | undefined;
  readonly onCancel: () => void;
  readonly options: ConnectOptions;
}

const InitializedChoices = ({
  cancelNotice,
  onCancel,
  options,
  values,
}: ChoicesProps & { readonly values: ConnectValues }) => {
  const { t } = useModernI18n();
  useFollowingChoices(options, values);
  const { agent, cap, company, modules } = offerFor(options, values.legalEntityId, values.acting);
  return (
    <>
      <section className="grid gap-100">
        <h2 className="font-semibold">{t('shell.connect.company.title')}</h2>
        {options.companies.length > 1 ? (
          <connectForm.legalEntityId
            items={options.companies.map((candidate) => ({
              label: candidate.legalName,
              value: candidate.legalEntityId,
            }))}
            label={t('shell.connect.company.question')}
          />
        ) : (
          <>
            <p className="text-fg-secondary text-sm">{t('shell.connect.company.question')}</p>
            <p className="font-semibold">{company?.legalName}</p>
          </>
        )}
      </section>
      {company === undefined ? null : (
        <ActingChoices acting={values.acting} company={company} userDisplayName={options.user.displayName} />
      )}
      <AccessChoices isAgent={agent !== undefined} modules={modules} values={values} />
      <PolicyChoices cap={cap} isAgent={agent !== undefined} policy={values.writePolicy} />
      <FormRootError form={connectForm} />
      {cancelNotice === undefined ? null : (
        <StatusText aria-live="polite" showIcon status="error">
          {cancelNotice}
        </StatusText>
      )}
      <div className="flex flex-wrap gap-150">
        <SubmitButton appearance="solid" severity="primary" size="md">
          {t('shell.connect.continue')}
        </SubmitButton>
        <CancelButton onCancel={onCancel} />
      </div>
    </>
  );
};

/** The choices of the connection, rendered inside the initialized form. */
const ConnectChoices = (props: ChoicesProps) => {
  const values = Option.getOrUndefined(useAtomValue(connectForm.values));
  return values === undefined ? null : <InitializedChoices {...props} values={values} />;
};

const useConnectOptions = (oauthQuery: string | undefined) => {
  const [loadedResult, setLoadedResult] = useState<{
    readonly outcome: ConnectOutcome<ConnectOptions>;
    readonly query: string;
  }>();
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
  return loadedResult !== undefined && loadedResult.query === oauthQuery ? loadedResult.outcome : undefined;
};

const ClientCard = ({ client }: { readonly client: ConnectOptions['client'] }) => {
  const { t } = useModernI18n();
  const logoUri = Option.getOrUndefined(client.logoUri);
  return (
    <div className="flex flex-wrap items-center gap-150 rounded-lg bg-surface p-200">
      {logoUri === undefined || logoUri === '' ? (
        <Icon icon="icon-[mdi--application-outline]" size="md" />
      ) : (
        <img alt="" className="size-icon-control-lg rounded-md" src={logoUri} />
      )}
      <div className="grid min-w-0 flex-1 gap-100">
        <span className="break-words font-semibold">{client.name}</span>
        <div className="flex flex-wrap gap-100">
          <Badge severity="info" size="sm">
            {client.host}
          </Badge>
          <Badge severity={client.kind === 'loopback' ? 'warning' : 'success'} size="sm">
            {t(client.kind === 'loopback' ? 'shell.connect.badge.loopback' : 'shell.connect.badge.verified')}
          </Badge>
        </div>
      </div>
    </div>
  );
};

/** Cancelling the connection; a cancel that succeeded is leaving the page, so it stays in progress. */
const useCancel = () => {
  const cancelled = useAtomValue(cancelConnection);
  return {
    cancel: useAtomSet(cancelConnection),
    cancelFailure: Option.getOrUndefined(AsyncResult.error(cancelled)),
    cancelling: cancelled.waiting || AsyncResult.isSuccess(cancelled),
  };
};

const ConnectPage = () => {
  const { t } = useModernI18n();
  const href = useBrowserLocationHref();
  const oauthQuery = href === undefined ? undefined : readOAuthQuery(new URL(href).search);
  const loadResult = useConnectOptions(oauthQuery);
  const options = loadResult?.status === 'ok' ? loadResult.value : undefined;
  const loadNotice = loadFailure(oauthQuery, loadResult);
  const { cancel, cancelFailure, cancelling } = useCancel();
  const submitted = useAtomValue(connectForm.submit);
  const initial = options === undefined || oauthQuery === undefined ? undefined : initialValues(options, oauthQuery);
  const clientName = options?.client.name ?? t('shell.connect.clientFallback');

  return (
    <>
      <UltramodernRouteHead />
      <main className="flex min-h-dvh items-start justify-center bg-surface px-200 py-400 text-fg-primary">
        <div className="grid w-full max-w-[640px] gap-300 rounded-lg border border-border-primary bg-base p-300">
          {href !== undefined && loadNotice === undefined && options === undefined ? (
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
              <ClientCard client={options.client} />
              {initial === undefined || oauthQuery === undefined ? (
                <section className="grid gap-100">
                  <h2 className="font-semibold">{t('shell.connect.company.title')}</h2>
                  <StatusText aria-live="polite" showIcon status="error">
                    {t('shell.connect.company.none')}
                  </StatusText>
                </section>
              ) : (
                <FormRoot
                  // A connection that was created is leaving the page, like a cancel.
                  blocked={cancelling || AsyncResult.isSuccess(submitted)}
                  className="grid gap-300"
                  defaultValues={initial}
                  form={connectForm}
                  key={oauthQuery}
                  translateMessage={(message) => t(message, { client: clientName })}
                >
                  <ConnectChoices
                    cancelNotice={
                      cancelFailure === undefined
                        ? undefined
                        : t(failureKey(cancelFailure.reason), { client: clientName })
                    }
                    onCancel={() => cancel(oauthQuery)}
                    options={options}
                  />
                </FormRoot>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
};

export default ConnectPage;
