/**
 * Escape decision for `SidePanel`.
 *
 * ui-kit `Dialog` closes on Escape through the zag dismissable layer stack. That stack is a module
 * singleton, and every Module Federation remote bundles its own copy of `@zag-js/*`, so the stack
 * only knows the layers of one remote. If a layer stays registered above the panel (a leaked or
 * foreign layer), the panel never sees itself as top-most and Escape does nothing. `SidePanel`
 * re-checks Escape from the DOM, which every copy shares: the panel closes when no zag popup is open
 * and it is the top-most open dialog. An open listbox, calendar or menu still takes the first Escape.
 */

/** zag scopes whose open `content` part owns Escape before the panel does. */
export const POPUP_SCOPES = [
  'cascade-select',
  'color-picker',
  'combobox',
  'date-picker',
  'hover-card',
  'menu',
  'popover',
  'select',
  'tooltip',
] as const;

const OPEN_POPUP_SELECTOR = POPUP_SCOPES.map(
  (scope) => `[data-scope="${scope}"][data-part="content"][data-state="open"]`,
).join(', ');

const OPEN_DIALOG_SELECTOR = '[data-scope="dialog"][data-part="content"][data-state="open"]';

/** DOM id zag gives the content element of the dialog machine with this id. */
export const panelContentId = (dialogId: string): string => `dialog:${dialogId}:content`;

export interface EscapeSnapshot {
  readonly isComposing: boolean;
  readonly key: string;
  /** Number of open zag popups (listbox, calendar, menu, popover, tooltip) anywhere in the document. */
  readonly openPopups: number;
  /** DOM id of the last open dialog content in document order, which is the top-most one. */
  readonly topmostDialogContentId: string | undefined;
}

/** True when this Escape belongs to the panel: nothing is layered above it and no IME is composing. */
export const isPanelEscape = (snapshot: EscapeSnapshot, contentId: string): boolean =>
  snapshot.key === 'Escape' &&
  !snapshot.isComposing &&
  snapshot.openPopups === 0 &&
  snapshot.topmostDialogContentId === contentId;

/** The part of `Document` the snapshot reads; tests pass a plain object. */
export interface EscapeQueryRoot {
  readonly querySelectorAll: (selectors: string) => Iterable<{ readonly id: string }>;
}

/** Reads the snapshot before any layer handles the key, so a popup closed by this Escape still counts. */
export const readEscapeSnapshot = (
  event: Pick<KeyboardEvent, 'isComposing' | 'key'>,
  root: EscapeQueryRoot,
): EscapeSnapshot => {
  const dialogs = [...root.querySelectorAll(OPEN_DIALOG_SELECTOR)];
  return {
    isComposing: event.isComposing,
    key: event.key,
    openPopups: [...root.querySelectorAll(OPEN_POPUP_SELECTOR)].length,
    topmostDialogContentId: dialogs.at(-1)?.id,
  };
};
