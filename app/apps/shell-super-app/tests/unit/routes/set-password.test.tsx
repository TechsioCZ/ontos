import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, rstest } from 'effect-rstest';
import { renderToString } from 'react-dom/server';

import SetPasswordPage from '../../../src/routes/[lang]/set-password/page.tsx';
import { submitCredentialForm } from '../../../src/credential-form.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useRouterState: () => 'invitation-probe-token',
}));
rstest.mock('../../../src/routes/ultramodern-route-head', () => ({
  UltramodernRouteHead: () => null,
}));

afterEach(cleanup);

it('renders invitation acceptance with a fixed POST action and disables submission until hydrated', () => {
  const document = new DOMParser().parseFromString(renderToString(<SetPasswordPage />), 'text/html');
  const form = document.querySelector('form');
  expect(form?.getAttribute('method')).toBe('post');
  expect(form?.getAttribute('action')).toBe('/cs/login');
  expect(form?.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
  expect(form?.querySelectorAll('input[type="password"]').length).toBe(2);
});

it.each([false, true])('only calls the credential client when hydrated is %s', (hydrated) => {
  const submit = rstest.fn<(form: FormData) => void>();
  render(
    <form onSubmit={(event) => submitCredentialForm(event, hydrated, submit)}>
      <input aria-label="Probe" name="password" type="password" />
      <button type="submit">Submit</button>
    </form>,
  );
  const form = screen.getByRole('button').closest('form');
  expect(form).not.toBeNull();
  if (form !== null) {
    expect(fireEvent.submit(form)).toBe(false);
  }
  expect(submit).toHaveBeenCalledTimes(hydrated ? 1 : 0);
});
