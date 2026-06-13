import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

export default function PropertyRegistryRoute() {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);

  return (
    <section
      className="propertyregistry:rounded-2xl propertyregistry:bg-white/90 propertyregistry:p-5 propertyregistry:shadow-xl propertyregistry:shadow-stone-900/10"
      data-modern-boundary-id="verticalPropertyRegistry"
      data-modern-mf-expose="./Route"
    >
      <h2 className="propertyregistry:text-2xl propertyregistry:font-black">
        {t('property-registry.title')}
      </h2>
      <p className="propertyregistry:mt-2 propertyregistry:text-stone-600">
        {t('property-registry.routeSurface')}
      </p>
    </section>
  );
}
