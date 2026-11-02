import { readFileSync } from 'node:fs';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  referenceStatusOf,
  referenceText,
  resolveReference,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-reference-labels.ts';
import type { LoadState } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-references.ts';

interface Person {
  readonly fullName: string;
}

const ownerId = '0196a8a0-0000-7000-8000-0000000000b1';
const otherId = '0196a8a0-0000-7000-8000-0000000000b2';
const people = new Map<string, Person>([[ownerId, { fullName: 'Vedení Nájempark' }]]);
const texts = { loading: '—', unavailable: 'Nedostupné', unknown: 'Neznámý obchodník' };
const label = (state: LoadState<readonly Person[]>, id: string) =>
  referenceText(
    resolveReference(state.status === 'ready' ? people : new Map<string, Person>(), referenceStatusOf(state), id),
    (person) => person.fullName,
    texts,
  );

// A module the person may not open answers the reference read with a refusal (the shell's gateway fails a denied
// audience before any request), so the read settles as an error.
const refused: LoadState<readonly Person[]> = { cause: { status: 403 }, status: 'error' };

describe('opportunity reference labels', () => {
  it('settles a refused or failed reference read as unavailable instead of a loading dash', () => {
    expect(referenceStatusOf(refused)).toBe('unavailable');
    expect(label(refused, ownerId)).toBe('Nedostupné');
    expect(label(refused, otherId)).toBe('Nedostupné');
  });

  it('keeps the dash only while the read is still running', () => {
    expect(referenceStatusOf({ status: 'loading' })).toBe('loading');
    expect(label({ status: 'loading' }, ownerId)).toBe('—');
  });

  it('names a readable reference and calls a missing one unknown only after the list loaded', () => {
    const ready: LoadState<readonly Person[]> = { items: [...people.values()], status: 'ready' };
    expect(referenceStatusOf(ready)).toBe('ready');
    expect(label(ready, ownerId)).toBe('Vedení Nájempark');
    expect(label(ready, otherId)).toBe('Neznámý obchodník');
  });

  it('never shows the technical id of an unresolved reference', () => {
    for (const state of [refused, { status: 'loading' } as const]) {
      expect(label(state, otherId)).not.toContain(otherId);
    }
  });

  it('has a Czech and an English label for an unavailable reference', () => {
    const LocaleSchema = Schema.Struct({
      'sales-pipeline': Schema.Struct({
        pages: Schema.Struct({ records: Schema.Struct({ referenceUnavailable: Schema.String }) }),
      }),
    });
    const unavailableOf = (language: string) =>
      Schema.decodeUnknownSync(Schema.fromJsonString(LocaleSchema))(
        readFileSync(new URL(`../../locales/${language}/sales-pipeline.json`, import.meta.url), 'utf-8'),
      )['sales-pipeline'].pages.records.referenceUnavailable;
    expect(unavailableOf('cs')).toBe('Nedostupné');
    expect(unavailableOf('en')).toBe('Unavailable');
  });
});
