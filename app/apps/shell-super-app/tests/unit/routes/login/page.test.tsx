import { requiredLabelFor } from '@app/admin-ui';
import { HttpApi } from '@modern-js/bff-effect/effect-client';
import {
  HttpApiBuilder,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from '@modern-js/bff-effect/effect-edge';
import { Outlet, RouterContextProvider } from '@modern-js/plugin-tanstack/runtime';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Latch, Layer, Redacted, Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';
import { renderToString } from 'react-dom/server';

import {
  AuthenticationUnavailableProblemSchema,
  InvalidCredentialsProblemSchema,
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
  SignInResponseSchema,
} from '../../../../shared/browser-api.ts';
import { OAUTH_PRELOGIN_PATH } from '../../../../src/routes/[lang]/login/oauth-handoff.ts';
import LoginPage from '../../../../src/routes/[lang]/login/page';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import { networkIdle, networkSteady, streamingBrowserNetwork } from '@app/shared-contracts/testing/http-double';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';
import { ShellI18n, shellTestCopy } from '../../../support/shell-i18n.tsx';
import type { ShellLanguage } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';
import type { ShellRouter } from '../../../support/shell-router.tsx';

const copy = {
  'shell.login.back': '← Back to the home page',
  'shell.login.field.login': 'Login',
  'shell.login.field.password': 'Password',
  'shell.login.pending': 'Signing in…',
  'shell.login.required.login': 'Enter your login.',
  'shell.login.required.password': 'Enter your password.',
  'shell.login.submit': 'Login',
  'shell.login.title': 'Login',
  'shell.login.toast.description': 'Fill in both required fields.',
  'shell.login.toast.title': 'Login details are incomplete',
};

const signedIn = Schema.decodeUnknownSync(SignInResponseSchema)({
  identity: {
    displayName: 'Ada',
    email: 'ada@example.test',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
});

/**
 * The Shell BFF that accepts the sign-in this file submits. With a gate, the answer waits until the
 * test opens it, so the test can read the form as the submission left it before the page navigates.
 */
const signInBff = (gate?: Latch.Latch) =>
  makeShellBff({
    signIn: () => (gate === undefined ? Effect.succeed(signedIn) : gate.await.pipe(Effect.as(signedIn))),
  });

/** The Shell BFF answering each sign-in with the next scripted answer, the last one repeating. */
const signInAnswers = (...answers: readonly NonNullable<ShellBffScript['signIn']>[]) => {
  let attempt = 0;
  return makeShellBff({
    signIn: (payload) =>
      Effect.suspend(() => {
        const answer = answers[Math.min(attempt, answers.length - 1)] ?? (() => Effect.succeed(signedIn));
        attempt += 1;
        return answer(payload);
      }),
  });
};
const problem = { detail: 'redacted', title: 'Problem', type: 'about:blank' };

const OAuthLoginApi = HttpApi.make('oauthLogin')
  .add(ShellAuthenticationApi.groups.authentication)
  .prefix(shellAuthenticationApiContract.apiPrefix);

/** One request the authorization server's public-client lookup received. */
interface PreloginRequest {
  readonly body: string;
  readonly credentials: RequestCredentials;
  readonly method: string;
  readonly url: string;
}

/**
 * The origin's sign-in and the authorization server's public-client lookup, served in process on the test DOM's
 * network: the lookup answers with `prelogin`, and `requests` records what the page sent it.
 */
const oauthOrigin = (prelogin: () => HttpServerResponse.HttpServerResponse) => {
  const requests: PreloginRequest[] = [];
  const signInHandlers = HttpApiBuilder.group(OAuthLoginApi, 'authentication', (group) =>
    group
      .handle('signIn', () => Effect.succeed(signedIn))
      .handle('currentSession', () => Effect.die('The login page never reads the session'))
      .handle('signOut', () => Effect.die('The login page never signs out')),
  );
  const lookup = HttpRouter.add(
    'POST',
    OAUTH_PRELOGIN_PATH,
    Effect.gen(function* preloginLookup() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* Effect.orDie(HttpServerRequest.toWeb(request));
      const body = yield* Effect.orDie(request.text);
      requests.push({ body, credentials: webRequest.credentials, method: request.method, url: request.originalUrl });
      return prelogin();
    }),
  );
  const application = Layer.mergeAll(
    HttpApiBuilder.layer(OAuthLoginApi).pipe(Layer.provide(signInHandlers)),
    lookup,
  ).pipe(Layer.provide(HttpServer.layerServices));
  return { browser: streamingBrowserNetwork(application), requests } as const;
};

/** The login route of a real router, in the given language. */
const loginRouter = (language: ShellLanguage = 'en') =>
  makeShellRouter({ page: { component: LoginPage, path: 'login' }, url: `/${language}/login` });
const renderLogin = (router: ShellRouter = loginRouter(), language: ShellLanguage = 'en') =>
  renderShellRoute(router, shellTestCopy(language, copy));

const getLogin = () => screen.getByRole('textbox', { name: /^Login/u });
const getPassword = () => screen.getByLabelText(/^Password/u, { selector: 'input' });
const getSubmit = () => screen.getByRole('button', { name: 'Login' });
/** The submit control, idle or announcing the sign-in it started. */
const getSubmitControl = () => screen.getByRole('button', { name: /^(?:Login|Signing in…)$/u });

afterEach(() => {
  // Toasts are removed while the Toaster is still mounted, so it drops them; removed after unmount, they return
  // with the next test's Toaster.
  toaster.remove();
  cleanup();
  window.history.replaceState(null, '', '/');
  rstest.restoreAllMocks();
});

it.effect('renders a fixed POST action and a disabled submit button before hydration', () =>
  Effect.gen(function* serverRenderedForm() {
    const router = loginRouter();
    yield* Effect.promise(async () => await router.load());
    const html = renderToString(
      <ShellI18n translations={shellTestCopy('en', copy)}>
        <RouterContextProvider router={router}>
          <LoginPage />
        </RouterContextProvider>
      </ShellI18n>,
    );
    const document = new DOMParser().parseFromString(html, 'text/html');
    const form = document.querySelector('form');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.getAttribute('action')).toBe('/en/login');
    expect(form?.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
    expect(form?.dataset['hydrated']).toBeUndefined();
    yield* renderLogin();
    expect(getSubmit().hasAttribute('disabled')).toBe(false);
  }),
);

const oauthQuery =
  'response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Fclient&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcallback&prompt=login&state=preserved&sig=SIGNED';
const oauthLoginPath = `/en/login?${oauthQuery}`;
/** The OAuth connect flow's login page, as the browser opens it from the authorization server. */
const openOAuthLogin = () => {
  window.history.replaceState(null, '', oauthLoginPath);
  return makeShellRouter({ page: { component: LoginPage, path: 'login' }, url: oauthLoginPath });
};

it.effect('reads the OAuth client public name with the original signed query', () =>
  Effect.gen(function* preservesOAuthClientLookup() {
    const origin = oauthOrigin(() => HttpServerResponse.jsonUnsafe({ client_name: ' Trusted Client ' }));
    yield* Effect.gen(function* lookUpClient() {
      yield* renderLogin(openOAuthLogin());
      expect(yield* Effect.promise(() => screen.findByText('Trusted Client'))).toBeDefined();
      yield* networkIdle;
    }).pipe(Effect.provide(origin.browser));
    expect(origin.requests).toEqual([
      {
        body: `{"client_id":"https://claude.ai/client","oauth_query":"${oauthQuery}"}`,
        credentials: 'same-origin',
        method: 'POST',
        url: `http://localhost:3000${OAUTH_PRELOGIN_PATH}`,
      },
    ]);
  }),
);

it.effect('keeps the OAuth host fallback when its public client lookup fails', () =>
  Effect.gen(function* preservesOAuthClientFallback() {
    const origin = oauthOrigin(() => HttpServerResponse.empty({ status: 503 }));
    yield* Effect.gen(function* lookUpUnavailableClient() {
      yield* renderLogin(openOAuthLogin());
      expect(yield* Effect.promise(() => screen.findByTestId('oauth-login-banner'))).toBeDefined();
      yield* networkIdle;
      expect(origin.requests).toHaveLength(1);
    }).pipe(Effect.provide(origin.browser));
    expect(screen.getByText('claude.ai')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  }),
);

it.effect('shows the required login controls through the UI kit', () =>
  Effect.gen(function* requiredControls() {
    yield* renderLogin();

    const login = getLogin();
    const password = getPassword();
    const submit = getSubmit();

    expect(login.getAttribute('name')).toBe('login');
    expect(login.getAttribute('autocomplete')).toBe('username');
    expect(login.hasAttribute('required')).toBe(true);
    expect(password.getAttribute('name')).toBe('password');
    expect(password.getAttribute('type')).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(password.hasAttribute('required')).toBe(true);
    expect(submit.getAttribute('type')).toBe('submit');
    expect(screen.getByRole('link', { name: '← Back to the home page' }).getAttribute('href')).toBe('/en');
  }),
);

it.effect('reads the required text of a required field in Czech', () =>
  Effect.gen(function* czechRequiredText() {
    yield* renderLogin(loginRouter('cs'), 'cs');

    const login = getLogin();
    expect(document.querySelector(`label[for="${login.id}"]`)?.textContent).toContain(requiredLabelFor('cs'));
    expect(document.querySelector(`label[for="${login.id}"]`)?.textContent).not.toContain('(required)');
    expect(document.querySelector(`label[for="${getPassword().id}"]`)?.textContent).toContain(requiredLabelFor('cs'));
    expect(document.body.textContent).not.toContain('(required)');
  }),
);

it.effect('the back link resolves Czech from the same canonical target', () =>
  Effect.gen(function* czechBackLink() {
    yield* renderLogin(loginRouter('cs'), 'cs');

    expect(screen.getByRole('link', { name: '← Back to the home page' }).getAttribute('href')).toBe('/cs');
  }),
);

/** Every Effect the page has handed to the browser runtime, settled. */
const pageEffectsSettled = (runs: { readonly mock: { readonly results: readonly { readonly value: unknown }[] } }) =>
  Effect.promise(() => Promise.allSettled(runs.mock.results.map((result) => result.value))).pipe(
    Effect.andThen(networkIdle),
  );

/**
 * Renders the login route and submits the given values. The page's own Effects are observed, so a
 * test that submits valid values can await the sign-in it started before the test scope closes.
 */
const submitLogin = (login: string, password: string, router: ShellRouter = loginRouter()) =>
  Effect.gen(function* submitLoginEffect() {
    const user = userEvent.setup();
    const runs = rstest.spyOn(browserRuntime, 'runPromise');
    yield* renderLogin(router);
    if (login.length > 0) {
      yield* Effect.promise(() => user.type(getLogin(), login));
    }
    if (password.length > 0) {
      yield* Effect.promise(() => user.type(getPassword(), password));
    }
    yield* Effect.promise(() => user.click(getSubmit()));
    // Some cases deliberately hold the sign-in response open. Wait for traffic to settle without releasing it.
    yield* networkSteady;
    return { runs, user };
  });

/** Let the real Location.assign update its URL without replacing the test document or any browser method. */
const keepOAuthDocument = Effect.gen(function* keepDocumentDuringAuthorization() {
  const { settings } = window.happyDOM;
  const navigationSettings = Schema.Struct({
    navigation: Schema.Struct({ disableMainFrameNavigation: Schema.mutableKey(Schema.Boolean) }),
  });
  if (!Schema.is(navigationSettings)(settings)) {
    throw new Error('The test DOM must expose its native navigation settings');
  }
  const { navigation } = settings;
  const previous = navigation.disableMainFrameNavigation;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      navigation.disableMainFrameNavigation = true;
    }),
    () =>
      Effect.sync(() => {
        navigation.disableMainFrameNavigation = previous;
      }),
  );
});

it.effect('returns an OAuth sign-in to authorization without opening a Shell page', () =>
  Effect.gen(function* preservesOAuthAuthorizationReturn() {
    yield* keepOAuthDocument;
    const origin = oauthOrigin(() => HttpServerResponse.jsonUnsafe({}));
    const router = openOAuthLogin();
    const invalidations = rstest.spyOn(router, 'invalidate');
    const navigations = rstest.spyOn(router, 'navigate');
    yield* Effect.gen(function* signInForAuthorization() {
      const { runs } = yield* submitLogin('admin', 'secret', router);
      yield* pageEffectsSettled(runs);
    }).pipe(Effect.provide(origin.browser));
    expect(globalThis.location.href).toBe(
      'http://localhost:3000/shell-super-app-api/oauth/oauth2/authorize?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Fclient&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcallback&state=preserved',
    );
    expect(invalidations).not.toHaveBeenCalled();
    expect(navigations).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

interface LoginValidationCase {
  readonly focus: 'login' | 'password' | 'submit';
  readonly login: string;
  readonly loginInvalid: boolean;
  readonly name: string;
  readonly password: string;
  readonly passwordInvalid: boolean;
}

const focusTargets = {
  login: getLogin,
  password: getPassword,
  submit: getSubmitControl,
};

const validationCases: LoginValidationCase[] = [
  {
    focus: 'login',
    login: '',
    loginInvalid: true,
    name: 'both values are missing',
    password: '',
    passwordInvalid: true,
  },
  {
    focus: 'login',
    login: '',
    loginInvalid: true,
    name: 'only the Password is present',
    password: 'secret',
    passwordInvalid: false,
  },
  {
    focus: 'password',
    login: 'admin',
    loginInvalid: false,
    name: 'only the Login is present',
    password: '',
    passwordInvalid: true,
  },
  {
    focus: 'login',
    login: '   ',
    loginInvalid: true,
    name: 'the Login holds only whitespace',
    password: 'secret',
    passwordInvalid: false,
  },
  {
    focus: 'submit',
    login: 'admin',
    loginInvalid: false,
    name: 'the Password is a single space',
    password: ' ',
    passwordInvalid: false,
  },
];

it.effect.each(validationCases)(
  'marks, explains and focuses exactly the missing fields when $name',
  ({ focus, login, loginInvalid, password, passwordInvalid }) =>
    Effect.gen(function* marksExplainsAndFocusesTheMissingFields() {
      const answered = yield* Latch.make();
      const bff = signInBff(answered);
      yield* Effect.gen(function* submitAndRead() {
        const { runs } = yield* submitLogin(login, password);

        const incompleteToasts = loginInvalid || passwordInvalid ? 1 : 0;
        expect(getLogin().getAttribute('aria-invalid')).toBe(loginInvalid ? 'true' : null);
        expect(getPassword().getAttribute('aria-invalid')).toBe(passwordInvalid ? 'true' : null);
        expect(screen.queryAllByText('Enter your login.')).toHaveLength(loginInvalid ? 1 : 0);
        expect(screen.queryAllByText('Enter your password.')).toHaveLength(passwordInvalid ? 1 : 0);
        expect(screen.queryAllByText('Login details are incomplete')).toHaveLength(incompleteToasts);
        expect(screen.queryAllByText('Fill in both required fields.')).toHaveLength(incompleteToasts);
        expect(document.activeElement).toBe(focusTargets[focus]());
        // Only a complete submission reaches the authentication client.
        yield* answered.open;
        yield* pageEffectsSettled(runs);
        expect(bff.requests).toHaveLength(incompleteToasts === 0 ? 1 : 0);
      }).pipe(Effect.provide(bff.browser));
    }),
);

it.effect('creates one Toast per repeated invalid submission', () =>
  Effect.gen(function* createsOneToastPerRepeatedInvalidSubmission() {
    const { user } = yield* submitLogin('', '');

    yield* Effect.promise(() => user.click(getSubmit()));
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(2);
    expect(screen.getAllByText('Fill in both required fields.')).toHaveLength(2);
  }),
);

it.effect('clears stale errors after both fields are corrected', () =>
  Effect.gen(function* clearsStaleErrorsAfterBothFieldsCorrected() {
    const answered = yield* Latch.make();
    const bff = signInBff(answered);
    yield* Effect.gen(function* correctAndResubmit() {
      const { runs, user } = yield* submitLogin('', '');

      yield* Effect.promise(() => user.type(getLogin(), 'admin'));
      yield* Effect.promise(() => user.type(getPassword(), 'secret'));
      yield* Effect.promise(() => user.click(getSubmit()));
      expect(getLogin().getAttribute('aria-invalid')).toBeNull();
      expect(getPassword().getAttribute('aria-invalid')).toBeNull();
      expect(screen.queryByText('Enter your login.')).toBeNull();
      expect(screen.queryByText('Enter your password.')).toBeNull();
      yield* answered.open;
      yield* pageEffectsSettled(runs);
      expect(bff.requests.map((received) => received.endpoint)).toEqual(['signIn']);
    }).pipe(Effect.provide(bff.browser));
  }),
);

it.effect('runs the same validation when submitted with Enter', () =>
  Effect.gen(function* runsTheSameValidationWhenSubmittedWithEnter() {
    const user = userEvent.setup();
    yield* renderLogin();

    yield* Effect.promise(() => user.click(getLogin()));
    yield* Effect.promise(() => user.keyboard('{Enter}'));
    expect(getLogin().getAttribute('aria-invalid')).toBe('true');
    expect(getPassword().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
    expect(document.activeElement).toBe(getLogin());
  }),
);

it.effect('submits valid values through the Shell authentication client and navigates home', () => {
  const bff = signInBff();
  return Effect.gen(function* submitsValidValuesThroughShellAuthClient() {
    const router = loginRouter();
    const invalidations = rstest.spyOn(router, 'invalidate');
    const navigations = rstest.spyOn(router, 'navigate');
    const { runs } = yield* submitLogin('admin', 'secret', router);
    yield* pageEffectsSettled(runs);

    expect(runs).toHaveBeenCalledTimes(1);
    expect(bff.requests).toHaveLength(1);
    expect(bff.requests[0]).toMatchObject({ acceptLanguage: 'en', endpoint: 'signIn' });
    expect(bff.requests[0]?.body).toEqual({ email: 'admin', password: Redacted.make('secret') });
    expect(invalidations).toHaveBeenCalledWith({ sync: true });
    expect(navigations).toHaveBeenCalledWith(expect.objectContaining({ to: '/en/' }));
    // The router normalises the home target without its trailing slash.
    expect(router.state.location.pathname).toBe('/en');
    expect(screen.queryByText('shell.login.error.internal')).toBeNull();
    expect(screen.queryByText('Login details are incomplete')).toBeNull();
  }).pipe(Effect.provide(bff.browser));
});

it.effect('says the app is opening while the next page loads after a successful sign-in', () => {
  const bff = signInBff();
  return Effect.gen(function* saysTheAppIsOpening() {
    const router = loginRouter();
    const navigation = Promise.withResolvers<null>();
    const navigations = rstest.spyOn(router, 'navigate').mockImplementationOnce(async () => {
      await navigation.promise;
    });
    const { runs } = yield* submitLogin('admin', 'secret', router);

    const submit = yield* Effect.promise(() => screen.findByRole('button', { name: /shell\.login\.opening/u }));
    yield* networkIdle;
    expect(navigations).toHaveBeenCalledWith({ to: '/en/' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(copy['shell.login.pending'])).toBeNull();

    navigation.resolve(null);
    yield* pageEffectsSettled(runs);
    yield* Effect.promise(() => waitFor(() => expect(getSubmit().hasAttribute('disabled')).toBe(false)));
  }).pipe(Effect.provide(bff.browser));
});

/** The login form above every route, as the Shell keeps it on screen while the next page loads. */
const LoginAboveRoutes = () => (
  <>
    <LoginPage />
    <Outlet />
  </>
);

/**
 * A router whose page is the one sign-in returns to, answering with `state`; the login form stays on screen above
 * every route while the next page loads, as the Shell renders it.
 */
const returnRouter = (language: ShellLanguage, search: string, page: string, state: string) => {
  const url = `/${language}/login?${search}`;
  window.history.replaceState(null, '', url);
  return makeShellRouter({
    page: { component: () => null, loaderData: () => ({ state }), path: page },
    root: LoginAboveRoutes,
    url,
  });
};

it.effect('returns to the protected page that sent the visitor to sign-in, with a fresh page cache', () => {
  const bff = signInBff();
  return Effect.gen(function* returnsToProtectedPage() {
    const router = returnRouter(
      'en',
      'returnTo=%2Fen%2Fprehledy%2Fstatistiky%3Fgroup%3Dmonth',
      'prehledy/statistiky',
      'resolved',
    );
    const clearCache = rstest.spyOn(router, 'clearCache');
    const navigations = rstest.spyOn(router, 'navigate');
    const { runs } = yield* submitLogin('admin', 'secret', router);
    yield* pageEffectsSettled(runs);

    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveBeenCalledWith({ href: '/en/prehledy/statistiky?group=month' });
    expect(navigations).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/en/prehledy/statistiky');
  }).pipe(Effect.provide(bff.browser));
});

it.effect.each(['cs', 'en'] as const)('opens Home when the saved return page no longer exists in %s', (language) => {
  const bff = signInBff();
  return Effect.gen(function* returnsHomeFromMissingPage() {
    const router = returnRouter(
      language,
      `returnTo=%2F${language}%2Fretired-dashboard`,
      'retired-dashboard',
      'not_found',
    );
    const navigations = rstest.spyOn(router, 'navigate');
    yield* renderLogin(router, language);
    const user = userEvent.setup();
    const runs = rstest.spyOn(browserRuntime, 'runPromise');
    yield* Effect.promise(() => user.type(getLogin(), 'admin'));
    yield* Effect.promise(() => user.type(getPassword(), 'secret'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Login' })));
    yield* pageEffectsSettled(runs);

    expect(navigations).toHaveBeenNthCalledWith(1, { href: `/${language}/retired-dashboard` });
    expect(navigations).toHaveBeenNthCalledWith(2, { replace: true, to: `/${language}/` });
    expect(router.state.location.pathname).toBe(`/${language}`);
  }).pipe(Effect.provide(bff.browser));
});

it.effect.each(['resolved', 'forbidden', 'unavailable'])(
  'keeps a %s return-page result instead of going Home',
  (state) => {
    const bff = signInBff();
    return Effect.gen(function* keepsExistingReturnPageResult() {
      const router = returnRouter('en', 'returnTo=%2Fen%2Fprehledy%2Fstatistiky', 'prehledy/statistiky', state);
      const navigations = rstest.spyOn(router, 'navigate');
      const { runs } = yield* submitLogin('admin', 'secret', router);
      yield* pageEffectsSettled(runs);

      expect(getSubmit().hasAttribute('disabled')).toBe(false);
      expect(navigations).toHaveBeenCalledTimes(1);
      expect(navigations).toHaveBeenCalledWith({ href: '/en/prehledy/statistiky' });
      expect(router.state.location.pathname).toBe('/en/prehledy/statistiky');
    }).pipe(Effect.provide(bff.browser));
  },
);

it.effect('ignores a return target outside the application and goes home', () => {
  const bff = signInBff();
  return Effect.gen(function* ignoresForeignReturnTarget() {
    const router = returnRouter('en', 'returnTo=%2F%2Fevil.example%2Fen%2F', 'prehledy/statistiky', 'resolved');
    const navigations = rstest.spyOn(router, 'navigate');
    const { runs } = yield* submitLogin('admin', 'secret', router);
    yield* pageEffectsSettled(runs);

    expect(navigations).toHaveBeenCalledWith({ to: '/en/' });
    expect(router.state.location.pathname).toBe('/en');
  }).pipe(Effect.provide(bff.browser));
});

it.effect('reports navigation failure and restores the login form after authentication', () => {
  const bff = signInBff();
  return Effect.gen(function* reportsNavigationFailure() {
    const router = loginRouter();
    const navigations = rstest.spyOn(router, 'navigate').mockRejectedValueOnce('Navigation failed');
    const { runs } = yield* submitLogin('admin', 'secret', router);
    yield* pageEffectsSettled(runs);

    expect(navigations).toHaveBeenCalledWith(expect.objectContaining({ to: '/en/' }));
    expect(router.state.location.pathname).toBe('/en/login');
    expect(screen.getByText('shell.login.error.internal')).toBeDefined();
    expect(getSubmit().hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(getLogin());
  }).pipe(Effect.provide(bff.browser));
});

it.effect('keeps navigation on the login route when auth cache refresh fails', () => {
  const bff = signInBff();
  return Effect.gen(function* reportsAuthenticationRefreshFailure() {
    const router = loginRouter();
    const invalidations = rstest.spyOn(router, 'invalidate').mockRejectedValueOnce('Route refresh failed');
    const navigations = rstest.spyOn(router, 'navigate');
    const { runs } = yield* submitLogin('admin', 'secret', router);
    yield* pageEffectsSettled(runs);

    expect(invalidations).toHaveBeenCalledWith({ sync: true });
    expect(navigations).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/en/login');
    expect(screen.getByText('shell.login.error.internal')).toBeDefined();
    expect(getSubmit().hasAttribute('disabled')).toBe(false);
  }).pipe(Effect.provide(bff.browser));
});

it.effect('keeps an unavailable explanation in the form after toast notifications are dismissed', () => {
  const bff = signInAnswers(
    () =>
      Effect.fail(
        Schema.decodeUnknownSync(AuthenticationUnavailableProblemSchema)({
          ...problem,
          _tag: 'AuthenticationUnavailableProblem',
          status: 503,
        }),
      ),
    () => Effect.succeed(signedIn),
  );
  return Effect.gen(function* retainsUnavailableFeedback() {
    const router = loginRouter();
    const navigations = rstest.spyOn(router, 'navigate');
    const { runs, user } = yield* submitLogin('admin', 'secret', router);
    yield* pageEffectsSettled(runs);
    expect(screen.getByRole('alert').textContent).toContain('shell.login.error.unavailable');
    expect(getSubmit().hasAttribute('disabled')).toBe(false);
    toaster.remove();
    expect(screen.getByRole('alert').textContent).toContain('shell.login.error.unavailable');
    expect(getLogin()).toHaveProperty('value', 'admin');
    expect(getPassword()).toHaveProperty('value', '');
    yield* Effect.promise(() => user.type(getPassword(), 'secret'));
    yield* Effect.promise(() => user.click(getSubmit()));
    yield* pageEffectsSettled(runs);
    expect(screen.queryByText('shell.login.error.unavailable')).toBeNull();
    expect(navigations).toHaveBeenCalledWith({ to: '/en/' });
    expect(bff.requests.map((received) => received.endpoint)).toEqual(['signIn', 'signIn']);
  }).pipe(Effect.provide(bff.browser));
});

it.effect('keeps the login and clears only the password after rejected credentials', () => {
  const bff = signInAnswers(() =>
    Effect.fail(
      Schema.decodeUnknownSync(InvalidCredentialsProblemSchema)({
        ...problem,
        _tag: 'InvalidCredentialsProblem',
        status: 401,
      }),
    ),
  );
  return Effect.gen(function* keepsLoginAfterRejectedCredentials() {
    const { runs } = yield* submitLogin('admin', 'wrong');
    yield* pageEffectsSettled(runs);

    expect(screen.getByText('shell.login.error.invalid')).toBeDefined();
    expect(getSubmit().hasAttribute('disabled')).toBe(false);
    expect(getLogin()).toHaveProperty('value', 'admin');
    expect(getPassword()).toHaveProperty('value', '');
    expect(document.activeElement).toBe(getPassword());
  }).pipe(Effect.provide(bff.browser));
});
