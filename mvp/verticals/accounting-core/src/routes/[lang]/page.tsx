import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { useEffect, useState } from 'react';
import { Effect, listAccountingCore, runEffectRequest } from '../../effect/accounting-core-client';
import { AccountingCoreSurface } from '../../components/accounting-core-surface';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { ultramodernUiMarker } from '../../ultramodern-build';

const supportedLanguages = ['en', 'cs'] as const;

export default function AccountingCoreHome() {
  const { i18nInstance, language } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const [effectApiStatus, setEffectApiStatus] = useState('pending');

  useEffect(() => {
    let cancelled = false;
    void runEffectRequest(
      listAccountingCore({ limit: 1 }).pipe(
        Effect.match({
          onFailure: () => {
            if (cancelled) {
              return;
            }
            setEffectApiStatus('unavailable');
          },
          onSuccess: (data) => {
            if (cancelled) {
              return;
            }
            setEffectApiStatus(data.items.at(0)?.title ?? 'empty');
          },
        }),
      ),
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="accountingcore:min-h-screen accountingcore:bg-um-canvas accountingcore:px-4 accountingcore:py-6 accountingcore:text-um-foreground accountingcore:sm:px-8">
      <UltramodernRouteHead />
      <nav
        aria-label={t('accounting-core.language.switcher')}
        className="accountingcore:flex accountingcore:gap-3"
      >
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="accountingcore:rounded-full accountingcore:border accountingcore:border-stone-900/15 accountingcore:bg-white accountingcore:px-4 accountingcore:py-2 accountingcore:text-sm accountingcore:font-bold accountingcore:text-stone-950 accountingcore:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`accounting-core.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="accountingcore:mt-10 accountingcore:text-5xl accountingcore:font-black">
        {t('accounting-core.title')}
      </h1>
      <p
        className="accountingcore:mt-3 accountingcore:text-lg accountingcore:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('accounting-core.role')}
      </p>
      <p
        className="accountingcore:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <div className="accountingcore:mt-8 accountingcore:max-w-6xl">
        <AccountingCoreSurface surface="route" />
      </div>
      <p
        className="accountingcore:mt-4 accountingcore:text-sm accountingcore:font-semibold accountingcore:text-stone-600"
        data-testid="effect-bff-status"
      >
        Effect BFF status: {effectApiStatus}
      </p>
    </main>
  );
}
