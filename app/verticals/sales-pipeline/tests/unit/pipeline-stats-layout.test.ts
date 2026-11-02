import { readFileSync } from 'node:fs';
import { StatCard } from '@app/admin-ui';
import { beforeAll, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PipelineStatsGrid } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-filters.tsx';

const classesOf = (html: string): string[][] =>
  html
    .split('class="')
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('"')).split(' '));

describe('opportunity KPI grid width', () => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  beforeAll(() => {
    rstest.stubGlobal('React', React);
  });

  it('sizes its columns from the content width, so the open demo guide does not squeeze four amounts side by side', () => {
    const html = renderToStaticMarkup(
      createElement(
        PipelineStatsGrid,
        null,
        createElement(StatCard, { hint: '3 příležitosti', label: 'Otevřené', value: '1 260 000 Kč' }),
        createElement(StatCard, { label: 'Vážená hodnota', value: '444 900 Kč' }),
      ),
    );
    const [container, grid] = classesOf(html);
    expect(container).toEqual(['@container']);
    // One column on phones (390 px), two at roughly half of a 1440 px screen, four only on wide content.
    expect(grid).toEqual(
      expect.arrayContaining(['grid', 'grid-cols-1', '@min-[36rem]:grid-cols-2', '@min-[64rem]:grid-cols-4']),
    );
    expect(grid?.some((name) => /^(?:sm|md|lg|xl|2xl):grid-cols-/u.test(name))).toBe(false);
    // Same cards and values as before: only the grid changed.
    expect(html).toContain('1 260 000 Kč');
    expect(html).toContain('444 900 Kč');
    expect(html).toContain('3 příležitosti');
  });

  it('renders the opportunity KPIs inside that grid', () => {
    const source = readFileSync(
      new URL('../../src/routes/[lang]/prodej/prilezitosti/pipeline-filters.tsx', import.meta.url),
      'utf-8',
    );
    expect(source).toContain('<PipelineStatsGrid>');
    expect(source).not.toContain('<StatRow>');
  });
});
