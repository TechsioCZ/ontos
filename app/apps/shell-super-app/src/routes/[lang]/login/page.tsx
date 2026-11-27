import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useRouter } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import type { Cause } from 'effect';
import { useRef, useState } from 'react';

import { SignInPayloadSchema } from '../../../../shared/browser-api.ts';
import { signIn } from '../../../api/auth-client.ts';
import type { ShellAuthenticationClientError } from '../../../api/auth-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { useHydrated } from '../../use-hydrated.ts';

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
    Match.tag('AuthenticationInternalProblem', 'HttpClientError', 'SchemaError', () => internalErrorMessageKey),
    Match.exhaustive,
  );

const LoginPage = () => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const router = useRouter();
  const toaster = useToast();
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState<LoginValidation>(validLogin);
  const [submitting, setSubmitting] = useState(false);
  const hydrated = useHydrated();
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
    const credentials = Schema.decodeOption(SignInFormSchema)(formData);
    if (Option.isNone(credentials)) {
      toaster.create({
        description: t(internalErrorMessageKey),
        title: t(errorTitleKey),
        type: 'error',
      });
      return;
    }

    setSubmitting(true);
    void browserRuntime.runPromise(
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
            Effect.tryPromise(() => router.invalidate({ sync: true })).pipe(
              Effect.andThen(Effect.tryPromise(() => navigate({ to: `/${language}/` }))),
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
      <main className="flex min-h-screen items-center justify-center bg-base px-200 py-450 text-fg-primary md:px-750 md:pt-950 md:pb-450">
        <section className="flex w-full max-w-sm flex-col">
          <Link as={LocalizedLink} className="self-center" to="/">
            {t('shell.login.back')}
          </Link>
          <div className="mt-300">
            <h1 className="text-2xl font-bold">{t('shell.login.title')}</h1>
            <form
              action={handleSubmit}
              className="mt-200 flex flex-col gap-200"
              data-hydrated={hydrated || undefined}
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
                helpText={validation.passwordMissing ? t('shell.login.required.password') : undefined}
                id="password"
                label={t('shell.login.field.password')}
                name="password"
                ref={passwordRef}
                required
                type="password"
                validateStatus={validation.passwordMissing ? 'error' : 'default'}
              />
              <Button
                appearance="solid"
                block
                disabled={submitting}
                isLoading={submitting}
                loadingText={t('shell.login.pending')}
                severity="primary"
                size="md"
                type="submit"
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
