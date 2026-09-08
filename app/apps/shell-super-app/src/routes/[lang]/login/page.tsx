import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import type { Cause } from 'effect';
import { useRef, useState } from 'react';

import { SignInPayloadSchema } from '../../../../shared/api.ts';
import { signIn } from '../../../api/auth-client.ts';
import type { ShellAuthenticationClientError } from '../../../api/auth-client.ts';
import { runBrowserEffect } from '../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

interface LoginValidation {
  loginMissing: boolean;
  passwordMissing: boolean;
}

const validLogin: LoginValidation = {
  loginMissing: false,
  passwordMissing: false,
};

const SignInFormSchema = Schema.fromFormData(
  Schema.Struct({
    email: SignInPayloadSchema.fields.email,
    password: Schema.RedactedFromValue(SignInPayloadSchema.fields.password.value),
  }).pipe(Schema.encodeKeys({ email: 'login' })),
);
const internalErrorMessageKey = 'shell.login.error.internal';
const errorTitleKey = 'shell.login.error.title';

const authenticationErrorMessageKey = (error: ShellAuthenticationClientError) =>
  Match.value(error).pipe(
    Match.tag('InvalidCredentialsProblem', () => 'shell.login.error.invalid' as const),
    Match.tag('OntosIdentityForbiddenProblem', () => 'shell.login.error.forbidden' as const),
    Match.tag('AuthenticationUnavailableProblem', () => 'shell.login.error.unavailable' as const),
    Match.tag(
      'AuthenticationInternalProblem',
      'HttpClientError',
      'SchemaError',
      () => internalErrorMessageKey,
    ),
    Match.exhaustive,
  );

const LoginPage = () => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const toaster = useToast();
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState<LoginValidation>(validLogin);
  const [submitting, setSubmitting] = useState(false);
  const handleNavigationFailure = (error: Cause.TimeoutError | Cause.UnknownError) =>
    Effect.sync(() => {
      void error;
      toaster.create({
        description: t(internalErrorMessageKey),
        title: t(errorTitleKey),
        type: 'error',
      });
      loginRef.current?.focus();
    });

  const handleSubmit = (formData: FormData) => {
    if (submitting) {
      return;
    }

    const login = formData.get('login');
    const password = formData.get('password');
    const loginValue = Predicate.isString(login) ? login : '';
    const passwordValue = Predicate.isString(password) ? password : '';
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

    formData.set('login', loginValue.trim());
    const credentials = Schema.decodeUnknownOption(SignInFormSchema)(formData);
    if (Option.isNone(credentials)) {
      toaster.create({
        description: t(internalErrorMessageKey),
        title: t(errorTitleKey),
        type: 'error',
      });
      return;
    }

    setSubmitting(true);
    void runBrowserEffect(
      signIn(credentials.value, { locale: language }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              toaster.create({
                description: t(authenticationErrorMessageKey(error)),
                title: t(errorTitleKey),
                type: 'error',
              });
              loginRef.current?.focus();
            }),
          onSuccess: () =>
            Effect.tryPromise(() => navigate({ to: `/${language}/` })).pipe(
              Effect.timeout('10 seconds'),
              Effect.matchEffect({
                onFailure: handleNavigationFailure,
                onSuccess: Effect.succeed,
              }),
            ),
        }),
        Effect.ensuring(Effect.sync(() => setSubmitting(false))),
      ),
    );
  };

  return (
    <>
      <UltramodernRouteHead />
      <main className="shell:flex shell:min-h-screen shell:items-center shell:justify-center shell:bg-(--color-page-bg) shell:px-4 shell:py-10 shell:text-(--color-page-fg) shell:md:px-20 shell:md:pt-[120px] shell:md:pb-10">
        <section className="shell:flex shell:w-full shell:max-w-[360px] shell:flex-col">
          <Link as={LocalizedLink} className="shell:self-center" to="/">
            {t('shell.login.back')}
          </Link>
          <div className="shell:mt-6">
            <h1 className="shell:text-2xl shell:font-bold">{t('shell.login.title')}</h1>
            <form
              action={handleSubmit}
              className="shell:mt-4 shell:flex shell:flex-col shell:gap-4"
              noValidate
            >
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
};

export default LoginPage;
