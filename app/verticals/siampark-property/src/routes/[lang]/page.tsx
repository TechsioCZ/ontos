import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const PropertyLandingPage = () => {
  const { t } = useModernI18n();
  return (
    <main className="siamparkproperty:p-8">
      <UltramodernRouteHead />
      <h1>{t('siampark-property.title')}</h1>
      <p>{t('siampark-property.description')}</p>
    </main>
  );
};

export default PropertyLandingPage;
