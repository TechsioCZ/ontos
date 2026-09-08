import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

const widgetCount = Number('0');

export const VerticalShowcase = () => {
  const { t } = useModernI18n();

  if (widgetCount === 0) {
    return (
      <section className="shell:mx-auto shell:mt-12 shell:max-w-7xl shell:rounded-2xl shell:bg-white/90 shell:p-6 shell:shadow-xl shell:shadow-stone-900/10">
        <p className="shell:text-lg shell:font-bold shell:text-stone-700">
          {t('shell.hero.empty')}
        </p>
      </section>
    );
  }

  return (
    <section
      className="shell:mx-auto shell:mt-12 shell:max-w-7xl"
      data-modern-boundary-id="shellSuperApp"
    >
      <div className="shell:grid shell:gap-4 shell:md:grid-cols-2" />
    </section>
  );
};
