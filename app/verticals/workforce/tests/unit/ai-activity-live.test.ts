import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AiActivityCard } from '../../src/routes/[lang]/prodej/zamestnanci/ai-activity-card.tsx';
import { aiActivityData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';

const { records } = rstest.hoisted(() => ({ records: rstest.fn() }));

rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: records }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({ useModernI18n: () => ({ language: 'cs', t: String }) }));

beforeEach(() => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  records.mockReset();
  records.mockReturnValue(Effect.fail('offline'));
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

// The AI activity feed follows the live signal (page data), so the card offers no manual refresh.
describe('AI activity updates without a manual refresh', () => {
  it('renders no refresh button', () => {
    const html = renderToStaticMarkup(createElement(AiActivityCard, { legalEntityId: 'company-a' }));
    expect(html).toContain('aiActivity.title');
    expect(html).not.toContain('aiActivity.refresh');
    expect(html).not.toContain('<button');
  });

  it.live('showing the card loads the AI activity of the company', () =>
    Effect.gen(function* showsCard() {
      // Page data loads only in a browser document.
      rstest.stubGlobal('document', {});
      rstest.stubGlobal('dispatchEvent', () => true);
      yield* aiActivityData.preload('company-a');
      expect(records).toHaveBeenCalledTimes(1);
      expect(records.mock.calls[0]?.[0]).toEqual({ includeAiActivity: true });
    }),
  );
});
