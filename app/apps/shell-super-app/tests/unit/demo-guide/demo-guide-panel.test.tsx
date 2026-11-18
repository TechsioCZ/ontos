// @rstest-environment happy-dom
import { settle } from '@app/admin-ui/testing/module-ui';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import type { ReactElement } from 'react';

import { DemoGuidePanel, DemoGuideToggleButton } from '../../../src/demo-guide/demo-guide-panel.tsx';
import { DEMO_GUIDE_OPEN_KEY, readDemoGuideProgress } from '../../../src/demo-guide/demo-guide-store.ts';
import type { DemoGuide } from '../../../src/demo-guide/demo-guide-types.ts';
import { shellLocaleCopy } from '../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../support/shell-router.tsx';

const render = (ui: ReactElement) =>
  Effect.gen(function* renderGuideRoute() {
    const router = makeShellRouter({ page: { component: () => ui, path: '/' }, url: '/cs' });
    const view = yield* renderShellRoute(router, shellLocaleCopy('cs'));
    yield* settle;
    return view;
  });

const guide: DemoGuide = {
  chapters: [
    {
      id: 'klienti',
      steps: [
        {
          click: 'Ukažte nadpis.',
          id: 'hanak-test-a',
          persona: { email: 'vedouci@hanak.demo', role: 'Vedení obchodu' },
          say: 'První věta.',
          target: { kind: 'app', path: '/crm/klienti?tab=1' },
          title: 'Mí klienti',
        },
        {
          id: 'hanak-test-b',
          persona: null,
          say: 'Druhá věta.',
          target: { kind: 'external', label: 'e-shop ŠroubShop', url: 'http://localhost:3070/' },
          title: 'E-shop',
        },
      ],
      summary: 'Kapitola.',
      title: 'Klienti',
    },
  ],
  companyName: 'Velkoobchod Hanák s.r.o.',
  id: 'hanak',
  intro: 'Úvod.',
  legalEntityId: '71000000-0000-4000-8000-000000000022',
};

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
});

it.live('renders chapters, steps, persona state and both kinds of links', () =>
  Effect.gen(function* renderGuide() {
    yield* render(<DemoGuidePanel guide={guide} identityEmail="vedouci@hanak.demo" />);
    expect(screen.getByRole('complementary', { name: 'Průvodce ukázkou' })).toBeTruthy();
    expect(screen.getByText('Hotovo 0 z 2 kroků')).toBeTruthy();
    expect(screen.getByText('Jste přihlášeni')).toBeTruthy();
    expect(screen.getByText('Další krok')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Otevřít obrazovku' }).getAttribute('href')).toBe('/cs/crm/klienti?tab=1');
    const external = screen.getByRole('link', { name: 'Otevřít e-shop ŠroubShop' });
    expect(external.getAttribute('href')).toBe('http://localhost:3070/');
    expect(external.getAttribute('target')).toBe('_blank');
  }),
);

it.live('checks a step, persists it and starts again', () =>
  Effect.gen(function* persistStepProgress() {
    const user = userEvent.setup();
    yield* render(<DemoGuidePanel guide={guide} identityEmail={undefined} />);
    yield* Effect.promise(user.click.bind(user, screen.getByRole('checkbox', { name: 'Mí klienti' })));
    expect(readDemoGuideProgress('hanak')).toEqual(['hanak-test-a']);
    expect(screen.getByText('Hotovo 1 z 2 kroků')).toBeTruthy();
    yield* Effect.promise(user.click.bind(user, screen.getByRole('button', { name: 'Začít znovu' })));
    expect(readDemoGuideProgress('hanak')).toEqual([]);
  }),
);

it.live('opens and closes through the header button and the close button', () =>
  Effect.gen(function* guideOpenAndClose() {
    const user = userEvent.setup();
    yield* render(<DemoGuideToggleButton open={false} />);
    yield* Effect.promise(user.click.bind(user, screen.getByRole('button', { name: 'Průvodce ukázkou' })));
    expect(globalThis.localStorage.getItem(DEMO_GUIDE_OPEN_KEY)).toBe('open');
    cleanup();
    yield* render(<DemoGuidePanel guide={guide} identityEmail={undefined} />);
    yield* Effect.promise(user.click.bind(user, screen.getByRole('button', { name: 'Zavřít průvodce' })));
    expect(globalThis.localStorage.getItem(DEMO_GUIDE_OPEN_KEY)).toBeNull();
  }),
);

const stepList = () => {
  const list = screen.getByRole('region', { name: 'Postup ukázky' }).parentElement;
  if (list === null) {
    throw new Error('step list not rendered');
  }
  return list;
};

it.live('keeps the step list scroll position when the panel mounts again', () =>
  Effect.gen(function* restoreScrollPosition() {
    yield* render(<DemoGuidePanel guide={guide} identityEmail={undefined} />);
    stepList().scrollTop = 240;
    fireEvent.scroll(stepList());
    cleanup();
    yield* render(<DemoGuidePanel guide={guide} identityEmail={undefined} />);
    expect(stepList().scrollTop).toBe(240);
  }),
);

it.live('closes the guide on Escape anywhere in the page and removes the handler on unmount', () =>
  Effect.gen(function* closeOnEscape() {
    globalThis.localStorage.setItem(DEMO_GUIDE_OPEN_KEY, 'open');
    const { unmount } = yield* render(<DemoGuidePanel guide={guide} identityEmail={undefined} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(globalThis.localStorage.getItem(DEMO_GUIDE_OPEN_KEY)).toBeNull();
    unmount();
    globalThis.localStorage.setItem(DEMO_GUIDE_OPEN_KEY, 'open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(globalThis.localStorage.getItem(DEMO_GUIDE_OPEN_KEY)).toBe('open');
  }),
);
