import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

export default function TicketingRoute() {
  const { t } = useModernI18n();

  return (
    <section
      className="ticketing:rounded-2xl ticketing:bg-white/90 ticketing:p-5 ticketing:shadow-xl ticketing:shadow-stone-900/10"
      data-modern-boundary-id="verticalTicketing"
      data-modern-mf-expose="./Route"
    >
      <h2 className="ticketing:text-2xl ticketing:font-black">{t('ticketing.title')}</h2>
      <p className="ticketing:mt-2 ticketing:text-stone-600">{t('ticketing.routeSurface')}</p>
    </section>
  );
}
