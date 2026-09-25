import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { useEffect, useState } from 'react';

import { Effect, getInventoryReadiness } from '../../api/inventory-client';
import { browserRuntime } from '../../runtime/browser-effect-runtime';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const InventoryHome = () => {
  const { language, supportedLanguages, t } = useModernI18n();
  const [apiStatus, setApiStatus] = useState('pending');

  useEffect(() => {
    let cancelled = false;
    void browserRuntime.runPromise(
      getInventoryReadiness().pipe(
        Effect.match({
          onFailure: () => {
            if (cancelled) {
              return;
            }
            setApiStatus('unavailable');
          },
          onSuccess: (readiness) => {
            if (cancelled) {
              return;
            }
            setApiStatus(readiness.status);
          },
        }),
      ),
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="inventory:min-h-screen inventory:bg-um-canvas inventory:px-4 inventory:py-6 inventory:text-um-foreground inventory:sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('inventory.language.switcher')} className="inventory:flex inventory:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="inventory:rounded-full inventory:border inventory:border-stone-900/15 inventory:bg-white inventory:px-4 inventory:py-2 inventory:text-sm inventory:font-bold inventory:text-stone-950 inventory:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`inventory.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="inventory:mt-10 inventory:text-5xl inventory:font-black">{t('inventory.title')}</h1>
      <p className="inventory:mt-3 inventory:text-lg inventory:text-stone-600" data-modern-mf-role="vertical">
        {t('inventory.role')}
      </p>
      <p
        className="inventory:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <p data-testid="api-status">{apiStatus}</p>
    </main>
  );
};

export default InventoryHome;
