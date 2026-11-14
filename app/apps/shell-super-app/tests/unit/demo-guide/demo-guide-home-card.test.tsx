import { getI18nInstance as createModernI18n } from '@modern-js/plugin-i18n/i18n';
import type { I18nInstance } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it } from 'effect-rstest';

import csResource from '../../../locales/cs/shell.json';
import { DemoGuideHomeCard } from '../../../src/demo-guide/demo-guide-home-card.tsx';

let i18nInstance: I18nInstance;
beforeAll(async () => {
  i18nInstance = await createModernI18n();
  await i18nInstance.init({
    defaultNS: 'shell',
    lng: 'cs',
    ns: ['shell'],
    resources: { cs: { shell: csResource } },
    supportedLngs: ['cs', 'en'],
  });
});

afterEach(() => {
  cleanup();
});

it('displays Nájempark on the home card for the existing rental legal entity', () => {
  const { container } = render(
    <ModernI18nProvider value={{ i18nInstance, language: 'cs', languages: ['cs', 'en'] }}>
      <DemoGuideHomeCard legalEntityId="71000000-0000-4000-8000-000000000021" />
    </ModernI18nProvider>,
  );
  expect(screen.getByRole('heading', { name: 'Nájempark: připravená ukázka' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Otevřít průvodce' })).toBeTruthy();
  expect(container.textContent).not.toMatch(/siampark/iu);
});
