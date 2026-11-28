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
    <div aria-busy="true" className="flex w-full flex-col gap-6" data-module-page-skeleton="">
      <span className="sr-only">{t('shell.moduleTarget.loading')}</span>
      <Skeleton aria-hidden="true" className="flex w-full flex-col gap-6" isLoaded={false}>
        <div className="flex flex-col gap-2">
          <Skeleton.Rectangle className="h-8 w-64 max-w-full" />
          <Skeleton.Rectangle className="h-4 w-96 max-w-full" />
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {STAT_TILES.map((tile) => (
            <Skeleton.Rectangle className="h-24 w-full" key={tile} />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {TABLE_ROWS.map((row) => (
            <Skeleton.Rectangle className="h-10 w-full" key={row} />
          ))}
        </div>
      </Skeleton>
    </div>
  );
};
