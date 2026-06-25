import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { useEffect, useState } from 'react';
import { Effect, listAccounting, runEffectRequest } from '../../effect/accounting-client';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { ultramodernUiMarker } from '../../ultramodern-build';

export default function AccountingHome() {
  const { i18nInstance, language, supportedLanguages } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const [effectApiStatus, setEffectApiStatus] = useState('pending');

  useEffect(() => {
    let cancelled = false;
    void runEffectRequest(
      listAccounting({ limit: 1 }).pipe(
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
    <main className="accounting:min-h-screen accounting:bg-um-canvas accounting:px-4 accounting:py-6 accounting:text-um-foreground accounting:sm:px-8">
      <UltramodernRouteHead />
      <nav
        aria-label={t('accounting.language.switcher')}
        className="accounting:flex accounting:gap-3"
      >
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="accounting:rounded-full accounting:border accounting:border-stone-900/15 accounting:bg-white accounting:px-4 accounting:py-2 accounting:text-sm accounting:font-bold accounting:text-stone-950 accounting:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`accounting.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="accounting:mt-10 accounting:text-5xl accounting:font-black">
        {t('accounting.title')}
      </h1>
      <p
        className="accounting:mt-3 accounting:text-lg accounting:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('accounting.role')}
      </p>
      <p
        className="accounting:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <p data-testid="effect-bff-status">{effectApiStatus}</p>
    </main>
  );
}
