import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

interface LoginValidation {
  loginMissing: boolean;
  passwordMissing: boolean;
}

const validLogin: LoginValidation = {
  loginMissing: false,
  passwordMissing: false,
};

export default function LoginPage() {
  const { t } = useModernI18n();
  const toaster = useToast();
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState<LoginValidation>(validLogin);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const login = formData.get('login');
    const password = formData.get('password');
    const nextValidation = {
      loginMissing: typeof login !== 'string' || login.trim().length === 0,
      passwordMissing: typeof password !== 'string' || password.length === 0,
    };

    setValidation(nextValidation);

    if (!nextValidation.loginMissing && !nextValidation.passwordMissing) {
      return;
    }

    toaster.create({
      description: t('shell.login.toast.description'),
      title: t('shell.login.toast.title'),
      type: 'error',
    });

    if (nextValidation.loginMissing) {
      loginRef.current?.focus();
      return;
    }

    passwordRef.current?.focus();
  };

  return (
    <>
      <UltramodernRouteHead />
      <main className="flex min-h-screen items-center justify-center bg-(--color-page-bg) px-4 py-10 text-(--color-page-fg)">
        <section className="w-full max-w-md bg-(--color-surface) p-6 sm:p-8">
          <h1 className="text-2xl font-bold">{t('shell.login.title')}</h1>
          <form className="mt-8 flex flex-col gap-6" noValidate onSubmit={handleSubmit}>
            <FormInput
              aria-invalid={validation.loginMissing || undefined}
              autoComplete="username"
              helpText={validation.loginMissing ? t('shell.login.required.login') : undefined}
              id="login"
              label={t('shell.login.field.login')}
              name="login"
              ref={loginRef}
              required
              type="text"
              validateStatus={validation.loginMissing ? 'error' : 'default'}
            />
            <FormInput
              aria-invalid={validation.passwordMissing || undefined}
              autoComplete="current-password"
              helpText={validation.passwordMissing ? t('shell.login.required.password') : undefined}
              id="password"
              label={t('shell.login.field.password')}
              name="password"
              ref={passwordRef}
              required
              type="password"
              validateStatus={validation.passwordMissing ? 'error' : 'default'}
            />
            <Button block size="md" theme="solid" type="submit" variant="primary">
              {t('shell.login.submit')}
            </Button>
          </form>
        </section>
      </main>
    </>
  );
}
