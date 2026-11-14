import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const PropertyLandingPage = () => {
  const { t } = useModernI18n();
  return (
    <main className="propertyportfolio:p-8">
      <UltramodernRouteHead />
      <h1>{t('property-portfolio.title')}</h1>
      <p>{t('property-portfolio.description')}</p>
    </main>
  );
};

export default PropertyLandingPage;
