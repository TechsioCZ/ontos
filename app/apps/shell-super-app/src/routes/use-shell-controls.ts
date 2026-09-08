import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match, Schema } from 'effect';
import { useState } from 'react';
import { signOut, switchLegalEntity, switchTenant } from '../api/auth-client.ts';
import type { SwitchLegalEntityClientError, SwitchTenantClientError } from '../api/auth-client.ts';
import { SwitchLegalEntityPayloadSchema, SwitchTenantPayloadSchema } from '../../shared/api.ts';
import { runBrowserEffect } from '../runtime/browser-effect-runtime.ts';
import type { AuthenticatedHomePageModel } from './[lang]/page.data.ts';

const SwitchFailureStateSchema = Schema.Literals(['authentication-required', 'failed']);
type SwitchFailureState = typeof SwitchFailureStateSchema.Type;

const tenantSwitchFailureState = (error: SwitchTenantClientError): SwitchFailureState =>
  Match.value(error).pipe(
    Match.tag('TenantAuthenticationRequiredProblem', () => 'authentication-required' as const),
    Match.tag(
      'HttpClientError',
      'SchemaError',
      'TenantAccessForbiddenProblem',
      'TenantCapabilityUnavailableProblem',
      'TenantInternalProblem',
      () => 'failed' as const,
    ),
    Match.exhaustive,
  );

const legalEntitySwitchFailureState = (error: SwitchLegalEntityClientError): SwitchFailureState =>
  Match.value(error).pipe(
    Match.tag('TenantAuthenticationRequiredProblem', () => 'authentication-required' as const),
    Match.tag(
      'HttpClientError',
      'LegalEntityAccessForbiddenProblem',
      'SchemaError',
      'TenantCapabilityUnavailableProblem',
      'TenantInternalProblem',
      () => 'failed' as const,
    ),
    Match.exhaustive,
  );

export const useShellControls = (model: AuthenticatedHomePageModel | undefined) => {
  const { language } = useModernI18n();
  const navigate = useNavigate();
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [tenantSwitchPending, setTenantSwitchPending] = useState(false);
  const [tenantSwitchFailed, setTenantSwitchFailed] = useState(false);
  const [legalEntitySwitchPending, setLegalEntitySwitchPending] = useState(false);
  const [legalEntitySwitchFailed, setLegalEntitySwitchFailed] = useState(false);

  const reload = () =>
    Effect.tryPromise(() => navigate({ reloadDocument: true, to: '.' })).pipe(
      Effect.timeout('10 seconds'),
    );

  const handleLogout = () => {
    if (logoutPending) {
      return;
    }
    setLogoutPending(true);
    setLogoutFailed(false);
    void runBrowserEffect(
      signOut({ locale: language }).pipe(
        Effect.andThen(
          Effect.tryPromise(() =>
            navigate({ reloadDocument: true, to: `/${language}/login` }),
          ).pipe(Effect.timeout('10 seconds')),
        ),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              void error;
              setLogoutFailed(true);
            }),
          onSuccess: Effect.succeed,
        }),
        Effect.ensuring(Effect.sync(() => setLogoutPending(false))),
      ),
    );
  };

  const runSwitch = <E>(
    switching: Effect.Effect<unknown, E>,
    switchFailureState: (error: NoInfer<E>) => SwitchFailureState,
    setPending: (pending: boolean) => void,
    setFailed: (failed: boolean) => void,
  ) => {
    setPending(true);
    setFailed(false);
    void runBrowserEffect(
      switching.pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(switchFailureState(error)),
          onSuccess: () => Effect.succeed('switched' as const),
        }),
        Effect.flatMap((outcome) =>
          outcome === 'authentication-required' || outcome === 'switched'
            ? reload()
            : Effect.sync(() => setFailed(true)),
        ),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              void error;
              setFailed(true);
            }),
          onSuccess: Effect.succeed,
        }),
        Effect.ensuring(Effect.sync(() => setPending(false))),
      ),
    );
  };

  const handleLegalEntityChange = (legalEntityId: string) => {
    if (
      model === undefined ||
      legalEntitySwitchPending ||
      legalEntityId === model.selectedLegalEntityId
    ) {
      return;
    }
    runSwitch(
      Schema.decodeUnknownEffect(SwitchLegalEntityPayloadSchema)({ legalEntityId }).pipe(
        Effect.flatMap((payload) => switchLegalEntity(payload, { locale: language })),
      ),
      legalEntitySwitchFailureState,
      setLegalEntitySwitchPending,
      setLegalEntitySwitchFailed,
    );
  };

  const handleTenantChange = (tenantId: string) => {
    if (
      model === undefined ||
      tenantSwitchPending ||
      tenantId.length === 0 ||
      tenantId === model.identity.tenantId
    ) {
      return;
    }
    runSwitch(
      Schema.decodeUnknownEffect(SwitchTenantPayloadSchema)({ tenantId }).pipe(
        Effect.flatMap((payload) => switchTenant(payload, { locale: language })),
      ),
      tenantSwitchFailureState,
      setTenantSwitchPending,
      setTenantSwitchFailed,
    );
  };

  return {
    handleLegalEntityChange,
    handleLogout,
    handleSearch: (query: string) => {
      void navigate({ to: `/${language}/search?q=${encodeURIComponent(query)}` });
    },
    handleTenantChange,
    legalEntitySwitchFailed,
    legalEntitySwitchPending,
    logoutFailed,
    logoutPending,
    tenantSwitchFailed,
    tenantSwitchPending,
  };
};
