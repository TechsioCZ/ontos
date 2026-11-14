// @rstest-environment node
import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { NESTED_LIST_LIMIT, paginateReadResult, ReadPathError, selectPath } from '../../../api/mcp/read-shaping.ts';

describe('MCP read shaping', () => {
  it('pages outer lists from the offset but starts nested lists at zero with their own cap', () => {
    const rows = Array.from({ length: 9 }, (_, id) => ({
      id,
      readings: Array.from({ length: 8 }, (_reading, index) => index),
    }));
    const result = paginateReadResult(rows, { basePath: 'module.rows', limit: 6, offset: 2 });

    expect(result.data).toEqual(
      rows.slice(2, 8).map((row) => ({ ...row, readings: row.readings.slice(0, NESTED_LIST_LIMIT) })),
    );
    expect(result.truncated).toEqual([
      { offset: 2, path: 'module.rows', returned: 6, total: 9 },
      { offset: 0, path: 'module.rows[].readings', returned: 5, total: 8 },
    ]);
    expect(result.omitted).toEqual([]);
    expect(rows[2]?.readings).toHaveLength(8);
  });

  it('reports the original list count and index when omitting a paged nested list', () => {
    const rows = [
      { id: 'skipped', readings: ['short'] },
      { id: 'kept', readings: Array.from({ length: 9 }, () => 'x'.repeat(80)) },
    ];
    const before = JSON.stringify(rows);
    const result = paginateReadResult(rows, { basePath: ' rows ', budget: 300, limit: 6, offset: 1 });

    expect(result.data).toEqual([{ id: 'kept', readings: { _omitted: 'list', count: 9, path: 'rows[1].readings' } }]);
    expect(result.omitted).toEqual([{ count: 9, kind: 'list', path: 'rows[1].readings' }]);
    expect(result.truncated).toContainEqual({ offset: 1, path: 'rows', returned: 1, total: 2 });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('counts object keys and supplies drill-down keys when an object must be omitted', () => {
    const record = { a: 'a'.repeat(80), b: 'b'.repeat(80), c: 'c'.repeat(80) };
    const result = paginateReadResult({ record }, { basePath: 'module', budget: 200, limit: 25, offset: 0 });

    expect(result.data).toEqual({
      record: { _omitted: 'object', count: 3, keys: ['a', 'b', 'c'], path: 'module.record' },
    });
    expect(result.omitted).toEqual([{ count: 3, kind: 'object', path: 'module.record' }]);
    expect(record.a).toBe('a'.repeat(80));
  });

  it('never mutates frozen children at or beyond the walk depth while shrinking', () => {
    const child = Object.freeze({ text: 'x'.repeat(1000) });
    for (const depth of [24, 25]) {
      let input: Schema.Json = child;
      for (let index = 0; index < depth; index += 1) {
        input = Object.freeze({ child: input });
      }
      const before = JSON.stringify(input);
      const result = paginateReadResult(input, { budget: 500, limit: 25, offset: 0 });

      expect(JSON.stringify(input)).toBe(before);
      expect(child.text).toBe('x'.repeat(1000));
      expect(JSON.stringify(result.data).length).toBeLessThan(before.length);
    }
  });

  it('preserves own JSON keys without changing the cloned object prototype', () => {
    const input = Result.getOrThrow(
      Schema.decodeUnknownResult(Schema.fromJsonString(Schema.JsonObject))(
        '{"__proto__":{"label":"retained"},"constructor":{"label":"also retained"}}',
      ),
    );
    const result = paginateReadResult(input, { limit: 25, offset: 0 });

    expect(result.data).toEqual(input);
    expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
    expect(selectPath(result.data, '__proto__.label')).toEqual(Result.succeed('retained'));
    expect(selectPath(result.data, 'constructor.label')).toEqual(Result.succeed('also retained'));
  });

  it('resolves equivalent bracket and dot paths, including whitespace and the root', () => {
    const input = { orders: [{ lines: [{ title: 'První' }, { title: 'Druhý' }] }] };

    for (const path of ['orders[0].lines[1].title', 'orders.0.lines.1.title', ' orders . 0 . lines . 1 . title ']) {
      expect(selectPath(input, path)).toEqual(Result.succeed('Druhý'));
    }
    expect(selectPath(input, '')).toEqual(Result.succeed(input));
    expect(selectPath({ nullable: null }, 'nullable')).toEqual(Result.succeed(null));
  });

  it('returns a Czech missing-path error with the parent and available keys or indexes', () => {
    expect(selectPath({ orders: [{ title: 'První' }] }, 'orders[0].missing')).toEqual(
      Result.fail(
        new ReadPathError({
          message:
            'Cesta „orders[0].missing“ ve výsledku neexistuje (chybí „missing“ pod „orders.0“). Dostupné: title.',
        }),
      ),
    );
    expect(selectPath({ orders: ['První'] }, 'orders[2]')).toEqual(
      Result.fail(
        new ReadPathError({
          message: 'Cesta „orders[2]“ ve výsledku neexistuje (chybí „2“ pod „orders“). Dostupné: indexy 0–0.',
        }),
      ),
    );
  });
});
