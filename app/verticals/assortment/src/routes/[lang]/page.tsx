import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';

import { getAssortmentReadiness, runEffectRequest } from '../../api/assortment-client';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const AssortmentHome = () => {
  const { language, supportedLanguages, t } = useModernI18n();
  const [apiStatus, setApiStatus] = useState('pending');

  useEffect(() => {
    let cancelled = false;
    void runEffectRequest(
      getAssortmentReadiness().pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.logDebug('Assortment readiness unavailable', error).pipe(Effect.as('unavailable')),
          onSuccess: (data) => Effect.succeed(data.status),
        }),
        Effect.tap((status) =>
          Effect.sync(() => {
            if (cancelled) {
              return;
            }
            setApiStatus(status);
          }),
        ),
      ),
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="assortment:min-h-screen assortment:bg-um-canvas assortment:px-4 assortment:py-6 assortment:text-um-foreground assortment:sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('assortment.language.switcher')} className="assortment:flex assortment:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="assortment:rounded-full assortment:border assortment:border-stone-900/15 assortment:bg-white assortment:px-4 assortment:py-2 assortment:text-sm assortment:font-bold assortment:text-stone-950 assortment:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`assortment.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="assortment:mt-10 assortment:text-5xl assortment:font-black">{t('assortment.title')}</h1>
      <p className="assortment:mt-3 assortment:text-lg assortment:text-stone-600" data-modern-mf-role="vertical">
        {t('assortment.role')}
      </p>
      <p
        className="assortment:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <p data-testid="api-status">{apiStatus}</p>
    </main>
  );
};

export default AssortmentHome;
