// @effect-diagnostics globalFetch:off preferSchemaOverJson:off -- Browser boundary: before sign-in the login page asks Better Auth for the public name of the OAuth client that requests access. expires: 2027-03-31.
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useRouter } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import type { Cause } from 'effect';
import { useEffect, useRef, useState } from 'react';

import { SignInPayloadSchema } from '../../../../shared/api.ts';
import { signIn } from '../../../api/auth-client.ts';
import type { ShellAuthenticationClientError } from '../../../api/auth-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { forgetRecordedPageReads } from '../../browser-request-cache.ts';
import { signInReason, signInReturnPath } from '../../sign-in-return.ts';
import type { SignInReason } from '../../sign-in-return.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { clientNameFrom, OAUTH_PRELOGIN_PATH, readOAuthLoginRequest } from './oauth-handoff.ts';
import type { OAuthLoginRequest } from './oauth-handoff.ts';

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
  // After a successful sign-in the URL moves at once, but this form stays on screen until the next page has loaded.
  // The button then says the app is opening instead of still claiming to sign in.
  const [attempt, setAttempt] = useState<'idle' | 'opening' | 'signing-in'>('idle');
  // A form action resets its uncontrolled fields after every attempt; keep the login so only the password is retyped.
  const [attemptedLogin, setAttemptedLogin] = useState('');
  // Keep failures next to the form until retry; a short-lived toast is easy to miss during an outage.
  const [submissionError, setSubmissionError] = useState<string>();
  // A dead session (disabled account, session no longer accepted) arrives here with a reason; say why once.
  // A protected page opened without signing in arrives with only the page to return to: "not signed in".
  // Read after mount: the server render has no browser URL, so both renders start without the notice.
  const [reason, setReason] = useState<SignInReason | 'sign_in_required'>();
  const [oauthRequest, setOAuthRequest] = useState<OAuthLoginRequest>();
  const [oauthClientName, setOAuthClientName] = useState<string>();
  useEffect(() => {
    const { href } = window.location;
    setReason(
      signInReason(href) ?? (signInReturnPath(href, language) === undefined ? undefined : 'sign_in_required'),
    );
    setOAuthRequest(readOAuthLoginRequest(href));
  }, [language]);
  useEffect(() => {
    if (oauthRequest === undefined) {
      return;
    }
    let active = true;
    void fetch(OAUTH_PRELOGIN_PATH, {
      body: JSON.stringify({ client_id: oauthRequest.clientId, oauth_query: oauthRequest.signedQuery }),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
      .then((response): Promise<unknown> | undefined => (response.ok ? response.json() : undefined))
      .then((body: unknown) => {
        if (active) {
          setOAuthClientName(clientNameFrom(body));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [oauthRequest]);
  const handleNavigationFailure = (error: Cause.TimeoutError | Cause.UnknownError) =>
    Effect.sync(() => {
      void error;
      setSubmissionError(internalErrorMessageKey);
      loginRef.current?.focus();
    });

  const handleSubmit = (formData: FormData) => {
    if (attempt !== 'idle') {
      return;
    }

    const login = formData.get('login');
    const password = formData.get('password');
    const loginValue = Predicate.isString(login) ? login : '';
    const passwordValue = Predicate.isString(password) ? password : '';
    setSubmissionError(undefined);
    setAttemptedLogin(loginValue.trim());
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

    // A sign-in attempt supersedes the feedback of earlier attempts, so stale validation toasts go away.
    toaster.dismiss();
    setAttempt('signing-in');
    void browserRuntime.runPromise(
      signIn(credentials.value, { locale: language }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              setSubmissionError(authenticationErrorMessageKey(error));
              // The login stays filled after a failed attempt, so the retry starts at the password.
              passwordRef.current?.focus();
            }),
          onSuccess: () =>
            oauthRequest === undefined
              ? Effect.andThen(
                  forgetRecordedPageReads,
                  Effect.tryPromise(() => {
                    // Signed in: what remains is loading the next page, which can take a few seconds.
                    setAttempt('opening');
                    return router.invalidate({ sync: true });
                  }).pipe(
                    Effect.andThen(
                      Effect.tryPromise(() => {
                        // Cached pages hold anonymous loader data; an invalidated cached page would render that stale
                        // data while it reloads in the background, so the signed-in user would briefly see the
                        // logged-out view. Without a cache entry the next page loads before it renders.
                        router.clearCache();
                        // A protected deep link sent the visitor here; return there instead of the home page.
                        const returnPath = signInReturnPath(window.location.href, language);
                        return navigate(returnPath === undefined ? { to: `/${language}/` } : { href: returnPath });
                      }),
                    ),
                    Effect.timeout('10 seconds'),
                    Effect.matchEffect({
                      onFailure: handleNavigationFailure,
                      onSuccess: Effect.succeed,
                    }),
                  ),
                )
              : // OAuth connect flow: back to the authorization server; no company picker and no shell page in between.
                Effect.sync(() => {
                  setAttempt('opening');
                  globalThis.location.assign(oauthRequest.authorizeUrl);
                }),
        }),
        Effect.ensuring(Effect.sync(() => setAttempt('idle'))),
      ),
    );
  };

  return (
    <>
      <UltramodernRouteHead />
      <main className="flex min-h-dvh items-center justify-center bg-surface px-200 py-400 text-fg-primary">
        <section className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 flex w-full max-w-md flex-col gap-200 p-300 md:p-400">
          <div className="flex items-center gap-150">
            <span className="flex size-icon-control-lg items-center justify-center rounded-md bg-primary">
              <Icon icon="icon-[mdi--hexagon-multiple-outline]" size="md" />
            </span>
            <span className="flex-1 font-semibold text-xl">OntOS</span>
            <Badge size="sm" variant="outline">
              DEMO
            </Badge>
          </div>
          <p className="text-fg-secondary text-sm">{t('shell.login.welcome')}</p>
          {oauthRequest === undefined ? null : (
            <div className="ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base p-200 text-sm" data-testid="oauth-login-banner" role="status">
              <p>
                <strong>
                  {oauthClientName ?? (oauthRequest.clientHost === '' ? t('shell.login.oauth.unknownClient') : oauthRequest.clientHost)}
                </strong>{' '}
                {oauthClientName !== undefined && oauthRequest.clientHost !== ''
                  ? t('shell.login.oauth.request', { host: oauthRequest.clientHost })
                  : t('shell.login.oauth.requestNoHost')}
              </p>
              <p>{t('shell.login.oauth.continue')}</p>
              {oauthRequest.knownClient ? null : (
                <p className="text-fg-secondary">
                  {t('shell.login.oauth.unverified', { client: oauthClientName ?? oauthRequest.clientId })}
                </p>
              )}
            </div>
          )}
          {/* Once signed in the URL has moved on, so the title and fields step aside while the next page loads.
              They are hidden, not unmounted, so their refs survive a failed navigation; the submit button stays. */}
          <div>
            <h1 className="shell:text-2xl shell:font-bold" hidden={attempt === 'opening'}>
              {t('shell.login.title')}
            </h1>
            <form action={handleSubmit} className="shell:mt-4 shell:flex shell:flex-col shell:gap-4" noValidate>
              <div hidden={attempt === 'opening'}>
                <FormInput
                  aria-invalid={validation.loginMissing || undefined}
                  autoComplete="username"
                  defaultValue={attemptedLogin}
                  helpText={validation.loginMissing ? t('shell.login.required.login') : undefined}
                  id="login"
                  label={t('shell.login.field.login')}
                  name="login"
                  ref={loginRef}
                  required
                  type="text"
                  validateStatus={validation.loginMissing ? 'error' : 'default'}
                />
              </div>
              <div hidden={attempt === 'opening'}>
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
              </div>
              {reason === undefined || submissionError !== undefined ? null : (
                <div className="ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base p-200 text-sm" role="status">
                  <p className="font-semibold">{t(`shell.login.notice.${reason}.title`)}</p>
                  <p>{t(`shell.login.notice.${reason}.body`)}</p>
                </div>
              )}
              {submissionError === undefined ? null : (
                <div className="ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base p-200 text-sm" role="alert">
                  <p className="font-semibold">{t(errorTitleKey)}</p>
                  <p>{t(submissionError)}</p>
                </div>
              )}
              <Button
                block
                disabled={attempt !== 'idle'}
                isLoading={attempt !== 'idle'}
                loadingText={t(attempt === 'opening' ? 'shell.login.opening' : 'shell.login.pending')}
                size="md"
                theme="solid"
                type="submit"
                variant="primary"
              >
                {t('shell.login.submit')}
              </Button>
            </form>
          </div>
          <p className="border-border-primary border-t pt-200 text-fg-secondary text-xs">
            {t('shell.login.contextHint')}
          </p>
          <Link as={LocalizedLink} className="self-start text-sm" to="/">
            {t('shell.login.back')}
          </Link>
        </section>
      </main>
      <Toaster
        closeLabel={t('shell.login.toaster.close')}
        label={t('shell.login.toaster.label')}
        loadingLabel={t('shell.login.toaster.loading')}
      />
    </>
  );
};

export default LoginPage;
