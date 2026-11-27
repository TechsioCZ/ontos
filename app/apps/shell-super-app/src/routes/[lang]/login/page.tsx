import { FormReact, FormRoot, SubmitButton, TextField, fromPayload, useAtomSubscribe } from '@app/core-runtime/ui/form';
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useRouter } from '@modern-js/plugin-tanstack/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Match, Option, Schema, SchemaIssue } from 'effect';
import type { Cause } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useRef, useState } from 'react';

import { signIn } from '../../../api/auth-client.ts';
import type { ShellAuthenticationClientError } from '../../../api/auth-client.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { useHydrated } from '../../use-hydrated.ts';

const internalErrorMessageKey = 'shell.login.error.internal';
const errorTitleKey = 'shell.login.error.title';

/** Why the Shell refused the credentials; each reason names its `shell.login.error.*` message. */
class SignInRefused extends Schema.TaggedError<SignInRefused>()('SignInRefused', {
  reason: Schema.Literals(['invalid', 'forbidden', 'unavailable', 'internal']),
}) {}

const refusal = (failure: ShellAuthenticationClientError) =>
  new SignInRefused({
    reason: Match.value(failure).pipe(
      Match.tag('InvalidCredentialsProblem', () => 'invalid' as const),
      Match.tag('OntosIdentityForbiddenProblem', () => 'forbidden' as const),
      Match.tag('AuthenticationUnavailableProblem', () => 'unavailable' as const),
      Match.tag('AuthenticationInternalProblem', 'HttpClientError', 'SchemaError', () => 'internal' as const),
      Match.exhaustive,
    ),
  });

/**
 * The sign-in payload as the person types it: the login is trimmed, the password is redacted once
 * decoded, and the request carries the page language.
 */
const loginForm = FormReact.make(
  fromPayload(
    Schema.Struct({
      email: Schema.Trim.check(Schema.isMinLength(1, { message: 'shell.login.required.login' })),
      locale: Schema.String,
      password: Schema.RedactedFromValue(
        Schema.String.check(Schema.isMinLength(1, { message: 'shell.login.required.password' })),
      ),
    }),
  ),
  {
    fields: { email: TextField, locale: TextField, password: TextField },
    onSubmit: (_submit, { decoded: { locale, ...credentials } }) =>
      signIn(credentials, { locale }).pipe(Effect.mapError(refusal)),
    runtime: browserAtomRuntime,
  },
);

const LoginFieldSchema = Schema.Literals(['login', 'password']);
type LoginField = typeof LoginFieldSchema.Type;
/** The first field a failed validation names: the login before the password. */
const firstMissingField = (error: Schema.SchemaError): LoginField =>
  SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.some((issue) => issue.path?.[0] === 'email')
    ? 'login'
    : 'password';

const LoginPage = () => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const router = useRouter();
  const toaster = useToast();
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // A request, not a flag: every failed attempt focuses its field again once the form is enabled.
  const [focusRequest, setFocusRequest] = useState<{ readonly field: LoginField } | null>(null);
  const [navigating, setNavigating] = useState(false);
  const hydrated = useHydrated();
  useEffect(() => {
    if (focusRequest !== null) {
      (focusRequest.field === 'login' ? loginRef : passwordRef).current?.focus();
    }
  }, [focusRequest]);
  const reportFailure = (description: string, field: LoginField) => {
    toaster.create({ description: t(description), title: t(errorTitleKey), type: 'error' });
    setFocusRequest({ field });
  };
  const enterShell = () => {
    setNavigating(true);
    void browserRuntime.runPromise(
      Effect.tryPromise(() => router.invalidate({ sync: true })).pipe(
        Effect.andThen(Effect.tryPromise(() => navigate({ to: `/${language}/` }))),
        Effect.timeout('10 seconds'),
        Effect.matchEffect({
          onFailure: (failure: Cause.TimeoutError | Cause.UnknownError) =>
            Effect.sync(() => {
              void failure;
              reportFailure(internalErrorMessageKey, 'login');
            }),
          onSuccess: Effect.succeed,
        }),
        Effect.ensuring(Effect.sync(() => setNavigating(false))),
      ),
    );
  };
  useAtomSubscribe(loginForm.submit, (result) => {
    if (result.waiting) {
      return;
    }
    if (AsyncResult.isSuccess(result)) {
      enterShell();
      return;
    }
    const failure = AsyncResult.error(result);
    if (Option.isNone(failure)) {
      return;
    }
    if (Schema.isSchemaError(failure.value)) {
      toaster.create({
        description: t('shell.login.toast.description'),
        title: t('shell.login.toast.title'),
        type: 'error',
      });
      setFocusRequest({ field: firstMissingField(failure.value) });
      return;
    }
    reportFailure(`shell.login.error.${failure.value.reason}`, 'login');
  });

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
            <FormRoot
              className="mt-200 flex flex-col gap-200"
              data-hydrated={hydrated || undefined}
              defaultValues={{ email: '', locale: language, password: '' }}
              form={loginForm}
              key={language}
              translateMessage={(message) => t(message, { defaultValue: t(internalErrorMessageKey) })}
            >
              <loginForm.email
                autoComplete="username"
                id="login"
                label={t('shell.login.field.login')}
                name="login"
                ref={loginRef}
                required
                type="text"
              />
              <loginForm.password
                autoComplete="current-password"
                id="password"
                label={t('shell.login.field.password')}
                name="password"
                ref={passwordRef}
                required
                type="password"
              />
              <SubmitButton
                appearance="solid"
                block
                disabled={navigating}
                loadingText={t('shell.login.pending')}
                severity="primary"
                size="md"
              >
                {t('shell.login.submit')}
              </SubmitButton>
            </FormRoot>
          </div>
        </section>
      </main>
      <Toaster />
    </>
  );
};

export default LoginPage;
