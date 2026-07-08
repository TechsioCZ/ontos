import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { useEffect, useState } from 'react';
import { Effect, listTicketing, runEffectRequest } from '../../api/ticketing-client';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { ultramodernUiMarker } from '../../ultramodern-build';

export default function TicketingHome() {
  const { language, supportedLanguages, t } = useModernI18n();
  const [apiStatus, setApiStatus] = useState('pending');

  useEffect(() => {
    let cancelled = false;
    void runEffectRequest(
      listTicketing({ limit: 1 }).pipe(
        Effect.match({
          onFailure: () => {
            if (cancelled) {
              return;
            }
            setApiStatus('unavailable');
          },
          onSuccess: (data) => {
            if (cancelled) {
              return;
            }
            setApiStatus(data.items.at(0)?.title ?? 'empty');
          },
        }),
      ),
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="ticketing:min-h-screen ticketing:bg-um-canvas ticketing:px-4 ticketing:py-6 ticketing:text-um-foreground ticketing:sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('ticketing.language.switcher')} className="ticketing:flex ticketing:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="ticketing:rounded-full ticketing:border ticketing:border-stone-900/15 ticketing:bg-white ticketing:px-4 ticketing:py-2 ticketing:text-sm ticketing:font-bold ticketing:text-stone-950 ticketing:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`ticketing.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="ticketing:mt-10 ticketing:text-5xl ticketing:font-black">
        {t('ticketing.title')}
      </h1>
      <p
        className="ticketing:mt-3 ticketing:text-lg ticketing:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('ticketing.role')}
      </p>
      <p
        className="ticketing:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <p data-testid="api-status">{apiStatus}</p>
    </main>
  );
}
