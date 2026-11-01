import { describe, expect, it, rs } from 'effect-rstest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutosaveStatus } from '../../src/autosave-status.tsx';
import type { AutosaveState } from '../../src/autosave.ts';

const markup = (status: AutosaveState) =>
  renderToStaticMarkup(
    <AutosaveStatus onReloadLatest={rs.fn<() => void>()} onRetry={rs.fn<() => void>()} status={status} />,
  );

const text = (status: AutosaveState) =>
  markup(status)
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();

describe('AutosaveStatus', () => {
  it('announces every state politely and stays quiet while nothing is pending', () => {
    expect(markup('idle')).toContain('aria-live="polite"');
    expect(text('idle')).toBe('');
    expect(text('dirty')).toBe('');
    expect(text('saving')).toBe('Ukládám…');
    expect(text('saved')).toBe('Uloženo');
    expect(text('invalid')).toBe('Neuloženo – opravte zvýrazněná pole');
  });

  it('offers retry only after a failed save', () => {
    expect(text('error')).toBe('Chyba – zkusit znovu');
    expect(markup('error')).toContain('<button');
    for (const status of ['idle', 'dirty', 'saving', 'saved', 'invalid'] as const) {
      expect(markup(status)).not.toContain('<button');
    }
  });

  it('offers the latest version only on a conflict', () => {
    expect(text('conflict')).toBe('Záznam mezitím změnil někdo jiný. Načíst aktuální verzi');
    expect(markup('conflict')).toContain('<button');
  });
});
