import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModernI18nContext } from '@modern-js/plugin-i18n/runtime/contexts';
import { getI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { expect, it } from 'effect-rstest';

import { ActivityText } from '../../../src/routes/agent-platform/activity-panel.tsx';

it('keeps an unavailable or forbidden destination as plain text, not a disabled anchor', () => {
  const { container, unmount } = render(<ActivityText path={undefined}>Nepřístupný záznam</ActivityText>);
  expect(screen.getByText('Nepřístupný záznam')).toBeTruthy();
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector('[tabindex]')).toBeNull();
  unmount();
});

it('renders a real localized anchor with a native keyboard tab stop', async () => {
  const user = userEvent.setup();
  const i18n = await getI18nInstance();
  await i18n.init({ lng: 'cs', resources: { cs: { translation: {} } } });
  const { unmount } = render(
    <ModernI18nContext.Provider
      value={{
        language: 'cs',
        languages: ['cs', 'en'],
        i18nInstance: i18n,
        localePathRedirect: true,
        ignoreRedirectRoutes: [],
        updateLanguage: (language: string) => {
          void i18n.changeLanguage?.(language);
        },
      }}
    >
      <ActivityText path="/sprava/ke-schvaleni?navrh=core%3Ap1">Otevřít návrh</ActivityText>
    </ModernI18nContext.Provider>,
  );
  const link = screen.getByRole('link', { name: 'Otevřít návrh' });
  expect(link.getAttribute('href')).toContain('/sprava/ke-schvaleni?navrh=core%3Ap1');
  await user.tab();
  expect(document.activeElement).toBe(link);
  unmount();
});
