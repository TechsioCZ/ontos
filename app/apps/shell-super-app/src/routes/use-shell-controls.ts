import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match, Schema } from 'effect';
import { useState } from 'react';
import { signOut, switchLegalEntity, switchTenant } from '../api/auth-client.ts';
import type { SwitchLegalEntityClientError, SwitchTenantClientError } from '../api/auth-client.ts';
import { SwitchLegalEntityPayloadSchema, SwitchTenantPayloadSchema } from '../../shared/api.ts';
import { runBrowserEffect } from '../runtime/browser-effect-runtime.ts';
import type { AuthenticatedHomePageModel } from './[lang]/page.data.ts';

export const SwitchFailureStateSchema = Schema.Literals(['authentication-required', 'failed']);
export type SwitchFailureState = typeof SwitchFailureStateSchema.Type;

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

  const handleLegalEntityChange = (legalEntityId: string) => {
    if (
      model === undefined ||
      legalEntitySwitchPending ||
      legalEntityId === model.selectedLegalEntityId
    ) {
      return;
    }
    setLegalEntitySwitchPending(true);
    setLegalEntitySwitchFailed(false);
    void runBrowserEffect(
      Schema.decodeUnknownEffect(SwitchLegalEntityPayloadSchema)({ legalEntityId }).pipe(
        Effect.flatMap((payload) => switchLegalEntity(payload, { locale: language })),
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(legalEntitySwitchFailureState(error)),
          onSuccess: () => Effect.succeed('switched' as const),
        }),
        Effect.flatMap((outcome) =>
          outcome === 'authentication-required' || outcome === 'switched'
            ? reload()
            : Effect.sync(() => setLegalEntitySwitchFailed(true)),
        ),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              void error;
              setLegalEntitySwitchFailed(true);
            }),
          onSuccess: Effect.succeed,
        }),
        Effect.ensuring(Effect.sync(() => setLegalEntitySwitchPending(false))),
      ),
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
    setTenantSwitchPending(true);
    setTenantSwitchFailed(false);
    void runBrowserEffect(
      Schema.decodeUnknownEffect(SwitchTenantPayloadSchema)({ tenantId }).pipe(
        Effect.flatMap((payload) => switchTenant(payload, { locale: language })),
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(tenantSwitchFailureState(error)),
          onSuccess: () => Effect.succeed('switched' as const),
        }),
        Effect.flatMap((outcome) =>
          outcome === 'authentication-required' || outcome === 'switched'
            ? reload()
            : Effect.sync(() => setTenantSwitchFailed(true)),
        ),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              void error;
              setTenantSwitchFailed(true);
            }),
          onSuccess: Effect.succeed,
        }),
        Effect.ensuring(Effect.sync(() => setTenantSwitchPending(false))),
      ),
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
