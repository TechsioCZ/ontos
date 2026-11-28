// Shared quiet placeholder of Facility operations pages and embedded panels (owned by ops-scaffold).
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

/**
 * Quiet, text-free placeholder for data that is not ready yet. The Shell prepares a page's primary data before it
 * reveals the page, so this shows only on a cold mount it could not prepare, once, never as a chain of loading lines.
 */
export const LoadingSkeleton = ({ label, rows = 4 }: { readonly label?: string; readonly rows?: number }) => {
  const { t } = useModernI18n();
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-3">
      <span className="sr-only">{label ?? t('facility-operations.common.loading')}</span>
      {Array.from({ length: rows }, (_, row) => (
        <span
          aria-hidden="true"
          className={`block animate-pulse rounded-sm bg-skeleton-bg-primary ${row === 0 ? 'h-10' : 'h-6'} ${row % 2 === 0 ? 'w-full' : 'w-[72%]'}`}
          key={row}
        />
      ))}
    </div>
  );
};
