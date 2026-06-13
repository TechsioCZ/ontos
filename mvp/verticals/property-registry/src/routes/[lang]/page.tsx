import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { useEffect, useState } from 'react';
import {
  Effect,
  listPropertyRegistry,
  runEffectRequest,
} from '../../effect/property-registry-client';
import PropertyUnitCard from '../../components/property-unit-card';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { propertyRegistryBoundaryMarker } from '../../boundary-marker';

const supportedLanguages = ['en', 'cs'] as const;
const propertyRegistryTenantModuleState = {
  state: 'active',
} as const;

export default function PropertyRegistryHome() {
  const { i18nInstance, language } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const [effectApiStatus, setEffectApiStatus] = useState('pending');
  const day3PlaceholderTitle = 'Unit creation success path';

  useEffect(() => {
    let cancelled = false;
    void runEffectRequest(
      listPropertyRegistry({ limit: 1 }).pipe(
        Effect.match({
          onFailure: () => {
            if (cancelled) {
              return;
            }
            setEffectApiStatus('unavailable');
          },
          onSuccess: (data) => {
            if (cancelled) {
              return;
            }
            setEffectApiStatus(data.items.at(0)?.title ?? 'empty');
          },
        }),
      ),
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="propertyregistry:min-h-screen propertyregistry:bg-um-canvas propertyregistry:px-4 propertyregistry:py-6 propertyregistry:text-um-foreground propertyregistry:sm:px-8">
      <UltramodernRouteHead />
      <nav
        aria-label={t('property-registry.language.switcher')}
        className="propertyregistry:flex propertyregistry:gap-3"
      >
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="propertyregistry:rounded-full propertyregistry:border propertyregistry:border-stone-900/15 propertyregistry:bg-white propertyregistry:px-4 propertyregistry:py-2 propertyregistry:text-sm propertyregistry:font-bold propertyregistry:text-stone-950 propertyregistry:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`property-registry.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="propertyregistry:mt-10 propertyregistry:text-5xl propertyregistry:font-black">
        {t('property-registry.title')}
      </h1>
      <p
        className="propertyregistry:mt-3 propertyregistry:text-lg propertyregistry:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('property-registry.role')}
      </p>
      <p
        className="propertyregistry:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <section
        className="propertyregistry:mt-8 propertyregistry:grid propertyregistry:gap-4 propertyregistry:lg:grid-cols-[minmax(0,1fr)_24rem]"
        data-ontos-active-boundary={propertyRegistryBoundaryMarker}
        data-ontos-module-id="property.registry"
      >
        <div className="propertyregistry:rounded-lg propertyregistry:border propertyregistry:border-stone-900/10 propertyregistry:bg-white propertyregistry:p-5">
          <h2 className="propertyregistry:text-xl propertyregistry:font-black">
            Property Registry boundary
          </h2>
          <dl className="propertyregistry:mt-4 propertyregistry:grid propertyregistry:gap-3 propertyregistry:text-sm propertyregistry:sm:grid-cols-2">
            <div>
              <dt className="propertyregistry:font-bold propertyregistry:text-stone-500">
                Semantic module ID
              </dt>
              <dd className="propertyregistry:mt-1 propertyregistry:text-stone-900">
                property.registry
              </dd>
            </div>
            <div>
              <dt className="propertyregistry:font-bold propertyregistry:text-stone-500">
                Filesystem folder
              </dt>
              <dd className="propertyregistry:mt-1 propertyregistry:text-stone-900">
                property-registry
              </dd>
            </div>
            <div>
              <dt className="propertyregistry:font-bold propertyregistry:text-stone-500">
                Tenant module state
              </dt>
              <dd className="propertyregistry:mt-1 propertyregistry:text-stone-900">
                {propertyRegistryTenantModuleState.state}
              </dd>
            </div>
            <div>
              <dt className="propertyregistry:font-bold propertyregistry:text-stone-500">
                Owned by / renders from
              </dt>
              <dd className="propertyregistry:mt-1 propertyregistry:text-stone-900">
                property.registry
              </dd>
            </div>
          </dl>
          <p
            className="propertyregistry:mt-4 propertyregistry:text-sm propertyregistry:font-bold propertyregistry:text-stone-600"
            data-testid="effect-bff-status"
          >
            Effect BFF fixture: {effectApiStatus}
          </p>
        </div>
        <PropertyUnitCard
          floorLabel="Day 3 placeholder"
          occupancyState="unknown"
          title={day3PlaceholderTitle}
          unitId="property.unit.day3.placeholder"
        />
      </section>
    </main>
  );
}
