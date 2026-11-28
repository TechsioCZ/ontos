import { requiredLabelFor } from '@app/admin-ui';
import { RouterProvider } from '@modern-js/plugin-tanstack/runtime';
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { networkIdle, streamingBrowserNetwork } from '@app/shared-contracts/testing/http-double';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { renderToString } from 'react-dom/server';

import SetPasswordPage from '../../../src/routes/[lang]/set-password/page.tsx';
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

it.effect('renders no password field on the server, so nothing can be posted before hydration', () =>
  Effect.gen(function* noFieldsBeforeHydration() {
    const document = new DOMParser().parseFromString(yield* serverHtml, 'text/html');
    expect(document.querySelector('form')).not.toBeNull();
    expect(document.querySelectorAll('input').length).toBe(0);
    expect(document.querySelector('button')).toBeNull();
  }),
);

it.effect('reads the required text of a required field in Czech', () =>
  Effect.gen(function* requiredInCzech() {
    yield* renderShellRoute(setPasswordRouter(), czech);
    expect(czech.exists('shell.invitation.newPassword')).toBe(true);
    const password = yield* Effect.promise(() =>
      screen.findByLabelText(new RegExp(czech.t('shell.invitation.newPassword'), 'u')),
    );
    const label = document.querySelector(`label[for="${password.id}"]`)?.textContent;
    expect(label).toContain(requiredLabelFor('cs'));
    expect(label).not.toContain('(required)');
  }),
);

const typePasswords = (password: string, confirmation: string) =>
  Effect.promise(async () => {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(new RegExp(czech.t('shell.invitation.newPassword'), 'u')), password);
    await user.type(screen.getByLabelText(new RegExp(czech.t('shell.invitation.confirmPassword'), 'u')), confirmation);
    await user.click(screen.getByRole('button', { name: 'Nastavit heslo' }));
  });

/** The invitation endpoint on the test DOM's network; `bodies` records what the page sent it. */
const invitationOrigin = () => {
  const bodies: string[] = [];
  const endpoint = HttpRouter.add(
    'POST',
    '/shell-super-app-api/invitation/set-password',
    Effect.gen(function* setPassword() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      bodies.push(yield* Effect.orDie(request.text));
      return HttpServerResponse.jsonUnsafe({ status: true });
    }),
  ).pipe(Layer.provide(HttpServer.layerServices));
  return { bodies, browser: streamingBrowserNetwork(endpoint) } as const;
};

it.effect('checks the password and its confirmation before anything is sent', () =>
  Effect.gen(function* checksPasswords() {
    const origin = invitationOrigin();
    yield* Effect.gen(function* typeInvalidPasswords() {
      yield* renderShellRoute(setPasswordRouter(), czech);
      yield* typePasswords('short', 'short');
      expect(yield* Effect.promise(() => screen.findByText('Zvolte heslo o délce 8 až 128 znaků.'))).toBeDefined();
      cleanup();
      yield* renderShellRoute(setPasswordRouter(), czech);
      yield* typePasswords('long enough', 'different');
      expect(yield* Effect.promise(() => screen.findByText('Hesla se neshodují.'))).toBeDefined();
      yield* networkIdle;
    }).pipe(Effect.provide(origin.browser));
    expect(origin.bodies).toEqual([]);
  }),
);

it.effect('sets the password once and drops the one-use token from the address', () =>
  Effect.gen(function* setsPassword() {
    const origin = invitationOrigin();
    window.history.replaceState(null, '', invitationUrl);
    yield* Effect.gen(function* submitPasswords() {
      yield* renderShellRoute(setPasswordRouter(), czech);
      yield* typePasswords('long enough', 'long enough');
      expect(yield* Effect.promise(() => screen.findByText(/Heslo je nastavené/u))).toBeDefined();
      yield* networkIdle;
    }).pipe(Effect.provide(origin.browser));
    expect(origin.bodies).toEqual([JSON.stringify({ password: 'long enough', token: 'a'.repeat(43) })]);
    expect(window.location.search).toBe('');
  }),
);
