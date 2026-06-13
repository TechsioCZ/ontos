import ShellFrame from '../shell-frame';
import { UltramodernRouteHead } from '../ultramodern-route-head';
import { VerticalShowcase } from '../vertical-components';
import { ultramodernUiMarker } from '../../ultramodern-build';

export default function ShellHome() {
  return (
    <ShellFrame>
      <UltramodernRouteHead />
      <section className="shell:mx-auto shell:mt-6 shell:grid shell:max-w-7xl shell:gap-3 shell:border-b shell:border-stone-900/10 shell:pb-5">
        <p className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
          Shell SuperApp
        </p>
        <div className="shell:flex shell:flex-wrap shell:items-end shell:justify-between shell:gap-4">
          <div>
            <h1 className="shell:text-3xl shell:font-black shell:tracking-normal shell:text-stone-950">
              OntOS Day 1-3 MVP
            </h1>
            <p className="shell:mt-2 shell:max-w-3xl shell:text-sm shell:font-semibold shell:leading-6 shell:text-stone-600">
              Installed MicroVertical registry, Module Federation composition, and Day 3 runtime
              gate probes.
            </p>
          </div>
          <p className="shell:rounded-md shell:bg-stone-950 shell:px-3 shell:py-2 shell:text-sm shell:font-bold shell:text-white">
            presetUltramodern .120
          </p>
        </div>
      </section>
      <VerticalShowcase />
      <p className="shell:sr-only" data-testid="ultramodern-preset">
        presetUltramodern workspace
      </p>
      <p
        className="shell:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </ShellFrame>
  );
}
