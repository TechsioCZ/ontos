// Page frame shared by all Facility operations pages (owned by ops-scaffold).
import { EmptyState, Toaster } from '@app/admin-ui';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import type { ReactNode } from 'react';
import { facilityOperationsI18nResources } from '../i18n/resources.ts';
import { LoadingSkeleton } from './loading-skeleton.tsx';
import type { LoadStatus } from './use-agenda.ts';
import '../routes/index.css';

/** i18n boundary + one Toaster per page tree (the shell mounts none, ui-kit's toast store is per remote). */
export const AgendaFrame = ({ children }: { readonly children: ReactNode }) => (
  <FederatedI18nBoundary
    defaultNamespace="facility-operations"
    fallbackLanguage="en"
    resources={facilityOperationsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <Toaster />
    <style>{`
      [data-scope="toast"][data-part="root"][data-type="info"] {
        background: #eff6ff !important;
        border-color: #bfdbfe !important;
        color: #1e3a8a !important;
      }
      [data-scope="toast"][data-part="root"][data-type="info"] * { color: #1e3a8a !important; }
    `}</style>
    <div className="flex flex-col gap-300">{children}</div>
  </FederatedI18nBoundary>
);

/** Pending (skeleton) / forbidden / error gate. Renders children only when data is ready. */
export const AgendaGate = ({
  children,
  onRetry,
  readable,
  status,
}: {
  readonly children: ReactNode;
  readonly onRetry: () => void;
  /** `false` when the server returned no state for this agenda (no read permission). */
  readonly readable: boolean;
  readonly status: LoadStatus;
}) => {
  const { t } = useModernI18n();
  if (status === 'loading') {
    return <LoadingSkeleton rows={5} />;
  }
  if (status === 'forbidden' || (status === 'ready' && !readable)) {
    return (
      <EmptyState
        description={t('facility-operations.common.states.forbiddenDescription')}
        title={t('facility-operations.common.states.forbiddenTitle')}
      />
    );
  }
  if (status === 'error') {
    return (
      <EmptyState
        action={
          <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
            {t('facility-operations.common.retry')}
          </Button>
        }
        description={t('facility-operations.common.states.errorDescription')}
        title={t('facility-operations.common.states.errorTitle')}
      />
    );
  }
  return <>{children}</>;
};
