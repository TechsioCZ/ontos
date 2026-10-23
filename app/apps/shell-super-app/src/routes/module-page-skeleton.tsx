import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';

const STAT_TILES = ['first', 'second', 'third', 'fourth'] as const;
const TABLE_ROWS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'] as const;

/**
 * The one placeholder of a module page that is not ready yet: the shape of a typical page (header, four stat tiles,
 * a table) without any text. It renders the same markup on the server and at hydration, and the page replaces it
 * once its code and primary data are ready.
 */
export const ModulePageSkeleton = () => {
  const { t } = useModernI18n();
  return (
    <div aria-busy="true" className="shell:flex shell:w-full shell:flex-col shell:gap-6" data-module-page-skeleton="">
      <span className="shell:sr-only">{t('shell.moduleTarget.loading')}</span>
      <Skeleton aria-hidden="true" className="shell:flex shell:w-full shell:flex-col shell:gap-6" isLoaded={false}>
        <div className="shell:flex shell:flex-col shell:gap-2">
          <Skeleton.Rectangle className="shell:h-8 shell:w-64 shell:max-w-full" />
          <Skeleton.Rectangle className="shell:h-4 shell:w-96 shell:max-w-full" />
        </div>
        <div className="shell:grid shell:grid-cols-2 shell:gap-4 shell:lg:grid-cols-4">
          {STAT_TILES.map((tile) => (
            <Skeleton.Rectangle className="shell:h-24 shell:w-full" key={tile} />
          ))}
        </div>
        <div className="shell:flex shell:flex-col shell:gap-2">
          {TABLE_ROWS.map((row) => (
            <Skeleton.Rectangle className="shell:h-10 shell:w-full" key={row} />
          ))}
        </div>
      </Skeleton>
    </div>
  );
};
