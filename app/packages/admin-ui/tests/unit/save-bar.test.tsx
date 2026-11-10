import { describe, expect, it, rs } from 'effect-rstest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SaveBar } from '../../src/save-bar.tsx';
import { saveLabelsFor } from '../../src/save-labels.ts';
import type { SaveState } from '../../src/draft-save.ts';

const states = ['idle', 'dirty', 'invalid', 'saving', 'saved', 'proposed', 'error', 'conflict'] as const;

const markup = (status: SaveState, language?: string, error?: string) =>
  renderToStaticMarkup(
    <SaveBar
      error={error}
      {...(language === undefined ? {} : { labels: saveLabelsFor(language) })}
      onReloadLatest={rs.fn<() => void>()}
      onSave={rs.fn<() => void>()}
      status={status}
    />,
  );

const textOf = (html: string) =>
  html
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();

/** The opening tags of every button, in order. */
const buttons = (html: string) => html.match(/<button[^>]*>/gu) ?? [];
const saveButton = (html: string) => buttons(html).at(-1) ?? '';
/** The status line: everything the polite live region says. */
const disabled = (status: SaveState) => / disabled=""/u.test(saveButton(markup(status)));
const statusOf = (html: string) =>
  textOf(/aria-live="polite"[^>]*>(?<status>.*)<\/div><button/u.exec(html)?.groups?.['status'] ?? '');

describe('SaveBar', () => {
  it('renders exactly one Save button in every state, as the last control', () => {
    for (const status of states) {
      const html = markup(status);
      expect(html.match(/Uložit|Ukládám…/gu)).toHaveLength(1);
      expect(saveButton(html)).toContain('type="button"');
      expect(html.endsWith('</button></div>')).toBe(true);
      expect(html).toContain(`data-save-state="${status}"`);
    }
  });

  it('enables Save only for a changed, valid draft and after a failed save', () => {
    expect(disabled('dirty')).toBe(false);
    expect(disabled('error')).toBe(false);
    for (const status of ['idle', 'invalid', 'saved', 'proposed', 'conflict'] as const) {
      expect(disabled(status)).toBe(true);
    }
  });

  it('shows the loading state while the save runs', () => {
    const html = markup('saving');
    expect(saveButton(html)).toContain('aria-busy="true"');
    expect(saveButton(html)).toContain('data-loading');
    expect(textOf(html)).toBe('Ukládám…');
    for (const status of states.filter((state) => state !== 'saving')) {
      expect(saveButton(markup(status))).not.toContain('aria-busy');
    }
  });

  it('says what state the draft is in next to the button, politely', () => {
    expect(markup('idle')).toContain('aria-live="polite"');
    expect(statusOf(markup('idle'))).toBe('');
    expect(statusOf(markup('dirty'))).toBe('Neuložené změny');
    expect(statusOf(markup('invalid'))).toBe('Neuložené změny – opravte zvýrazněná pole');
    expect(statusOf(markup('saving'))).toBe('');
    expect(statusOf(markup('saved'))).toBe('Uloženo');
    expect(statusOf(markup('proposed'))).toBe('Odesláno ke schválení – změna zatím nebyla provedena');
    expect(statusOf(markup('error'))).toBe('Uložení se nezdařilo. Zkuste to znovu.');
  });

  it('shows the form’s own failure text instead of the general one', () => {
    expect(statusOf(markup('error', undefined, 'Cena nesmí být záporná.'))).toBe('Cena nesmí být záporná.');
    expect(statusOf(markup('dirty', undefined, 'Cena nesmí být záporná.'))).toBe('Neuložené změny');
  });

  it('offers the latest version only on a conflict, and never a second save control', () => {
    expect(statusOf(markup('conflict'))).toBe('Záznam mezitím změnil někdo jiný. Načíst aktuální verzi');
    expect(buttons(markup('conflict'))).toHaveLength(2);
    for (const status of states.filter((state) => state !== 'conflict')) {
      expect(buttons(markup(status))).toHaveLength(1);
    }
  });

  it('never mentions saving by itself, in any language', () => {
    for (const language of ['cs', 'sk', 'en']) {
      for (const status of states) {
        expect(markup(status, language)).not.toMatch(/automat|autosave/iu);
      }
    }
  });

  it('speaks the language the app runs in, Czech by default', () => {
    expect(textOf(markup('dirty', 'en'))).toBe('Unsaved changes Save');
    expect(textOf(markup('dirty', 'en-GB'))).toBe('Unsaved changes Save');
    expect(textOf(markup('dirty', 'sk'))).toBe('Neuložené zmeny Uložiť');
    expect(textOf(markup('saved', 'cs'))).toBe('Uloženo Uložit');
    expect(textOf(markup('saved', 'de'))).toBe('Uloženo Uložit');
  });
});
