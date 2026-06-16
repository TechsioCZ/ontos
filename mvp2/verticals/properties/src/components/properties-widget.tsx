import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CreateUnitButton } from './create-unit-button';

export default function PropertiesWidget() {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);

  return (
    <section
      className="properties:rounded-2xl properties:bg-white/90 properties:p-5 properties:shadow-xl properties:shadow-stone-900/10"
      data-modern-boundary-id="verticalProperties"
      data-modern-mf-expose="./Widget"
    >
      <h2 className="properties:text-2xl properties:font-black">{t('properties.title')}</h2>
      <p className="properties:mt-2 properties:text-stone-600">{t('properties.widgetBody')}</p>
      <div className="properties:mt-4">
        <CreateUnitButton />
      </div>
    </section>
  );
}
