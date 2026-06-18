import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { ReadUnitsButton } from '../../../../components/read-units-button';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';

export default function PropertiesUnitsPage() {
  const { language } = useModernI18n();

  return (
    <main className="properties:min-h-screen properties:bg-um-canvas properties:px-4 properties:py-6 properties:text-um-foreground properties:sm:px-8">
      <UltramodernRouteHead />
      <Link
        className="properties:inline-flex properties:rounded-full properties:border properties:border-stone-900/15 properties:bg-white properties:px-4 properties:py-2 properties:text-sm properties:font-bold properties:text-stone-950 properties:no-underline"
        params={{ lang: language }}
        to="/$lang"
      >
        Back to Properties
      </Link>
      <h1 className="properties:mt-10 properties:text-4xl properties:font-black">
        Property Units
      </h1>
      <p className="properties:mt-3 properties:max-w-2xl properties:text-lg properties:text-stone-600">
        Read all units through the properties CoreSDK action flow.
      </p>
      <div className="properties:mt-6">
        <ReadUnitsButton />
      </div>
    </main>
  );
}
