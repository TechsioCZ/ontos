import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

export default function TicketingTicketingPage() {
  const { t } = useModernI18n();

  return (
    <section
      className="ticketing:rounded-2xl ticketing:bg-white/90 ticketing:p-5 ticketing:shadow-xl ticketing:shadow-stone-900/10"
      data-modern-boundary-id="remoteEntry.js"
      data-modern-mf-expose="./pages/TicketingPage"
    >
      <p className="ticketing:text-sm ticketing:font-bold ticketing:uppercase ticketing:tracking-normal ticketing:text-stone-500">
        {t('ticketing.pages.ticketing.eyebrow')}
      </p>
      <h2 className="ticketing:mt-2 ticketing:text-2xl ticketing:font-black">
        {t('ticketing.pages.ticketing.title')}
      </h2>
      <p className="ticketing:mt-2 ticketing:text-stone-600">
        {t('ticketing.pages.ticketing.body')}
      </p>
    </section>
  );
}
