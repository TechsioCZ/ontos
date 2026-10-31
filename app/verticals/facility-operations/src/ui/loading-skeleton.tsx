// Shared quiet placeholder of Facility operations pages and embedded panels (owned by ops-scaffold).
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

const visuallyHidden = {
  clip: 'rect(0 0 0 0)',
  height: 1,
  margin: -1,
  overflow: 'hidden',
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: 1,
} as const;

/**
 * Quiet, text-free placeholder for data that is not ready yet. The Shell prepares a page's primary data before it
 * reveals the page, so this shows only on a cold mount it could not prepare, once, never as a chain of loading lines.
 * Inline styles keep it intact where it is embedded in another vertical without this vertical's stylesheet.
 */
export const LoadingSkeleton = ({ label, rows = 4 }: { readonly label?: string; readonly rows?: number }) => {
  const { t } = useModernI18n();
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: 0 }}>
      <span style={visuallyHidden}>{label ?? t('facility-operations.common.loading')}</span>
      {Array.from({ length: rows }, (_, row) => (
        <span
          aria-hidden="true"
          className="facilityoperations:animate-pulse"
          key={row}
          style={{
            background: 'var(--color-neutral-200, #e5e7eb)',
            borderRadius: '0.5rem',
            display: 'block',
            height: row === 0 ? '2.5rem' : '1.5rem',
            width: row % 2 === 0 ? '100%' : '72%',
          }}
        />
      ))}
    </div>
  );
};
