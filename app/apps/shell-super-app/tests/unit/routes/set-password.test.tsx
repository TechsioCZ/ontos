import { requiredLabelFor } from '@app/admin-ui';
import { RouterProvider } from '@modern-js/plugin-tanstack/runtime';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Effect } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';
import { renderToString } from 'react-dom/server';

import SetPasswordPage from '../../../src/routes/[lang]/set-password/page.tsx';
import { submitCredentialForm } from '../../../src/credential-form.ts';
import { ShellI18n, shellLocaleCopy } from '../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../support/shell-router.tsx';

/** The Shell's own Czech copy, as the page renders it. */
const czech = shellLocaleCopy('cs');
/** An invitation link as the mail carries it: the page reads its token from the URL search. */
const invitationUrl = `/cs/set-password?token=${'a'.repeat(43)}`;
const setPasswordRouter = () =>
  makeShellRouter({ page: { component: SetPasswordPage, path: 'set-password' }, url: invitationUrl });

/** The page as the server renders it, before hydration, on a loaded real router. */
const serverHtml = Effect.gen(function* renderOnServer() {
  const router = setPasswordRouter();
  yield* Effect.promise(async () => await router.load());
  return renderToString(
    <ShellI18n translations={czech}>
      <RouterProvider router={router} />
    </ShellI18n>,
  );
});

afterEach(cleanup);

it.effect('renders invitation acceptance with a fixed POST action and disables submission until hydrated', () =>
  Effect.gen(function* fixedPostAction() {
    const document = new DOMParser().parseFromString(yield* serverHtml, 'text/html');
    const form = document.querySelector('form');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.getAttribute('action')).toBe('/cs/login');
    expect(form?.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
    expect(form?.querySelectorAll('input[type="password"]').length).toBe(2);
  }),
);

it.effect('reads the required text of a required field in Czech', () =>
  Effect.gen(function* requiredInCzech() {
    const html = yield* serverHtml;
    expect(html).toContain(requiredLabelFor('cs'));
    expect(html).not.toContain('(required)');

    yield* renderShellRoute(setPasswordRouter(), czech);
    expect(czech.exists('shell.invitation.newPassword')).toBe(true);
    const password = yield* Effect.promise(() =>
      screen.findByLabelText(new RegExp(czech.t('shell.invitation.newPassword'), 'u')),
    );
    expect(document.querySelector(`label[for="${password.id}"]`)?.textContent).toContain(requiredLabelFor('cs'));
  }),
);

it.each([false, true])('only calls the credential client when hydrated is %s', (hydrated) => {
  const submit = rstest.fn<(form: FormData) => void>();
  render(
    <form onSubmit={(event) => submitCredentialForm(event, hydrated, submit)}>
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
