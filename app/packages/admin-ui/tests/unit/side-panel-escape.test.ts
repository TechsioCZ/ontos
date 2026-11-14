import { describe, expect, it } from 'effect-rstest';
import { isPanelEscape, panelContentId, readEscapeSnapshot } from '../../src/side-panel-escape.ts';
import type { EscapeQueryRoot } from '../../src/side-panel-escape.ts';

const PANEL = panelContentId('panel');

const rootWith = (openDialogIds: readonly string[], openPopupScopes: readonly string[]): EscapeQueryRoot => ({
  querySelectorAll: (selectors) =>
    selectors.includes('[data-scope="dialog"]')
      ? openDialogIds.map((id) => ({ id }))
      : openPopupScopes
          .filter((scope) => selectors.includes(`[data-scope="${scope}"]`))
          .map((scope) => ({ id: `${scope}:content` })),
});

const escapeKey = { isComposing: false, key: 'Escape' };

describe('side panel Escape', () => {
  it('uses the zag dialog content id', () => {
    expect(panelContentId('abc')).toBe('dialog:abc:content');
  });

  it('closes the top-most panel when nothing is layered above it', () => {
    const snapshot = readEscapeSnapshot(escapeKey, rootWith([PANEL], []));
    expect(snapshot).toEqual({ isComposing: false, key: 'Escape', openPopups: 0, topmostDialogContentId: PANEL });
    expect(isPanelEscape(snapshot, PANEL)).toBe(true);
  });

  it('leaves the first Escape to an open listbox, calendar or menu', () => {
    for (const scope of ['select', 'combobox', 'date-picker', 'menu']) {
      expect(isPanelEscape(readEscapeSnapshot(escapeKey, rootWith([PANEL], [scope])), PANEL)).toBe(false);
    }
  });

  it('ignores open content of non-popup scopes', () => {
    expect(isPanelEscape(readEscapeSnapshot(escapeKey, rootWith([PANEL], ['collapsible'])), PANEL)).toBe(true);
  });

  it('leaves Escape to a dialog opened above the panel', () => {
    const nested = panelContentId('confirm');
    expect(isPanelEscape(readEscapeSnapshot(escapeKey, rootWith([PANEL, nested], [])), PANEL)).toBe(false);
    expect(isPanelEscape(readEscapeSnapshot(escapeKey, rootWith([PANEL, nested], [])), nested)).toBe(true);
  });

  it('ignores other keys, IME composition and a closed panel', () => {
    expect(isPanelEscape(readEscapeSnapshot({ isComposing: false, key: 'Enter' }, rootWith([PANEL], [])), PANEL)).toBe(
      false,
    );
    expect(isPanelEscape(readEscapeSnapshot({ isComposing: true, key: 'Escape' }, rootWith([PANEL], [])), PANEL)).toBe(
      false,
    );
    expect(isPanelEscape(readEscapeSnapshot(escapeKey, rootWith([], [])), PANEL)).toBe(false);
  });
});
