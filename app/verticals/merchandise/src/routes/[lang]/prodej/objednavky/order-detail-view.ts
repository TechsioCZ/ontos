import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useState } from 'react';

type Translate = ReturnType<typeof useModernI18n>['t'];

/** Title of the open order; the edit form names the order it changes. */
export const orderDetailTitle = ({
  editing,
  number,
  t,
}: {
  readonly editing: boolean;
  readonly number: string;
  readonly t: Translate;
}) =>
  editing
    ? t('merchandise.pages.orders.detail.editTitle', { number })
    : t('merchandise.pages.orders.detail.title', { number });

/**
 * Editing belongs to one order. Opening another order (in the panel or on the page) starts in read mode.
 * Returns whether the order is being edited and a setter for that state.
 */
export const useOrderEditing = (orderId: string | undefined) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = orderId !== undefined && editingId === orderId;
  const setEditing = (next: boolean) => {
    setEditingId(next && orderId !== undefined ? orderId : null);
  };
  return { editing, setEditing } as const;
};
