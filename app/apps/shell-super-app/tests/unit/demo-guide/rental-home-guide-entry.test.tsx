// @rstest-environment happy-dom
import { settle } from '@app/admin-ui/testing/module-ui';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

import { DemoGuideHomeCard } from '../../../src/demo-guide/demo-guide-home-card.tsx';
import { DEMO_GUIDE_OPEN_KEY } from '../../../src/demo-guide/demo-guide-store.ts';
import { shellLocaleCopy } from '../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../support/shell-router.tsx';

afterEach(() => {
  cleanup();
  localStorage.removeItem(DEMO_GUIDE_OPEN_KEY);
});

it.live('offers the rental company a home entry that opens its demo guide', () =>
  Effect.gen(function* rentalGuideEntry() {
    localStorage.removeItem(DEMO_GUIDE_OPEN_KEY);
    const legalEntityId = '71000000-0000-4000-8000-000000000021';
    const router = makeShellRouter({
      page: { component: () => <DemoGuideHomeCard legalEntityId={legalEntityId} />, path: '/' },
      url: '/cs',
    });
    yield* renderShellRoute(router, shellLocaleCopy('cs'));
    yield* settle;
    const entry = screen.getByRole('button');
    expect(entry.getAttribute('disabled')).toBeNull();
    expect(localStorage.getItem(DEMO_GUIDE_OPEN_KEY)).toBeNull();
    const user = userEvent.setup();
    yield* Effect.promise(() => user.click(entry));
    expect(localStorage.getItem(DEMO_GUIDE_OPEN_KEY)).toBe('open');
  }),
);
