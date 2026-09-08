import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts' with {
  rstest: 'importActual',
};
import { afterEach, beforeEach, expect, rstest, it } from 'effect-rstest';
import { Effect, Redacted } from 'effect';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import LoginPage from '../../../../src/routes/[lang]/login/page';

const { browserRunPromiseMock, navigateMock, signInMock } = rstest.hoisted(() => ({
  browserRunPromiseMock: rstest.fn(),
  navigateMock: rstest.fn(),
  signInMock: rstest.fn(),
}));

beforeEach(() => {
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
    }),
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
  }),
);

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useLocalizedLocation: () => ({
    alternates: {
      cs: '/cs/login',
      en: '/en/login',
    },
    canonical: '/en/login',
  }),
  useModernI18n: () => ({
    language: 'en',
    t: (key: string) => translations.get(key) ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useNavigate: () => navigateMock,
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  signIn: signInMock,
}));

rstest.mock('../../../../src/runtime/browser-effect-runtime.ts', () => ({
  browserRuntime: { runPromise: browserRunPromiseMock },
}));

const getLogin = () => screen.getByRole('textbox', { name: 'Login *' });
const getPassword = () => screen.getByLabelText(/^Password/u, { selector: 'input' });
const getSubmit = () => screen.getByRole('button', { name: 'Login' });

const renderLogin = () => render(<LoginPage />);

afterEach(() => {
  cleanup();
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
  expect(screen.getByRole('link', { name: '← Back to the home page' }).getAttribute('href')).toBe(
    '/en',
  );
});

it.effect('shows both field errors and one Toast when both values are missing', () =>
  Effect.gen(function* showsBothFieldErrorsAndOneToast() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.click(getSubmit()));
    const login = getLogin();
    const password = getPassword();

    expect(login.getAttribute('aria-invalid')).toBe('true');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter your login.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
    expect(screen.getByText('Fill in both required fields.')).toBeTruthy();
    expect(document.activeElement).toBe(login);
  }),
);

it.effect('creates one Toast per repeated invalid submission', () =>
  Effect.gen(function* createsOneToastPerRepeatedInvalidSubmission() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.click(getSubmit()));
    yield* Effect.promise(() => user.click(getSubmit()));
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(2);
    expect(screen.getAllByText('Fill in both required fields.')).toHaveLength(2);
  }),
);

it.effect('shows only the Login error when the password is present', () =>
  Effect.gen(function* showsOnlyTheLoginErrorWhenPasswordPresent() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.type(getPassword(), 'secret'));
    yield* Effect.promise(() => user.click(getSubmit()));
    expect(getLogin().getAttribute('aria-invalid')).toBe('true');
    expect(getPassword().getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByText('Enter your login.')).toBeTruthy();
    expect(screen.queryByText('Enter your password.')).toBeNull();
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
    expect(document.activeElement).toBe(getLogin());
  }),
);

it.effect('shows only the Password error when the login is present', () =>
  Effect.gen(function* showsOnlyThePasswordErrorWhenLoginPresent() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.type(getLogin(), 'admin'));
    yield* Effect.promise(() => user.click(getSubmit()));
    expect(getLogin().getAttribute('aria-invalid')).toBeNull();
    expect(getPassword().getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText('Enter your login.')).toBeNull();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
    expect(document.activeElement).toBe(getPassword());
  }),
);

it.effect('treats a whitespace-only Login as missing', () =>
  Effect.gen(function* treatsAWhitespaceOnlyLoginAsMissing() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.type(getLogin(), '   '));
    yield* Effect.promise(() => user.type(getPassword(), 'secret'));
    yield* Effect.promise(() => user.click(getSubmit()));
    expect(getLogin().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter your login.')).toBeTruthy();
    expect(document.activeElement).toBe(getLogin());
  }),
);

it.effect('accepts a non-empty whitespace Password', () =>
  Effect.gen(function* acceptsANonEmptyWhitespacePassword() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.type(getLogin(), 'admin'));
    yield* Effect.promise(() => user.type(getPassword(), ' '));
    yield* Effect.promise(() => user.click(getSubmit()));
    expect(getLogin().getAttribute('aria-invalid')).toBeNull();
    expect(getPassword().getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('Login details are incomplete')).toBeNull();
  }),
);

it.effect('clears stale errors after both fields are corrected', () =>
  Effect.gen(function* clearsStaleErrorsAfterBothFieldsCorrected() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.click(getSubmit()));
    yield* Effect.promise(() => user.type(getLogin(), 'admin'));
    yield* Effect.promise(() => user.type(getPassword(), 'secret'));
    yield* Effect.promise(() => user.click(getSubmit()));
    expect(getLogin().getAttribute('aria-invalid')).toBeNull();
    expect(getPassword().getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('Enter your login.')).toBeNull();
    expect(screen.queryByText('Enter your password.')).toBeNull();
  }),
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
  }),
);

it.effect('submits valid values through the Shell authentication client and navigates home', () =>
  Effect.gen(function* submitsValidValuesThroughShellAuthClient() {
    const user = userEvent.setup();
    renderLogin();

    yield* Effect.promise(() => user.type(getLogin(), 'admin'));
    yield* Effect.promise(() => user.type(getPassword(), 'secret'));
    yield* Effect.promise(() => user.click(getSubmit()));
    yield* Effect.promise(() =>
      waitFor(() => {
        expect(signInMock).toHaveBeenCalledWith(
          {
            email: 'admin',
            password: Redacted.make('secret'),
          },
          { locale: 'en' },
        );
        expect(browserRunPromiseMock).toHaveBeenCalledTimes(1);
        expect(navigateMock).toHaveBeenCalledWith({ to: '/en/' });
        expect(getSubmit().hasAttribute('disabled')).toBe(false);
        expect(screen.queryByText('shell.login.error.internal')).toBeNull();
        expect(screen.queryByText('Login details are incomplete')).toBeNull();
      }),
    );
  }),
);

it.effect('reports navigation failure and restores the login form after authentication', () =>
  Effect.gen(function* reportsNavigationFailure() {
    navigateMock.mockRejectedValueOnce('Navigation failed');
    const user = userEvent.setup();
    renderLogin();
    yield* Effect.promise(() => user.type(getLogin(), 'admin'));
    yield* Effect.promise(() => user.type(getPassword(), 'secret'));
    yield* Effect.promise(() => user.click(getSubmit()));
    yield* Effect.promise(() =>
      waitFor(() => {
        expect(navigateMock).toHaveBeenCalledWith({ to: '/en/' });
        expect(screen.getByText('shell.login.error.internal')).toBeDefined();
        expect(getSubmit().hasAttribute('disabled')).toBe(false);
        expect(document.activeElement).toBe(getLogin());
      }),
    );
  }),
);
