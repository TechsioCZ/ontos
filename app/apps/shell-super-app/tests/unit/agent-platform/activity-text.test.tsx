import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModernI18nContext } from '@modern-js/plugin-i18n/runtime/contexts';
import { getI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { expect, it } from 'effect-rstest';
import { Effect } from 'effect';

import { ActivityText } from '../../../src/routes/agent-platform/activity-panel.tsx';

it('keeps an unavailable or forbidden destination as plain text, not a disabled anchor', () => {
  const { container, unmount } = render(<ActivityText path={undefined}>Nepřístupný záznam</ActivityText>);
  expect(screen.getByText('Nepřístupný záznam')).toBeTruthy();
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector('[tabindex]')).toBeNull();
  unmount();
});

it.effect('renders a real localized anchor with a native keyboard tab stop', () =>
  Effect.gen(function* localizedKeyboardLink() {
    const user = userEvent.setup();
    const i18n = yield* Effect.promise(getI18nInstance);
    yield* Effect.promise(i18n.init.bind(i18n, { lng: 'cs', resources: { cs: { translation: {} } } }));
    const contextValue = Object.freeze({
      i18nInstance: i18n,
      ignoreRedirectRoutes: [],
      language: 'cs',
      languages: ['cs', 'en'],
      localePathRedirect: true,
      updateLanguage: (language: string) => {
        void i18n.changeLanguage?.(language);
      },
    });
    const { unmount } = render(
      <ModernI18nContext.Provider value={contextValue}>
        <ActivityText path="/sprava/ke-schvaleni?navrh=core%3Ap1">Otevřít návrh</ActivityText>
      </ModernI18nContext.Provider>,
    );
    yield* Effect.addFinalizer(() => Effect.sync(unmount));
    const link = screen.getByRole('link', { name: 'Otevřít návrh' });
    expect(link.getAttribute('href')).toContain('/sprava/ke-schvaleni?navrh=core%3Ap1');
    yield* Effect.promise(user.tab.bind(user, {}));
    expect(document.activeElement).toBe(link);
  }),
);
