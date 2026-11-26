// Symmy's routes of one integration in the selected company, offered on the Shell's Integrace card of every Symmy
// integration (the core `integration` placement). Enabling a route family runs Symmy's own audited
// `integration.symmy.manage-symmy-routes`. When that refuses for a Symmy executor the Tenant has not enrolled or for
// integration workloads the principal does not hold yet, the panel lists exactly those writes and, only after the
// administrator confirms them, asks the Shell to make them through Core's
// `core.identity.change-system-workload-enrollment` and `core.identity.register-integration-workloads`, then repeats
// the change once.
import { FormInput } from '@app/admin-ui/form-controls';
import type {
  ConnectorPartnerComponentProps,
  ConnectorPartnerCoreWriteOutcome,
} from '@app/shared-contracts/integrations/connector-partner-component';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { Effect, Random, Schema } from 'effect';
import { useEffect, useEffectEvent, useState } from 'react';

import { ManageSymmyRoutesPayloadSchema } from '../../shared/actions/manage-symmy-routes.ts';
import type { ManageSymmyRoutesPayload } from '../../shared/actions/manage-symmy-routes.ts';
import { ManageSymmyRoutesActionIneligibleProblemSchema } from '../../shared/apis/manage-symmy-routes-action.ts';
import { SymmyCompanyRoutesForbiddenProblemSchema } from '../../shared/apis/symmy-company-routes.ts';
import type { SymmyCompanyRoutesResponse } from '../../shared/apis/symmy-company-routes.ts';
import { executeManageSymmyRoutes } from '../api/manage-symmy-routes-action-client.ts';
import { executeSymmyCompanyRoutes } from '../api/symmy-company-routes-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import {
  SYMMY_DEFAULT_RETENTION_DAYS,
  SYMMY_INITIAL_ROUTE_CHOICE,
  SYMMY_PANEL_ROUTES,
  symmyEnableChanges,
  symmyFulfilThenRetry,
  symmyPendingRoutes,
  symmySubmitChange,
} from './symmy-routes-model.ts';
import type { SymmyPrerequisite, SymmyPrerequisites, SymmyRouteChangeInput } from './symmy-routes-model.ts';

const copyKey = 'symmy-integration.integrationRoutes';
const timeout = '60 seconds';
const enableReason = 'Tenant administrator enabled Symmy routes for this company';
const disableReason = 'Tenant administrator disabled a Symmy route for this company';
const enrollReason = 'Tenant administrator confirmed enrolling the Symmy executor to change Symmy routes';

type PrincipalId = ConnectorPartnerComponentProps['integrationPrincipalId'];
type CompanyRoute = SymmyCompanyRoutesResponse['routes'][number];
type Refusals = NonNullable<typeof ManageSymmyRoutesActionIneligibleProblemSchema.Type.refusals>;

const isIneligible = Schema.is(ManageSymmyRoutesActionIneligibleProblemSchema);
const isReadForbidden = Schema.is(SymmyCompanyRoutesForbiddenProblemSchema);

class SymmyRoutesInputInvalid extends Schema.TaggedError<SymmyRoutesInputInvalid>()('SymmyRoutesInputInvalid', {
  cause: Schema.Defect(),
}) {}
const inputInvalid = (cause: unknown) => new SymmyRoutesInputInvalid({ cause });

/** A random UUID-shaped token: one request correlation, or one idempotency key per write. */
const newRequestToken = Effect.gen(function* symmyRequestToken() {
  const words = yield* Effect.forEach([0, 1, 2, 3], () => Random.nextIntBetween(0, 0x1_00_00_00_00), {
    concurrency: 1,
  });
  const hex = words.map((word) => word.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

const readRoutes = (principalId: PrincipalId) =>
  newRequestToken.pipe(
    Effect.flatMap((correlation) => executeSymmyCompanyRoutes({ integrationPrincipalId: principalId }, correlation)),
    Effect.map(({ routes }) => routes),
  );

const submitRoutes = (payload: ManageSymmyRoutesPayload) =>
  newRequestToken.pipe(Effect.flatMap((token) => executeManageSymmyRoutes(payload, token, { idempotencyKey: token })));

type WriteCore = ConnectorPartnerComponentProps['writeCore'];

/** One confirmed Core identity write, made by the Shell; it fails when the Shell answers that it did not go through. */
const fulfil = (writeCore: WriteCore, prerequisite: SymmyPrerequisite) =>
  Effect.callback<ConnectorPartnerCoreWriteOutcome>((resume) => {
    writeCore(
      prerequisite.kind === 'enrollExecutor'
        ? {
            kind: 'enrollSystemWorkload',
            moduleKey: prerequisite.moduleKey,
            reason: enrollReason,
            workloadKey: prerequisite.workloadKey,
          }
        : { kind: 'registerIntegrationWorkloads', workloadKeys: prerequisite.workloadKeys },
      (outcome) => resume(Effect.succeed(outcome)),
    );
  }).pipe(
    Effect.timeout(timeout),
    Effect.flatMap((outcome) => (outcome === 'done' ? Effect.void : Effect.fail(outcome))),
  );

/** A route change as the administrator asked for it, kept to repeat it after confirmed writes. */
interface Attempt {
  readonly changes: readonly SymmyRouteChangeInput[];
  readonly reason: string;
}

const routePayload = (principalId: PrincipalId, { changes, reason }: Attempt) =>
  Schema.decodeUnknownEffect(ManageSymmyRoutesPayloadSchema)({
    changes,
    integrationPrincipalId: principalId,
    reason,
  }).pipe(Effect.mapError(inputInvalid));

/** One route change; a refusal the panel can resolve comes back as the writes for the administrator to confirm. */
const changeRoutes = (principalId: PrincipalId, attempt: Attempt) =>
  routePayload(principalId, attempt).pipe(
    Effect.flatMap((payload) => symmySubmitChange(submitRoutes(payload).pipe(Effect.timeout(timeout)))),
  );

/** The confirmed writes, then the same route change once more. */
const confirmAndRetry = (
  principalId: PrincipalId,
  writeCore: WriteCore,
  attempt: Attempt,
  prerequisites: SymmyPrerequisites,
) =>
  routePayload(principalId, attempt).pipe(
    Effect.flatMap((payload) =>
      symmyFulfilThenRetry(
        prerequisites,
        (prerequisite) => fulfil(writeCore, prerequisite),
        submitRoutes(payload).pipe(Effect.timeout(timeout)),
      ),
    ),
  );
type RouteChangeFailure = Effect.Error<ReturnType<typeof changeRoutes>>;
type ConfirmedRunProblem = Effect.Error<ReturnType<typeof confirmAndRetry>>;

type ChangeState =
  | { readonly attempt: Attempt; readonly kind: 'confirm'; readonly prerequisites: SymmyPrerequisites }
  | {
      readonly done: readonly SymmyPrerequisite[];
      readonly failed: SymmyPrerequisite | 'retry';
      readonly kind: 'confirmedRunFailed';
      readonly refusals: Refusals;
    }
  | { readonly kind: 'failed' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'refused'; readonly refusals: Refusals }
  | { readonly kind: 'saving' };

const isInvalid = Schema.is(SymmyRoutesInputInvalid);

const failureState = (problem: RouteChangeFailure): ChangeState => {
  if (isIneligible(problem)) {
    return { kind: 'refused', refusals: problem.refusals ?? [] };
  }
  return isInvalid(problem) ? { kind: 'invalid' } : { kind: 'failed' };
};

const confirmedRunFailureState = (failure: ConfirmedRunProblem): ChangeState => {
  // Only the route change's own input decodes before any write; a failed write still lists what went through.
  if (isInvalid(failure)) {
    return { kind: 'invalid' };
  }
  const refusals = isIneligible(failure.problem) ? (failure.problem.refusals ?? []) : [];
  return { done: failure.done, failed: failure.failed, kind: 'confirmedRunFailed', refusals };
};

const PrerequisiteItem = ({ prerequisite }: { readonly prerequisite: SymmyPrerequisite }) => {
  const { t } = useModernI18n();
  return (
    <li className="[overflow-wrap:anywhere]">
      {prerequisite.kind === 'enrollExecutor'
        ? t(`${copyKey}.prerequisite.enrollExecutor`, {
            moduleKey: prerequisite.moduleKey,
            workloadKey: prerequisite.workloadKey,
          })
        : t(`${copyKey}.prerequisite.registerWorkloads`)}
      {prerequisite.kind === 'registerWorkloads' && (
        <ul className="list-disc pl-200">
          {prerequisite.workloadKeys.map((workloadKey) => (
            <li className="font-mono text-xs" key={workloadKey}>
              {workloadKey}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

const RefusalList = ({ refusals }: { readonly refusals: Refusals }) => (
  <ul className="list-disc pl-200">
    {refusals.map((refusal) => (
      <li className="[overflow-wrap:anywhere]" key={`${refusal.code}:${refusal.detail}`}>
        {refusal.detail}
      </li>
    ))}
  </ul>
);

const RouteRow = ({
  onDisable,
  route,
  saving,
}: {
  readonly onDisable: (route: CompanyRoute) => void;
  readonly route: CompanyRoute;
  readonly saving: boolean;
}) => {
  const { t } = useModernI18n();
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-100 text-sm">
      <span className="[overflow-wrap:anywhere]">
        {t(`${copyKey}.route.${route.routeKey}`)}
        {route.routeCode === undefined ? '' : ` · ${route.routeCode}`}
      </span>
      <Badge size="sm" variant={route.active ? 'success' : 'outline'}>
        {t(`${copyKey}.${route.active ? 'active' : 'inactive'}`)}
      </Badge>
      {route.retentionDays !== undefined && (
        <span className="text-fg-secondary text-xs">{t(`${copyKey}.retention`, { days: route.retentionDays })}</span>
      )}
      {route.active && (
        <Button
          disabled={saving}
          onClick={() => onDisable(route)}
          size="sm"
          theme="outlined"
          type="button"
          variant="secondary"
        >
          {t(`${copyKey}.disable`)}
        </Button>
      )}
    </li>
  );
};

/** The writes a refused route change needs, listed exactly, made only after the administrator confirms them. */
const ConfirmPrerequisites = ({
  onCancel,
  onConfirm,
  prerequisites,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly prerequisites: SymmyPrerequisites;
}) => {
  const { t } = useModernI18n();
  return (
    <div className="flex min-w-0 flex-col gap-100">
      <StatusText showIcon status="warning">
        {t(`${copyKey}.confirmPrerequisites`)}
        <ul className="list-disc pl-200">
          {prerequisites.map((prerequisite) => (
            <PrerequisiteItem key={prerequisite.kind} prerequisite={prerequisite} />
          ))}
        </ul>
      </StatusText>
      <div className="flex flex-wrap gap-100">
        <Button onClick={onConfirm} size="sm" type="button" variant="primary">
          {t(`${copyKey}.confirm`)}
        </Button>
        <Button onClick={onCancel} size="sm" theme="outlined" type="button" variant="secondary">
          {t(`${copyKey}.cancel`)}
        </Button>
      </div>
    </div>
  );
};

/** Where a confirmed run stopped, with every write that already went through. */
const ConfirmedRunFailure = ({
  failure,
}: {
  readonly failure: Extract<ChangeState, { readonly kind: 'confirmedRunFailed' }>;
}) => {
  const { t } = useModernI18n();
  return (
    <StatusText showIcon status="error">
      {failure.failed === 'retry' ? (
        t(`${copyKey}.retryFailed`)
      ) : (
        <>
          {t(`${copyKey}.prerequisiteFailed`)}
          <ul className="list-disc pl-200">
            <PrerequisiteItem prerequisite={failure.failed} />
          </ul>
        </>
      )}
      {failure.done.length > 0 && (
        <>
          {t(`${copyKey}.prerequisitesDone`)}
          <ul className="list-disc pl-200">
            {failure.done.map((prerequisite) => (
              <PrerequisiteItem key={prerequisite.kind} prerequisite={prerequisite} />
            ))}
          </ul>
        </>
      )}
      {failure.refusals.length > 0 && <RefusalList refusals={failure.refusals} />}
    </StatusText>
  );
};

/** Symmy's routes of this integration in the selected company, and the form that enables more of them. */
export const SymmyRoutesPanel = ({
  integrationPrincipalId: principalId,
  writeCore,
}: ConnectorPartnerComponentProps) => {
  const { t } = useModernI18n();
  const [routes, setRoutes] = useState<readonly CompanyRoute[] | null>(null);
  const [readFailure, setReadFailure] = useState<'readFailed' | 'readForbidden' | null>(null);
  const [change, setChange] = useState<ChangeState>({ kind: 'idle' });
  const [issuerId, setIssuerId] = useState('');
  const [sourceNamespace, setSourceNamespace] = useState('');
  const [retentionDays, setRetentionDays] = useState(String(SYMMY_DEFAULT_RETENTION_DAYS));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(SYMMY_INITIAL_ROUTE_CHOICE));
  const load = () => {
    browserRuntime.runFork(
      readRoutes(principalId).pipe(
        Effect.timeout(timeout),
        Effect.match({
          onFailure: (problem) => setReadFailure(isReadForbidden(problem) ? 'readForbidden' : 'readFailed'),
          onSuccess: (read) => {
            setReadFailure(null);
            setRoutes(read);
          },
        }),
      ),
    );
  };
  const loadOnMount = useEffectEvent(load);
  useEffect(() => loadOnMount(), []);
  const settled = () => {
    setChange({ kind: 'idle' });
    setChosen(new Set(SYMMY_INITIAL_ROUTE_CHOICE));
    load();
  };
  const run = (changes: readonly SymmyRouteChangeInput[], reason: string) => {
    if (changes.length === 0 || change.kind === 'saving' || change.kind === 'confirm') {
      return;
    }
    const attempt = { changes, reason };
    setChange({ kind: 'saving' });
    browserRuntime.runFork(
      changeRoutes(principalId, attempt).pipe(
        Effect.match({
          onFailure: (problem) => setChange(failureState(problem)),
          onSuccess: (step) =>
            step.kind === 'done'
              ? settled()
              : setChange({ attempt, kind: 'confirm', prerequisites: step.prerequisites }),
        }),
      ),
    );
  };
  const confirm = () => {
    if (change.kind !== 'confirm') {
      return;
    }
    setChange({ kind: 'saving' });
    browserRuntime.runFork(
      confirmAndRetry(principalId, writeCore, change.attempt, change.prerequisites).pipe(
        Effect.match({ onFailure: (problem) => setChange(confirmedRunFailureState(problem)), onSuccess: settled }),
      ),
    );
  };
  const enable = () => {
    const days = Math.trunc(Number(retentionDays));
    const changes = symmyEnableChanges(
      {
        issuerId,
        retentionDays: days,
        routeKeys: SYMMY_PANEL_ROUTES.filter((routeKey) => chosen.has(routeKey)),
        sourceNamespace,
      },
      routes ?? [],
    );
    run(changes, enableReason);
  };
  const disable = (route: CompanyRoute) => {
    const base = { expectedChangeToken: route.changeToken, kind: 'disable' as const, routeKey: route.routeKey };
    run([route.routeCode === undefined ? base : { ...base, routeCode: route.routeCode }], disableReason);
  };
  const toggle = (routeKey: string, checked: boolean) => {
    const next = new Set(chosen);
    if (checked) {
      next.add(routeKey);
    } else {
      next.delete(routeKey);
    }
    setChosen(next);
  };
  const saving = change.kind === 'saving';
  const busy = saving || change.kind === 'confirm';
  const pending = routes === null ? [] : symmyPendingRoutes(routes);
  const nothingChosen = !pending.some((routeKey) => chosen.has(routeKey));
  return (
    <section className="flex min-w-0 flex-col gap-100 border-border-primary/60 border-t pt-150">
      <h3 className="font-medium text-sm">{t(`${copyKey}.title`)}</h3>
      <p className="text-fg-secondary text-xs">{t(`${copyKey}.description`)}</p>
      {readFailure !== null && (
        <StatusText showIcon status={readFailure === 'readForbidden' ? 'warning' : 'error'}>
          {t(`${copyKey}.${readFailure}`)}
        </StatusText>
      )}
      {routes?.length === 0 && <p className="text-fg-secondary text-xs">{t(`${copyKey}.empty`)}</p>}
      <ul className="flex min-w-0 flex-col gap-75">
        {routes?.map((route) => (
          <RouteRow key={route.routeId} onDisable={disable} route={route} saving={busy} />
        ))}
      </ul>
      {routes !== null && pending.length > 0 && (
        <div className="flex min-w-0 flex-col gap-100">
          <div className="flex min-w-0 flex-wrap gap-100">
            <FormInput
              autoComplete="off"
              label={t(`${copyKey}.issuerId`)}
              maxLength={300}
              name="symmyIssuerId"
              onChange={(event) => setIssuerId(event.target.value)}
              placeholder={t(`${copyKey}.issuerIdPlaceholder`)}
              required
              value={issuerId}
            />
            <FormInput
              autoComplete="off"
              label={t(`${copyKey}.sourceNamespace`)}
              maxLength={300}
              name="symmySourceNamespace"
              onChange={(event) => setSourceNamespace(event.target.value)}
              placeholder={t(`${copyKey}.sourceNamespacePlaceholder`)}
              required
              value={sourceNamespace}
            />
            <FormInput
              label={t(`${copyKey}.retentionDays`)}
              max={3650}
              min={1}
              name="symmyRetentionDays"
              onChange={(event) => setRetentionDays(event.target.value)}
              type="number"
              value={retentionDays}
            />
          </div>
          <div className="flex min-w-0 flex-wrap gap-150">
            {pending.map((routeKey) => (
              <FormCheckbox
                checked={chosen.has(routeKey)}
                id={`symmy-route-${principalId}-${routeKey}`}
                key={routeKey}
                label={t(`${copyKey}.route.${routeKey}`)}
                onCheckedChange={(checked) => toggle(routeKey, checked)}
                size="sm"
              />
            ))}
          </div>
          <div>
            <Button
              disabled={busy || nothingChosen || issuerId.trim().length === 0 || sourceNamespace.trim().length === 0}
              onClick={enable}
              size="sm"
              type="button"
              variant="primary"
            >
              {t(`${copyKey}.${saving ? 'working' : 'enable'}`)}
            </Button>
          </div>
        </div>
      )}
      {change.kind === 'confirm' && (
        <ConfirmPrerequisites
          onCancel={() => setChange({ kind: 'idle' })}
          onConfirm={confirm}
          prerequisites={change.prerequisites}
        />
      )}
      {change.kind === 'confirmedRunFailed' && <ConfirmedRunFailure failure={change} />}
      {change.kind === 'refused' && (
        <StatusText showIcon status="error">
          {t(`${copyKey}.refused`)}
          <RefusalList refusals={change.refusals} />
        </StatusText>
      )}
      {(change.kind === 'failed' || change.kind === 'invalid') && (
        <StatusText showIcon status="error">
          {t(`${copyKey}.${change.kind}`)}
        </StatusText>
      )}
    </section>
  );
};
