import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

export default function AccountingWidget() {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);

  return (
    <section
      className="accounting:rounded-2xl accounting:bg-white/90 accounting:p-5 accounting:shadow-xl accounting:shadow-stone-900/10"
      data-modern-boundary-id="verticalAccounting"
      data-modern-mf-expose="./Widget"
    >
      <h2 className="accounting:text-2xl accounting:font-black">{t('accounting.title')}</h2>
      <p className="accounting:mt-2 accounting:text-stone-600">{t('accounting.widgetBody')}</p>
    </section>
  );
}
