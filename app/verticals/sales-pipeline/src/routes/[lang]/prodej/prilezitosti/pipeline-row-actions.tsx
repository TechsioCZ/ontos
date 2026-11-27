import { Button } from '@techsio/ui-kit/atoms/button';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import type { IconType } from '@techsio/ui-kit/atoms/icon';
import { useSyncExternalStore } from 'react';

/** The shape of ui-kit's `DataTableRowAction`, over any row value, so the menu reuses the table's own action list. */
export interface RowAction<R> {
  readonly disabled?: (row: R) => boolean;
  readonly hidden?: (row: R) => boolean;
  readonly icon: IconType;
  readonly id: string;
  readonly label: string;
  readonly onAction: (row: R) => void;
}

// On a phone five icon buttons in the sticky Akce column leave the pinned Název only a few characters, so below this
// width the row actions collapse into one menu button.
const narrowViewportQuery = '(max-width: 39.99rem)';
const subscribeNarrowViewport = (onChange: () => void) => {
  const query = globalThis.matchMedia(narrowViewportQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

export const useNarrowViewport = () =>
  useSyncExternalStore(
    subscribeNarrowViewport,
    () => globalThis.matchMedia(narrowViewportQuery).matches,
    // The server render keeps the icon buttons; the first client render corrects it.
    () => false,
  );

/** A single action stays an icon button; a menu only pays off once several icons would crowd out the title. */
export const collapseRowActions = (narrow: boolean, actions: readonly unknown[]): boolean =>
  narrow && actions.length > 1;

/** The same actions, availability and labels as the icon buttons, as menu items. */
export const rowActionMenuItems = <R,>(actions: readonly RowAction<R>[], row: R): MenuItem[] =>
  actions.flatMap((action): MenuItem[] =>
    action.hidden?.(row) === true
      ? []
      : [
          {
            disabled: action.disabled?.(row) === true,
            icon: action.icon,
            label: action.label,
            type: 'action',
            value: action.id,
          },
        ],
  );

/** Runs the chosen action unless it is hidden or blocked for this row. */
export const runRowAction = <R,>(actions: readonly RowAction<R>[], row: R, value: string): void => {
  const action = actions.find((candidate) => candidate.id === value);
  if (action === undefined || action.hidden?.(row) === true || action.disabled?.(row) === true) {
    return;
  }
  action.onAction(row);
};

/** Menu clicks stop here so choosing an action does not also open the opportunity detail. */
const stopRowInteraction = (event: { stopPropagation: () => void }) => event.stopPropagation();

interface RowActionsMenuProps<R> {
  readonly actions: readonly RowAction<R>[];
  /** Names the row, e.g. `Akce: Servis tiskáren`, so a screen reader knows which opportunity the menu acts on. */
  readonly label: string;
  readonly row: R;
}

export const RowActionsMenu = <R,>({ actions, label, row }: RowActionsMenuProps<R>) => (
  <div aria-label={label} onClick={stopRowInteraction} onKeyDown={stopRowInteraction} role="toolbar" tabIndex={-1}>
    <Menu
      aria-label={label}
      customTrigger={
        <Button aria-label={label} icon="icon-[mdi--dots-vertical]" size="sm" theme="borderless" variant="secondary" />
      }
      items={rowActionMenuItems(actions, row)}
      onSelect={({ value }) => runRowAction(actions, row, value)}
      size="sm"
    />
  </div>
);
