/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- React handlers stay synchronous while Effect requests complete asynchronously. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { runEffectRequest, signIn } from '../../../api/auth-client.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

interface LoginValidation {
  loginMissing: boolean;
  passwordMissing: boolean;
}

const validLogin: LoginValidation = {
  loginMissing: false,
  passwordMissing: false,
};

const authenticationErrorMessageKey = (errorTag: unknown) => {
  if (errorTag === 'InvalidCredentialsProblem') {
    return 'shell.login.error.invalid';
  }
  if (errorTag === 'OntosIdentityForbiddenProblem') {
    return 'shell.login.error.forbidden';
  }
  if (errorTag === 'AuthenticationUnavailableProblem') {
    return 'shell.login.error.unavailable';
  }
  return 'shell.login.error.internal';
};

export default function LoginPage() {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const toaster = useToast();
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState<LoginValidation>(validLogin);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (submitting) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const login = formData.get('login');
    const password = formData.get('password');
    const loginValue = typeof login === 'string' ? login : '';
    const passwordValue = typeof password === 'string' ? password : '';
    const nextValidation = {
      loginMissing: loginValue.trim().length === 0,
      passwordMissing: passwordValue.length === 0,
    };

    setValidation(nextValidation);

    if (nextValidation.loginMissing || nextValidation.passwordMissing) {
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
      return;
    }

    setSubmitting(true);
    void runEffectRequest(
      signIn(
        {
          email: loginValue.trim(),
          password: passwordValue,
        },
        { locale: language },
      ),
    )
      .then(() => navigate({ to: `/${language}/` }))
      .catch((error: unknown) => {
        const errorTag =
          typeof error === 'object' && error !== null && '_tag' in error
            ? error._tag
            : 'AuthenticationInternalProblem';
        const messageKey = authenticationErrorMessageKey(errorTag);

        toaster.create({
          description: t(messageKey),
          title: t('shell.login.error.title'),
          type: 'error',
        });
        loginRef.current?.focus();
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <>
      <UltramodernRouteHead />
      <main className="flex min-h-screen items-center justify-center bg-(--color-page-bg) px-4 py-10 text-(--color-page-fg) md:px-20 md:pt-[120px] md:pb-10">
        <section className="flex w-full max-w-[360px] flex-col">
          <Link className="self-center" href={`/${language}`}>
            {t('shell.login.back')}
          </Link>
          <div className="mt-6">
            <h1 className="text-2xl font-bold">{t('shell.login.title')}</h1>
            <form className="mt-4 flex flex-col gap-4" noValidate onSubmit={handleSubmit}>
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
                helpText={
                  validation.passwordMissing ? t('shell.login.required.password') : undefined
                }
                id="password"
                label={t('shell.login.field.password')}
                name="password"
                ref={passwordRef}
                required
                type="password"
                validateStatus={validation.passwordMissing ? 'error' : 'default'}
              />
              <Button
                block
                disabled={submitting}
                isLoading={submitting}
                loadingText={t('shell.login.pending')}
                size="md"
                theme="solid"
                type="submit"
                variant="primary"
              >
                {t('shell.login.submit')}
              </Button>
            </form>
          </div>
        </section>
      </main>
      <Toaster />
    </>
  );
}
