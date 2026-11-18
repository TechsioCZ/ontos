import { toaster } from '@techsio/ui-kit/molecules/toast';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Latch, Redacted, Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import { SignInResponseSchema } from '../../../../shared/browser-api.ts';
import LoginPage from '../../../../src/routes/[lang]/login/page';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import { shellTestCopy } from '../../../support/shell-i18n.tsx';
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

/** The login route of a real router, in the given language. */
const loginRouter = (language: ShellLanguage = 'en') =>
  makeShellRouter({ page: { component: LoginPage, path: 'login' }, url: `/${language}/login` });
const renderLogin = (router: ShellRouter = loginRouter(), language: ShellLanguage = 'en') =>
  renderShellRoute(router, shellTestCopy(language, copy));

const getLogin = () => screen.getByRole('textbox', { name: 'Login *' });
const getPassword = () => screen.getByLabelText(/^Password/u, { selector: 'input' });
const getSubmit = () => screen.getByRole('button', { name: 'Login' });
/** The submit control, idle or announcing the sign-in it started. */
const getSubmitControl = () => screen.getByRole('button', { name: /^(?:Login|Signing in…)$/u });

afterEach(() => {
  cleanup();
  toaster.remove();
});

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

it.effect('the back link resolves Czech from the same canonical target', () =>
  Effect.gen(function* czechBackLink() {
    yield* renderLogin(loginRouter('cs'), 'cs');

    expect(screen.getByRole('link', { name: '← Back to the home page' }).getAttribute('href')).toBe('/cs');
  }),
);

/** Every Effect the page has handed to the browser runtime, settled. */
const pageEffectsSettled = (runs: { readonly mock: { readonly results: readonly { readonly value: unknown }[] } }) =>
  Effect.promise(() => Promise.allSettled(runs.mock.results.map((result) => result.value)));

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
    return { runs, user };
  });

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
