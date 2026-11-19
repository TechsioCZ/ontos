// @rstest-environment happy-dom
import { text, unmountAll } from '@app/admin-ui/testing/module-ui';
import { Effect, Option } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { PipelineStats } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-filters.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const czech = moduleText('cs');
afterEach(unmountAll);

it.live('shows the open and weighted opportunity values and count from the current pipeline indicators', () =>
  Effect.gen(function* visibleIndicators() {
    yield* mountInRoute(
      <PipelineStats
        indicators={{
          byStage: [],
          lostCount: 0,
          openCount: 3,
          openValueMinor: 126_000_000,
          weightedValueMinor: 44_490_000,
          winRate: Option.none(),
          wonCount: 0,
          wonValueMinor: 0,
        }}
      />,
    );
    const visible = text().replaceAll('\u00A0', ' ');
    expect(visible).toContain(czech('sales-pipeline.pages.records.stats.open'));
    expect(visible).toContain(czech('sales-pipeline.pages.records.stats.weighted'));
    expect(visible).toContain('1 260 000 Kč');
    expect(visible).toContain('444 900 Kč');
    expect(visible).toContain('3 příležitosti');
  }),
);
