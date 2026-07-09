import { createLazyComponent } from '@module-federation/bridge-react';
import { getInstance } from '@module-federation/modern-js-v3/runtime';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Suspense, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import {
  isShellOperationContextAuthRequiredError,
  loadShellModuleStates,
} from '../shell-operation-context-client';
import { loadShellModuleFederationEntrypoint } from '../module-federation-gateway';
import type { ShellModuleEntrypoint } from '../module-entrypoints';

interface RemotePageModule {
  default: ComponentType;
}

interface ShellRemoteLoadingProps {
  readonly entrypoint: ShellModuleEntrypoint;
  readonly loadingLabel: string;
}

type ProtectedShellRemotePageProps = ShellRemoteLoadingProps;

type RemoteReadiness =
  | { readonly _tag: 'AuthRequired' }
  | { readonly _tag: 'Pending' }
  | { readonly _tag: 'Ready' }
  | { readonly _tag: 'Unavailable'; readonly error: Error };

const supportedLanguages = new Set(['en', 'cs']);

const normalizeLanguage = (language: string) =>
  supportedLanguages.has(language) ? language : 'en';

const currentReturnTo = () => {
  if (typeof window === 'undefined') {
    return '/';
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
};

const loginHref = (language: string) =>
  `/${normalizeLanguage(language)}/login?returnTo=${encodeURIComponent(currentReturnTo())}`;

const resolveRemoteReadiness = async (): Promise<RemoteReadiness> => {
  try {
    await loadShellModuleStates();
    return { _tag: 'Ready' };
  } catch (caughtError) {
    if (isShellOperationContextAuthRequiredError(caughtError)) {
      return { _tag: 'AuthRequired' };
    }

    return {
      _tag: 'Unavailable',
      error: caughtError instanceof Error ? caughtError : new Error(String(caughtError)),
    };
  }
};

const ShellRemoteLoading = ({ entrypoint, loadingLabel }: ShellRemoteLoadingProps) => (
  <section
    aria-busy="true"
    className="shell:rounded-2xl shell:border shell:border-stone-900/10 shell:bg-white/80 shell:p-5 shell:text-sm shell:font-semibold shell:text-stone-600"
    data-module-entrypoint={entrypoint.id}
  >
    {loadingLabel}
  </section>
);

const ShellRemoteFallback = ({ error: remoteError }: { readonly error: Error }) => {
  const { language, t } = useModernI18n();
  const isAuthRequired = isShellOperationContextAuthRequiredError(remoteError);

  useEffect(() => {
    if (isAuthRequired) {
      window.location.assign(loginHref(language));
    }
  }, [isAuthRequired, language]);

  if (isAuthRequired) {
    return (
      <section
        aria-busy="true"
        className="shell:rounded-2xl shell:border shell:border-stone-900/10 shell:bg-white/80 shell:p-5 shell:text-sm shell:font-semibold shell:text-stone-600"
      >
        {t('shell.remoteUnavailable')}
      </section>
    );
  }

  return (
    <section
      className="shell:rounded-2xl shell:border shell:border-red-900/20 shell:bg-red-50 shell:p-5 shell:text-sm shell:font-semibold shell:text-red-900"
      data-remote-error={remoteError.name}
    >
      {t('shell.remoteUnavailable')}
    </section>
  );
};

export const ProtectedShellRemotePage = ({
  entrypoint,
  loadingLabel,
}: ProtectedShellRemotePageProps) => {
  const [hydrated, setHydrated] = useState(false);
  const [readiness, setReadiness] = useState<RemoteReadiness>({ _tag: 'Pending' });
  const { language, t } = useModernI18n();

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkReadiness = async () => {
      const nextReadiness = await resolveRemoteReadiness();
      if (!cancelled) {
        setReadiness(nextReadiness);
      }
    };

    void checkReadiness();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (readiness._tag === 'AuthRequired') {
      window.location.assign(loginHref(language));
    }
  }, [language, readiness._tag]);

  const FederatedPage = useMemo(() => {
    if (!hydrated || readiness._tag !== 'Ready') {
      return null;
    }

    const instance = getInstance();
    if (instance === null || instance === undefined) {
      return null;
    }

    return createLazyComponent({
      export: 'default',
      fallback: ShellRemoteFallback,
      instance,
      loader: () => loadShellModuleFederationEntrypoint<RemotePageModule>(entrypoint),
      loading: <ShellRemoteLoading entrypoint={entrypoint} loadingLabel={loadingLabel} />,
    });
  }, [entrypoint, hydrated, loadingLabel, readiness._tag]);

  if (readiness._tag === 'AuthRequired') {
    return <ShellRemoteLoading entrypoint={entrypoint} loadingLabel={loadingLabel} />;
  }

  if (readiness._tag === 'Unavailable') {
    return (
      <section
        className="shell:rounded-2xl shell:border shell:border-red-900/20 shell:bg-red-50 shell:p-5 shell:text-sm shell:font-semibold shell:text-red-900"
        data-module-entrypoint={entrypoint.id}
        data-remote-error={readiness.error.name}
      >
        {t('shell.remoteUnavailable')}
      </section>
    );
  }

  if (FederatedPage === null) {
    return <ShellRemoteLoading entrypoint={entrypoint} loadingLabel={loadingLabel} />;
  }

  return (
    <Suspense fallback={<ShellRemoteLoading entrypoint={entrypoint} loadingLabel={loadingLabel} />}>
      <FederatedPage />
    </Suspense>
  );
};
