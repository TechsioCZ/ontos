import { expect, it } from 'effect-rstest';
import { subjectIdQueries } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-tags.ts';

it('keeps an empty subject list empty', () => {
  expect(subjectIdQueries([])).toEqual([]);
});

it('includes a query that exactly fills the wire limit without splitting it', () => {
  const first = 'a'.repeat(4000);
  const second = 'b'.repeat(3999);
  expect(subjectIdQueries([first, second])).toEqual([`${first},${second}`]);
});

it('starts the next query before adding an id that would exceed the wire limit', () => {
  const first = 'a'.repeat(4000);
  const second = 'b'.repeat(4000);
  expect(subjectIdQueries([first, second, 'last'])).toEqual([first, `${second},last`]);
});

it('preserves order, identities and the caller input across deterministic subject lists', () => {
  for (let size = 1; size <= 80; size += 1) {
    const ids = Array.from({ length: size * 5 }, (_, index) => `${index}:${'x'.repeat((index * 37 + size) % 511)}`);
    const original = [...ids];
    const chunks = subjectIdQueries(ids);
    expect(chunks.every((query) => query.length > 0 && query.length <= 8000)).toBe(true);
    expect(chunks.flatMap((query) => query.split(','))).toEqual(original);
    expect(ids).toEqual(original);
  }
});

it('never retains a chunk accumulator between calls', () => {
  expect(subjectIdQueries(['first'])).toEqual(['first']);
  expect(subjectIdQueries(['second'])).toEqual(['second']);
  expect(subjectIdQueries([])).toEqual([]);
});
