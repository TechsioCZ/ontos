import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { FailureReason } from './products-api.ts';

const KEY_PREFIX = 'merchandise.pages.products';

/** Translates a key under the products namespace. */
export const useProductLabel = () => {
  const { t } = useModernI18n();
  return (path: string, values?: Record<string, number | string>) => t(`${KEY_PREFIX}.${path}`, values);
};
export type ProductLabel = ReturnType<typeof useProductLabel>;

/** Failure text for a refused command. Conflicts also ask the page to reload. */
export const useCommandFailure = () => {
  const label = useProductLabel();
  return (reason: FailureReason, onReload: () => void): string => {
    if (reason === 'conflict') {
      onReload();
      return label('messages.conflict');
    }
    if (reason === 'rejected') {
      return label('messages.rejected');
    }
    return label('messages.failed');
  };
};
