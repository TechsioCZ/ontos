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
    <main className="min-h-screen bg-base px-200 py-300 text-fg-primary sm:px-400">
      <UltramodernRouteHead />
      <nav aria-label={t('inventory.language.switcher')} className="flex gap-150">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="rounded-full border border-border-primary bg-surface px-200 py-150 text-sm font-bold text-fg-primary no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang/"
          >
            {t(`inventory.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="mt-450 text-4xl font-bold">{t('inventory.title')}</h1>
      <p className="mt-150 text-lg text-fg-secondary" data-modern-mf-role="vertical">
        {t('inventory.role')}
      </p>
      <p className="sr-only" data-build-marker={ultramodernUiMarker.build} data-testid="ultramodern-ui-marker">
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <p data-testid="api-status">{apiStatus}</p>
    </main>
  );
};

export default InventoryHome;
