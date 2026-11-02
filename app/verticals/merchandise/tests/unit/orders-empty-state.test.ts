import { readFileSync } from 'node:fs';
import { expect, it } from 'effect-rstest';

const source = readFileSync(new URL('../../src/routes/[lang]/prodej/objednavky/page.tsx', import.meta.url), 'utf-8');

// These are source-layout guards. The phone/tablet browser check proves the actual geometry.
it('sizes order empty content against the visible table container, not its wide columns', () => {
  expect(source).toMatch(/<DataTable\s+className="@container"/u);
  expect(source).toMatch(
    /renderEmpty=\{\(\) =>\s*<div className="sticky start-0 w-\[100cqi\] max-w-full">\{renderOrdersEmpty\(model\)\}<\/div>\}/u,
  );
});

it('keeps error, denied, filtered and first-order states inside the same viewport wrapper', () => {
  const start = source.indexOf('const renderOrdersEmpty =');
  const end = source.indexOf('const OrdersPageContent =', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const states = source.slice(start, end);
  for (const key of ['states.errorTitle', 'states.forbiddenTitle', 'states.filteredTitle', 'states.firstTitle']) {
    expect(states).toContain(key);
  }
  expect(states).toContain('onClick={load}');
  expect(states).toContain('tagFilter.setTagId(null)');
  expect(states).toContain('canEditOrders ?');
  expect(states).toContain('setCreateOpen(true)');
});

it('preserves horizontal navigation, pinned columns and loading rows for populated tables', () => {
  expect(source).toContain("columnPinning={{ end: [], start: ['__select', 'number'] }}");
  expect(source).toContain("loading={isTableLoading(state.kind === 'loading' || stale, tagFilter.status)}");
  expect(source).toContain('enableColumnPinning');
  expect(source).toContain('tableLayout="fixed"');
});
