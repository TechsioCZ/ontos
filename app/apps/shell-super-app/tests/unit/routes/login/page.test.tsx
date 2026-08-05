import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import LoginPage from '../../../../src/routes/[lang]/login/page';

const { navigateMock, runEffectRequestMock, signInMock } = rstest.hoisted(() => ({
  navigateMock: rstest.fn(() => Promise.resolve()),
  runEffectRequestMock: rstest.fn(() =>
    Promise.resolve({
      identity: {
        displayName: 'Ada',
        email: 'ada@example.test',
        principalId: 'principal-1',
        tenantId: 'tenant-1',
      },
    }),
  ),
  signInMock: rstest.fn(() => ({ operation: 'signIn' })),
}));

const translations: Record<string, string> = {
  'shell.login.back': '← Back to the home page',
  'shell.login.field.login': 'Login',
  'shell.login.field.password': 'Password',
  'shell.login.required.login': 'Enter your login.',
  'shell.login.required.password': 'Enter your password.',
  'shell.login.submit': 'Login',
  'shell.login.title': 'Login',
  'shell.login.toast.description': 'Fill in both required fields.',
  'shell.login.toast.title': 'Login details are incomplete',
};

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
    t: (key: string) => translations[key] ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useNavigate: () => navigateMock,
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  runEffectRequest: runEffectRequestMock,
  signIn: signInMock,
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

test('shows both field errors and one Toast when both values are missing', () => {
  const user = userEvent.setup();
  renderLogin();

  return user.click(getSubmit()).then(() => {
    const login = getLogin();
    const password = getPassword();

    expect(login.getAttribute('aria-invalid')).toBe('true');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter your login.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
    expect(screen.getByText('Fill in both required fields.')).toBeTruthy();
    expect(document.activeElement).toBe(login);
  });
});

test('creates one Toast per repeated invalid submission', () => {
  const user = userEvent.setup();
  renderLogin();

  return user
    .click(getSubmit())
    .then(() => user.click(getSubmit()))
    .then(() => {
      expect(screen.getAllByText('Login details are incomplete')).toHaveLength(2);
      expect(screen.getAllByText('Fill in both required fields.')).toHaveLength(2);
    });
});

test('shows only the Login error when the password is present', () => {
  const user = userEvent.setup();
  renderLogin();

  return user
    .type(getPassword(), 'secret')
    .then(() => user.click(getSubmit()))
    .then(() => {
      expect(getLogin().getAttribute('aria-invalid')).toBe('true');
      expect(getPassword().getAttribute('aria-invalid')).toBeNull();
      expect(screen.getByText('Enter your login.')).toBeTruthy();
      expect(screen.queryByText('Enter your password.')).toBeNull();
      expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
      expect(document.activeElement).toBe(getLogin());
    });
});

test('shows only the Password error when the login is present', () => {
  const user = userEvent.setup();
  renderLogin();

  return user
    .type(getLogin(), 'admin')
    .then(() => user.click(getSubmit()))
    .then(() => {
      expect(getLogin().getAttribute('aria-invalid')).toBeNull();
      expect(getPassword().getAttribute('aria-invalid')).toBe('true');
      expect(screen.queryByText('Enter your login.')).toBeNull();
      expect(screen.getByText('Enter your password.')).toBeTruthy();
      expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
      expect(document.activeElement).toBe(getPassword());
    });
});

test('treats a whitespace-only Login as missing', () => {
  const user = userEvent.setup();
  renderLogin();

  return user
    .type(getLogin(), '   ')
    .then(() => user.type(getPassword(), 'secret'))
    .then(() => user.click(getSubmit()))
    .then(() => {
      expect(getLogin().getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByText('Enter your login.')).toBeTruthy();
      expect(document.activeElement).toBe(getLogin());
    });
});

test('accepts a non-empty whitespace Password', () => {
  const user = userEvent.setup();
  renderLogin();

  return user
    .type(getLogin(), 'admin')
    .then(() => user.type(getPassword(), ' '))
    .then(() => user.click(getSubmit()))
    .then(() => {
      expect(getLogin().getAttribute('aria-invalid')).toBeNull();
      expect(getPassword().getAttribute('aria-invalid')).toBeNull();
      expect(screen.queryByText('Login details are incomplete')).toBeNull();
    });
});

test('clears stale errors after both fields are corrected', () => {
  const user = userEvent.setup();
  renderLogin();

  return user
    .click(getSubmit())
    .then(() => user.type(getLogin(), 'admin'))
    .then(() => user.type(getPassword(), 'secret'))
    .then(() => user.click(getSubmit()))
    .then(() => {
      expect(getLogin().getAttribute('aria-invalid')).toBeNull();
      expect(getPassword().getAttribute('aria-invalid')).toBeNull();
      expect(screen.queryByText('Enter your login.')).toBeNull();
      expect(screen.queryByText('Enter your password.')).toBeNull();
    });
});

test('runs the same validation when submitted with Enter', () => {
  const user = userEvent.setup();
  renderLogin();

  return user
    .click(getLogin())
    .then(() => user.keyboard('{Enter}'))
    .then(() => {
      expect(getLogin().getAttribute('aria-invalid')).toBe('true');
      expect(getPassword().getAttribute('aria-invalid')).toBe('true');
      expect(screen.getAllByText('Login details are incomplete')).toHaveLength(1);
      expect(document.activeElement).toBe(getLogin());
    });
});

test('submits valid values through the Shell authentication client and navigates home', () => {
  const user = userEvent.setup();
  renderLogin();

  return user
    .type(getLogin(), 'admin')
    .then(() => user.type(getPassword(), 'secret'))
    .then(() => user.click(getSubmit()))
    .then(() => {
      expect(signInMock).toHaveBeenCalledWith(
        {
          email: 'admin',
          password: 'secret',
        },
        { locale: 'en' },
      );
      expect(runEffectRequestMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith({ to: '/en/' });
      expect(screen.queryByText('Login details are incomplete')).toBeNull();
    });
});
