import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { Effect, Redacted } from 'effect';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import LoginPage from '../../../../src/routes/[lang]/login/page';

const { navigateMock, runBrowserEffectMock, signInMock } = rstest.hoisted(() => ({
  navigateMock: rstest.fn(async () => {}),
  runBrowserEffectMock: rstest.fn(),
  signInMock: rstest.fn(),
}));

beforeEach(() => {
  runBrowserEffectMock.mockImplementation(
    async (effect: Effect.Effect<unknown, unknown>) => await runEffectTestPromise(effect),
  );
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
  runBrowserEffect: runBrowserEffectMock,
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

test('shows the required login controls through the UI kit', () => {
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

const submitLogin = async (login: string, password: string) => {
  const user = userEvent.setup();
  renderLogin();
  if (login.length > 0) {
    await user.type(getLogin(), login);
  }
  if (password.length > 0) {
    await user.type(getPassword(), password);
  }
  await user.click(getSubmit());
  return user;
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

test.each(validationCases)(
  'marks, explains and focuses exactly the missing fields when $name',
  async ({ focus, login, loginInvalid, password, passwordInvalid }) => {
    await submitLogin(login, password);

    const incompleteToasts = loginInvalid || passwordInvalid ? 1 : 0;
    expect(getLogin().getAttribute('aria-invalid')).toBe(loginInvalid ? 'true' : null);
    expect(getPassword().getAttribute('aria-invalid')).toBe(passwordInvalid ? 'true' : null);
    expect(screen.queryAllByText('Enter your login.')).toHaveLength(loginInvalid ? 1 : 0);
    expect(screen.queryAllByText('Enter your password.')).toHaveLength(passwordInvalid ? 1 : 0);
    expect(screen.queryAllByText('Login details are incomplete')).toHaveLength(incompleteToasts);
    expect(screen.queryAllByText('Fill in both required fields.')).toHaveLength(incompleteToasts);
    expect(document.activeElement).toBe(focusTargets[focus]());
  },
);

test('creates one Toast per repeated invalid submission', async () => {
  const user = await submitLogin('', '');

  await user.click(getSubmit());

  expect(screen.getAllByText('Login details are incomplete')).toHaveLength(2);
  expect(screen.getAllByText('Fill in both required fields.')).toHaveLength(2);
});

test('clears stale errors after both fields are corrected', async () => {
  const user = await submitLogin('', '');

  await user.type(getLogin(), 'admin');
  await user.type(getPassword(), 'secret');
  await user.click(getSubmit());

  expect(getLogin().getAttribute('aria-invalid')).toBeNull();
  expect(getPassword().getAttribute('aria-invalid')).toBeNull();
  expect(screen.queryByText('Enter your login.')).toBeNull();
  expect(screen.queryByText('Enter your password.')).toBeNull();
});

test('runs the same validation when submitted with Enter', async () => {
  const user = userEvent.setup();
  renderLogin();

  await user.click(getLogin());
  await user.keyboard('{Enter}');

  expect(getLogin().getAttribute('aria-invalid')).toBe('true');
  expect(getPassword().getAttribute('aria-invalid')).toBe('true');
  expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
  expect(document.activeElement).toBe(getLogin());
});

test('submits valid values through the Shell authentication client and navigates home', async () => {
  await submitLogin('admin', 'secret');

  await waitFor(() => {
    expect(signInMock).toHaveBeenCalledWith(
      {
        email: 'admin',
        password: Redacted.make('secret'),
      },
      { locale: 'en' },
    );
    expect(runBrowserEffectMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith({ to: '/en/' });
    expect(screen.queryByText('Login details are incomplete')).toBeNull();
  });
});
