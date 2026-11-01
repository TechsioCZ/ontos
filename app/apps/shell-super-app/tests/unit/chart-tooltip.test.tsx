// The shared chart tooltip (the patched ui-kit Chart every vertical uses): a human title and series rows, never the
// raw `x` / `y` field names, with locale formatting and keyboard access.
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

const kc = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', maximumFractionDigits: 0, style: 'currency' });
const RAW_KEYS = /\b(?:label|value|count|month|period|consumption|series|state|key)\b/u;

afterEach(() => {
  cleanup();
});

const chartSurface = (container: HTMLElement): SVGSVGElement => {
  const svg = container.querySelector<SVGSVGElement>('svg.ts-chart');
  if (svg === null) {
    throw new Error('Chart did not render its SVG surface');
  }
  return svg;
};

const visibleTooltip = (container: HTMLElement): HTMLElement => {
  const tooltip = container.querySelector<HTMLElement>('.ts-chart-tooltip');
  if (tooltip === null || tooltip.hasAttribute('hidden') || (tooltip.textContent ?? '') === '') {
    throw new Error('Tooltip is not visible yet');
  }
  return tooltip;
};

/** Keyboard users reach the data like pointer users: focusing the chart selects a point, arrows move it. */
const tooltipOf = (container: HTMLElement) =>
  Effect.gen(function* openTooltipByKeyboard() {
    const svg = chartSurface(container);
    fireEvent.focus(svg);
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    return yield* Effect.promise(() => waitFor(() => visibleTooltip(container)));
  });

const rowLabel = (row: Element): string => row.querySelector('span:nth-child(2)')?.textContent ?? '';

it.live('titles a single-series tooltip with the category and names the row in Czech', () =>
  Effect.gen(function* chartTooltipCase() {
    const { container } = render(
      <Chart
        ariaLabel="Tržby z faktur"
        data={[
          { label: '19. 4. 2026', value: 120_500 },
          { label: '20. 4. 2026', value: 614_027 },
        ]}
        formatValue={(value) => kc.format(value)}
        height={260}
        initialWidth={640}
        locale="cs-CZ"
        type="bar"
        valueLabel="Tržby"
        x="label"
        y="value"
      />,
    );
    const tooltip = yield* tooltipOf(container);
    expect(tooltip.querySelector('.ts-chart-tooltip__title')?.textContent).toBe('20. 4. 2026');
    const row = tooltip.querySelector('.ts-chart-tooltip__row');
    expect(row?.textContent).toContain('Tržby');
    expect(row?.textContent).toContain(kc.format(614_027));
    expect(row?.querySelector('.ts-chart-tooltip__swatch')).not.toBeNull();
    expect(tooltip.textContent).not.toMatch(RAW_KEYS);
    expect(tooltip.classList.contains('chart-tooltip')).toBe(true);
  }),
);

it.live('formats dates and numbers for the locale when the caller passes no formatter', () =>
  Effect.gen(function* chartTooltipCase() {
    const { container } = render(
      <Chart
        ariaLabel="Počet objednávek"
        data={[
          { day: new Date('2026-04-19T00:00:00Z'), orders: 1200 },
          { day: new Date('2026-04-20T00:00:00Z'), orders: 3456 },
        ]}
        height={260}
        initialWidth={640}
        locale="cs-CZ"
        points
        type="line"
        valueLabel="Počet objednávek"
        x="day"
        y="orders"
      />,
    );
    const tooltip = yield* tooltipOf(container);
    expect(tooltip.textContent).toContain('20. 4. 2026');
    expect(tooltip.textContent).toContain('3\u00A0456');
    expect(tooltip.textContent).not.toMatch(/\b(?:day|orders)\b/u);
  }),
);

it.live('lists every series of a stacked column with its swatch and translated series name', () =>
  Effect.gen(function* chartTooltipCase() {
    const { container } = render(
      <Chart
        ariaLabel="Příjmy a výdaje"
        data={[
          { label: 'led 26', series: 'Příjmy uhrazené', value: 1000 },
          { label: 'led 26', series: 'Výdaje uhrazené', value: 400 },
          { label: 'úno 26', series: 'Příjmy uhrazené', value: 2000 },
          { label: 'úno 26', series: 'Výdaje uhrazené', value: 800 },
        ]}
        formatValue={(value) => kc.format(value)}
        height={260}
        initialWidth={640}
        locale="cs-CZ"
        series="series"
        stacked
        type="bar"
        x="label"
        y="value"
      />,
    );
    const tooltip = yield* tooltipOf(container);
    const title = tooltip.querySelector('.ts-chart-tooltip__title')?.textContent;
    expect(['led 26', 'úno 26']).toContain(title);
    const rows = [...tooltip.querySelectorAll('.ts-chart-tooltip__row')];
    expect(rows.map(rowLabel).toSorted((left, right) => left.localeCompare(right, 'cs'))).toEqual([
      'Příjmy uhrazené',
      'Výdaje uhrazené',
    ]);
    expect(rows.every((row) => row.querySelector('.ts-chart-tooltip__swatch') !== null)).toBe(true);
    expect(tooltip.textContent).not.toMatch(RAW_KEYS);
  }),
);

it.live('uses English formatting in the English locale', () =>
  Effect.gen(function* chartTooltipCase() {
    const { container } = render(
      <Chart
        ariaLabel="Orders"
        data={[{ day: new Date('2026-04-20T00:00:00Z'), orders: 3456 }]}
        height={260}
        initialWidth={640}
        locale="en-GB"
        type="bar"
        valueLabel="Orders"
        x="day"
        y="orders"
      />,
    );
    const tooltip = yield* tooltipOf(container);
    expect(tooltip.textContent).toContain('20 Apr 2026');
    expect(tooltip.textContent).toContain('3,456');
    expect(tooltip.textContent).toContain('Orders');
  }),
);
