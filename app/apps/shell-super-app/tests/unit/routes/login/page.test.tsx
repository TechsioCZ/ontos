import { toaster } from '@techsio/ui-kit/molecules/toast';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Redacted } from 'effect';
import { afterEach, beforeEach, expect, rstest, it } from 'effect-rstest';

import LoginPage from '../../../../src/routes/[lang]/login/page';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts' with {
  rstest: 'importActual',
};
import type {
  LocalizedLinkCall,
  LocalizedLinkDoubleProps,
} from '../../../support/localized-link-double.tsx';
import { renderLocalizedLinkDouble } from '../../../support/localized-link-double.tsx';

const {
  browserRunPromiseMock,
  invalidateMock,
  languageState,
  localizedLinkCalls,
  navigateMock,
  signInMock,
} = rstest.hoisted(() => {
  const recordedLinkCalls: LocalizedLinkCall[] = [];
  return {
    browserRunPromiseMock: rstest.fn(),
    invalidateMock: rstest.fn(),
    languageState: { current: 'en' },
    localizedLinkCalls: recordedLinkCalls,
    navigateMock: rstest.fn(),
    signInMock: rstest.fn(),
  };
});

beforeEach(() => {
  invalidateMock.mockImplementation(() => Promise.resolve());
  navigateMock.mockImplementation(() => Promise.resolve());
  browserRunPromiseMock.mockImplementation(browserRuntime.runPromise);
  signInMock.mockReturnValue(
    Effect.succeed({
      identity: {
        displayName: 'Ada',
        email: 'ada@example.test',
        principalId: 'principal-1',
        tenantId: 'tenant-1',
      },
    })
  );
});

const translations = new Map(
  Object.entries({
    'shell.login.back': '← Back to the home page',
    'shell.login.field.login': 'Login',
    'shell.login.field.password': 'Password',
    'shell.login.required.login': 'Enter your login.',
    'shell.login.required.password': 'Enter your password.',
    'shell.login.submit': 'Login',
    'shell.login.title': 'Login',
    'shell.login.toast.description': 'Fill in both required fields.',
    'shell.login.toast.title': 'Login details are incomplete',
  })
);

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: (props: LocalizedLinkDoubleProps) =>
    renderLocalizedLinkDouble(props, {
      calls: localizedLinkCalls,
      language: languageState,
    }),
  useLocalizedLocation: () => ({
    alternates: {
      cs: '/cs/login',
      en: '/en/login',
    },
    canonical: '/en/login',
  }),
  useModernI18n: () => ({
    language: languageState.current,
    t: (key: string) => translations.get(key) ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ invalidate: invalidateMock }),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  signIn: signInMock,
}));

rstest.mock('../../../../src/runtime/browser-effect-runtime.ts', () => ({
  browserRuntime: { runPromise: browserRunPromiseMock },
}));

const getLogin = () => screen.getByRole('textbox', { name: 'Login *' });
const getPassword = () =>
  screen.getByLabelText(/^Password/u, { selector: 'input' });
const getSubmit = () => screen.getByRole('button', { name: 'Login' });

const renderLogin = () => render(<LoginPage />);

afterEach(() => {
  cleanup();
  languageState.current = 'en';
  localizedLinkCalls.length = 0;
  toaster.remove();
  rstest.unstubAllGlobals();
  rstest.clearAllMocks();
});

it('shows the required login controls through the UI kit', () => {
  render(<LoginPage />);

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
  expect(
    screen
      .getByRole('link', { name: '← Back to the home page' })
      .getAttribute('href')
  ).toBe('/en');
});

it('the back link hands the canonical home target to the framework link', () => {
  renderLogin();

  const homeCall = localizedLinkCalls.find((call) => call.to === '/');
  expect(homeCall).toBeDefined();
  expect(homeCall?.params).toBeUndefined();
  expect(homeCall?.href).toBeUndefined();
});

it('the back link resolves Czech from the same canonical target', () => {
  languageState.current = 'cs';
  renderLogin();

  expect(localizedLinkCalls.map((call) => call.to)).toContain('/');
  expect(
    screen
      .getByRole('link', { name: '← Back to the home page' })
      .getAttribute('href')
  ).toBe('/cs');
});

const submitLogin = (login: string, password: string) =>
  Effect.gen(function* submitLoginEffect() {
    const user = userEvent.setup();
    renderLogin();
    if (login.length > 0) {
      yield* Effect.promise(() => user.type(getLogin(), login));
    }
    if (password.length > 0) {
      yield* Effect.promise(() => user.type(getPassword(), password));
    }
    yield* Effect.promise(() => user.click(getSubmit()));
    return user;
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
  submit: getSubmit,
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
      yield* submitLogin(login, password);

      const incompleteToasts = loginInvalid || passwordInvalid ? 1 : 0;
      expect(getLogin().getAttribute('aria-invalid')).toBe(
        loginInvalid ? 'true' : null
      );
      expect(getPassword().getAttribute('aria-invalid')).toBe(
        passwordInvalid ? 'true' : null
      );
      expect(screen.queryAllByText('Enter your login.')).toHaveLength(
        loginInvalid ? 1 : 0
      );
      expect(screen.queryAllByText('Enter your password.')).toHaveLength(
        passwordInvalid ? 1 : 0
      );
      expect(
        screen.queryAllByText('Login details are incomplete')
      ).toHaveLength(incompleteToasts);
      expect(
        screen.queryAllByText('Fill in both required fields.')
      ).toHaveLength(incompleteToasts);
      expect(document.activeElement).toBe(focusTargets[focus]());
    })
);

it.effect('creates one Toast per repeated invalid submission', () =>
  Effect.gen(function* createsOneToastPerRepeatedInvalidSubmission() {
    const user = yield* submitLogin('', '');

    yield* Effect.promise(() => user.click(getSubmit()));
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(2);
    expect(screen.getAllByText('Fill in both required fields.')).toHaveLength(
      2
    );
  })
);

it.effect('clears stale errors after both fields are corrected', () =>
  Effect.gen(function* clearsStaleErrorsAfterBothFieldsCorrected() {
    const user = yield* submitLogin('', '');

    yield* Effect.promise(() => user.type(getLogin(), 'admin'));
    yield* Effect.promise(() => user.type(getPassword(), 'secret'));
    yield* Effect.promise(() => user.click(getSubmit()));
    expect(getLogin().getAttribute('aria-invalid')).toBeNull();
    expect(getPassword().getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('Enter your login.')).toBeNull();
    expect(screen.queryByText('Enter your password.')).toBeNull();
  })
);

it.effect('runs the same validation when submitted with Enter', () =>
  Effect.gen(function* runsTheSameValidationWhenSubmittedWithEnter() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.click(getLogin()));
    yield* Effect.promise(() => user.keyboard('{Enter}'));
    expect(getLogin().getAttribute('aria-invalid')).toBe('true');
    expect(getPassword().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
    expect(document.activeElement).toBe(getLogin());
  })
);

it.effect(
  'submits valid values through the Shell authentication client and navigates home',
  () =>
    Effect.gen(function* submitsValidValuesThroughShellAuthClient() {
      yield* submitLogin('admin', 'secret');

      yield* Effect.promise(() =>
        waitFor(() => {
          expect(signInMock).toHaveBeenCalledWith(
            {
              email: 'admin',
              password: Redacted.make('secret'),
            },
            { locale: 'en' }
          );
          expect(browserRunPromiseMock).toHaveBeenCalledTimes(1);
          expect(invalidateMock).toHaveBeenCalledWith({ sync: true });
          expect(navigateMock).toHaveBeenCalledWith({ to: '/en/' });
          expect(getSubmit().hasAttribute('disabled')).toBe(false);
          expect(screen.queryByText('shell.login.error.internal')).toBeNull();
          expect(screen.queryByText('Login details are incomplete')).toBeNull();
        })
      );
    })
);

it.effect(
  'reports navigation failure and restores the login form after authentication',
  () =>
    Effect.gen(function* reportsNavigationFailure() {
      navigateMock.mockRejectedValueOnce('Navigation failed');
      yield* submitLogin('admin', 'secret');

      yield* Effect.promise(() =>
        waitFor(() => {
          expect(navigateMock).toHaveBeenCalledWith({ to: '/en/' });
          expect(screen.getByText('shell.login.error.internal')).toBeDefined();
          expect(getSubmit().hasAttribute('disabled')).toBe(false);
          expect(document.activeElement).toBe(getLogin());
        })
      );
    })
);

it.effect(
  'keeps navigation on the login route when auth cache refresh fails',
  () =>
    Effect.gen(function* reportsAuthenticationRefreshFailure() {
      invalidateMock.mockRejectedValueOnce('Route refresh failed');
      yield* submitLogin('admin', 'secret');
      yield* Effect.promise(() =>
        waitFor(() => {
          expect(invalidateMock).toHaveBeenCalledWith({ sync: true });
          expect(navigateMock).not.toHaveBeenCalled();
          expect(screen.getByText('shell.login.error.internal')).toBeDefined();
          expect(getSubmit().hasAttribute('disabled')).toBe(false);
        })
      );
    })
);
