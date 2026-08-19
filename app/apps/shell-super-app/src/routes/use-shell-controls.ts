/* eslint-disable promise/prefer-await-to-then -- Route integration starts typed Effect mutations from synchronous semantic callbacks. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import { useState } from 'react';
import { runEffectRequest, signOut, switchLegalEntity, switchTenant } from '../api/auth-client.ts';
import type { SwitchLegalEntityClientError, SwitchTenantClientError } from '../api/auth-client.ts';
import type { AuthenticatedHomePageModel } from './[lang]/page.data.ts';

type SwitchFailureState = 'authentication-required' | 'failed';

const tenantSwitchFailureState = (error: SwitchTenantClientError): SwitchFailureState =>
  error._tag === 'TenantAuthenticationRequiredProblem' ? 'authentication-required' : 'failed';

const legalEntitySwitchFailureState = (error: SwitchLegalEntityClientError): SwitchFailureState =>
  error._tag === 'TenantAuthenticationRequiredProblem' ? 'authentication-required' : 'failed';

export const useShellControls = (
  model: AuthenticatedHomePageModel | undefined,
  onSignedOut?: () => void,
) => {
  const { language } = useModernI18n();
  const navigate = useNavigate();
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [tenantSwitchPending, setTenantSwitchPending] = useState(false);
  const [tenantSwitchFailed, setTenantSwitchFailed] = useState(false);
  const [legalEntitySwitchPending, setLegalEntitySwitchPending] = useState(false);
  const [legalEntitySwitchFailed, setLegalEntitySwitchFailed] = useState(false);

  const reload = () => {
    void navigate({ reloadDocument: true, to: '.' });
  };

  const handleLogout = () => {
    if (logoutPending) {
      return;
    }
    setLogoutPending(true);
    setLogoutFailed(false);
    void runEffectRequest(signOut({ locale: language }))
      .then(() => {
        if (onSignedOut === undefined) {
          void navigate({ reloadDocument: true, to: `/${language}/login` });
        } else {
          onSignedOut();
        }
      })
      .catch(() => setLogoutFailed(true))
      .finally(() => setLogoutPending(false));
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
    void runEffectRequest(
      switchLegalEntity({ legalEntityId }, { locale: language }).pipe(
        Effect.match({
          onFailure: legalEntitySwitchFailureState,
          onSuccess: () => 'switched' as const,
        }),
      ),
    )
      .then((outcome) => {
        if (outcome === 'authentication-required' || outcome === 'switched') {
          reload();
        } else {
          setLegalEntitySwitchFailed(true);
        }
      })
      .catch(() => setLegalEntitySwitchFailed(true))
      .finally(() => setLegalEntitySwitchPending(false));
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
    void runEffectRequest(
      switchTenant({ tenantId }, { locale: language }).pipe(
        Effect.match({
          onFailure: tenantSwitchFailureState,
          onSuccess: () => 'switched' as const,
        }),
      ),
    )
      .then((outcome) => {
        if (outcome === 'authentication-required' || outcome === 'switched') {
          reload();
        } else {
          setTenantSwitchFailed(true);
        }
      })
      .catch(() => setTenantSwitchFailed(true))
      .finally(() => setTenantSwitchPending(false));
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
