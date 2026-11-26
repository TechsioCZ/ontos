// The Symmy routes of one integration in the selected company. Enabling a route family runs Symmy's own audited
// `integration.symmy.manage-symmy-routes`; when that names integration workloads the principal does not hold yet, the
// panel registers them through Core's `core.identity.register-integration-workloads` and repeats the change once.
import { FormInput } from '@app/admin-ui/form-controls';
import { ManageSymmyRoutesPayloadSchema } from '@app/symmy-integration/actions/manage-symmy-routes';
import type { ManageSymmyRoutesPayload } from '@app/symmy-integration/actions/manage-symmy-routes';
import { ManageSymmyRoutesActionIneligibleProblemSchema } from '@app/symmy-integration/api/manage-symmy-routes-action';
import { executeManageSymmyRoutes } from '@app/symmy-integration/api/manage-symmy-routes-action/client';
import type { SymmyCompanyRoutesResponse } from '@app/symmy-integration/api/symmy-company-routes';
import { executeSymmyCompanyRoutes } from '@app/symmy-integration/api/symmy-company-routes/client';
import { SymmyCompanyRoutesForbiddenProblemSchema } from '@app/symmy-integration/api/symmy-company-routes';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { Effect, Schema } from 'effect';
import type { Cause } from 'effect';
import { useEffect, useEffectEvent, useState } from 'react';

import { RegisterIntegrationWorkloadsPayloadSchema } from '../../../shared/browser-api.ts';
import type { ManagedApiKeyListResponse } from '../../../shared/browser-api.ts';
import { registerIntegrationWorkloads } from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { newRequestToken } from './people-client.ts';
import {
  SYMMY_DEFAULT_RETENTION_DAYS,
  SYMMY_PANEL_ROUTES,
  symmyEnableChanges,
  symmyMissingWorkloads,
  symmyPendingRoutes,
} from './symmy-routes-model.ts';
import type { SymmyRouteChangeInput } from './symmy-routes-model.ts';

const copyKey = 'shell.integrations.symmyRoutes';
const timeout = '60 seconds';
const enableReason = 'Tenant administrator enabled Symmy routes for this company';
const disableReason = 'Tenant administrator disabled a Symmy route for this company';

type PrincipalId = ManagedApiKeyListResponse['items'][number]['principalId'];
type CompanyRoute = SymmyCompanyRoutesResponse['routes'][number];
type Refusals = NonNullable<typeof ManageSymmyRoutesActionIneligibleProblemSchema.Type.refusals>;

const isIneligible = Schema.is(ManageSymmyRoutesActionIneligibleProblemSchema);
const isReadForbidden = Schema.is(SymmyCompanyRoutesForbiddenProblemSchema);

class SymmyRoutesInputInvalid extends Schema.TaggedError<SymmyRoutesInputInvalid>()('SymmyRoutesInputInvalid', {
  cause: Schema.Defect(),
}) {}
const inputInvalid = (cause: unknown) => new SymmyRoutesInputInvalid({ cause });

const readRoutes = (principalId: PrincipalId) =>
  newRequestToken.pipe(
    Effect.flatMap((correlation) => executeSymmyCompanyRoutes({ integrationPrincipalId: principalId }, correlation)),
    Effect.map(({ routes }) => routes),
  );

const submitRoutes = (payload: ManageSymmyRoutesPayload) =>
  newRequestToken.pipe(Effect.flatMap((token) => executeManageSymmyRoutes(payload, token, { idempotencyKey: token })));

const registerMissing = Effect.fn('SymmyRoutesPanel.registerMissing')(function* registerMissing(
  principalId: PrincipalId,
  workloadKeys: readonly [string, ...string[]],
) {
  const registration = yield* Schema.decodeUnknownEffect(RegisterIntegrationWorkloadsPayloadSchema)({
    principalId,
    workloadKeys,
  }).pipe(Effect.mapError(inputInvalid));
  return yield* registerIntegrationWorkloads(registration, { idempotencyKey: yield* newRequestToken });
});

/** One route change, repeated once after registering the integration workloads it names as missing. */
const changeRoutes = Effect.fn('SymmyRoutesPanel.changeRoutes')(function* changeRoutes(
  principalId: PrincipalId,
  changes: readonly SymmyRouteChangeInput[],
  reason: string,
) {
  const payload = yield* Schema.decodeUnknownEffect(ManageSymmyRoutesPayloadSchema)({
    changes,
    integrationPrincipalId: principalId,
    reason,
  }).pipe(Effect.mapError(inputInvalid));
  return yield* submitRoutes(payload).pipe(
    Effect.catch((error) => {
      const missing = isIneligible(error) ? symmyMissingWorkloads(error.refusals ?? []) : null;
      return missing === null
        ? Effect.fail(error)
        : registerMissing(principalId, missing).pipe(Effect.andThen(submitRoutes(payload)));
    }),
  );
});
type RouteChangeFailure = Effect.Error<ReturnType<typeof changeRoutes>> | Cause.TimeoutError;

type ChangeState =
  | { readonly kind: 'failed' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'refused'; readonly refusals: Refusals }
  | { readonly kind: 'saving' };

const failureState = (problem: RouteChangeFailure): ChangeState => {
  if (isIneligible(problem)) {
    return { kind: 'refused', refusals: problem.refusals ?? [] };
  }
  return Schema.is(SymmyRoutesInputInvalid)(problem) ? { kind: 'invalid' } : { kind: 'failed' };
};

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

/** Symmy's routes of this integration in the selected company, and the form that enables more of them. */
export const SymmyRoutesPanel = ({ principalId }: { readonly principalId: PrincipalId }) => {
  const { t } = useModernI18n();
  const [routes, setRoutes] = useState<readonly CompanyRoute[] | null>(null);
  const [readFailure, setReadFailure] = useState<'readFailed' | 'readForbidden' | null>(null);
  const [change, setChange] = useState<ChangeState>({ kind: 'idle' });
  const [issuerId, setIssuerId] = useState('');
  const [sourceNamespace, setSourceNamespace] = useState('');
  const [retentionDays, setRetentionDays] = useState(String(SYMMY_DEFAULT_RETENTION_DAYS));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(SYMMY_PANEL_ROUTES));
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
  const run = (changes: readonly SymmyRouteChangeInput[], reason: string) => {
    if (changes.length === 0 || change.kind === 'saving') {
      return;
    }
    setChange({ kind: 'saving' });
    browserRuntime.runFork(
      changeRoutes(principalId, changes, reason).pipe(
        Effect.timeout(timeout),
        Effect.match({
          onFailure: (problem) => setChange(failureState(problem)),
          onSuccess: () => {
            setChange({ kind: 'idle' });
            load();
          },
        }),
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
  const pending = routes === null ? [] : symmyPendingRoutes(routes);
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
          <RouteRow key={route.routeId} onDisable={disable} route={route} saving={saving} />
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
              placeholder="symmy-akros"
              required
              value={issuerId}
            />
            <FormInput
              autoComplete="off"
              label={t(`${copyKey}.sourceNamespace`)}
              maxLength={300}
              name="symmySourceNamespace"
              onChange={(event) => setSourceNamespace(event.target.value)}
              placeholder="akros-erp"
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
              disabled={saving || issuerId.trim().length === 0 || sourceNamespace.trim().length === 0}
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
      {change.kind === 'refused' && (
        <StatusText showIcon status="error">
          {t(`${copyKey}.refused`)}
          <ul className="list-disc pl-200">
            {change.refusals.map((refusal) => (
              <li className="[overflow-wrap:anywhere]" key={`${refusal.code}:${refusal.detail}`}>
                {refusal.detail}
              </li>
            ))}
          </ul>
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
