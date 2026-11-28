import {
  FormReact,
  FormRoot,
  SubmitButton,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouter } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Function as Fn, Match, Option, Schema, SchemaIssue } from 'effect';
import type { Cause } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useRef, useState } from 'react';

import { signIn } from '../../../api/auth-client.ts';
import type { ShellAuthenticationClientError } from '../../../api/auth-client.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { useBrowserLocationHref } from '../../browser-location.ts';
import { endBrowserSession } from '../../session-scope.ts';
import { openSignedInPage, signInReason, signInReturnPath } from '../../sign-in-return.ts';
import type { SignInReason } from '../../sign-in-return.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { useHydratedMarker } from '../../use-hydrated.ts';
import { clientNameFrom, OAUTH_PRELOGIN_PATH, readOAuthLoginError, readOAuthLoginRequest } from './oauth-handoff.ts';
import type { OAuthLoginRequest } from './oauth-handoff.ts';

const internalErrorMessageKey = 'shell.login.error.internal';
const errorTitleKey = 'shell.login.error.title';

const loginReason = (href: string | undefined, language: string): SignInReason | 'sign_in_required' | undefined =>
  href === undefined
    ? undefined
    : (signInReason(href) ?? (signInReturnPath(href, language) === undefined ? undefined : 'sign_in_required'));

const OAuthPreloginPayload = Schema.Struct({ client_id: Schema.String, oauth_query: Schema.String });
const readOAuthClientName = Effect.fn('Login.readOAuthClientName')(function* readOAuthClientNameEffect(
  request: OAuthLoginRequest,
) {
  const clientRequest = yield* HttpClientRequest.schemaBodyJson(OAuthPreloginPayload)(
    HttpClientRequest.post(new URL(OAUTH_PRELOGIN_PATH, window.location.href)),
    { client_id: request.clientId, oauth_query: request.signedQuery },
  );
  return yield* HttpClient.execute(clientRequest).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Json)),
    Effect.map(clientNameFrom),
    Effect.timeout('10 seconds'),
  );
});

const oauthBannerText = (
  request: OAuthLoginRequest | undefined,
  clientName: string | undefined,
  t: ReturnType<typeof useModernI18n>['t'],
) =>
  request === undefined
    ? undefined
    : {
        client: clientName ?? (request.clientHost === '' ? t('shell.login.oauth.unknownClient') : request.clientHost),
        description:
          clientName !== undefined && request.clientHost !== ''
            ? t('shell.login.oauth.request', { host: request.clientHost })
            : t('shell.login.oauth.requestNoHost'),
        warning: request.knownClient
          ? undefined
          : t('shell.login.oauth.unverified', { client: clientName ?? request.clientId }),
      };

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
 * decoded, and the request carries the page language. A refusal is the form's own error, kept next to
 * the form until the next attempt; a short-lived toast is easy to miss during an outage.
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
    submitErrors: ({ reason }) => [{ message: `shell.login.error.${reason}`, path: '' as const }],
  },
);
const passwordField = loginForm.getFieldAtoms(loginForm.fields.password);

const LoginFieldSchema = Schema.Literals(['login', 'password']);
type LoginField = typeof LoginFieldSchema.Type;
/** The first field a failed validation names: the login before the password. */
const firstMissingField = (error: Schema.SchemaError): LoginField =>
  SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.some((issue) => issue.path?.[0] === 'email')
    ? 'login'
    : 'password';

/** The active URL owns its client-name lookup; leaving it cancels the request and hides stale names. */
const useOAuthLoginLocation = () => {
  const href = useBrowserLocationHref();
  const oauthRequest = href === undefined ? undefined : readOAuthLoginRequest(href);
  const oauthError = href === undefined ? undefined : readOAuthLoginError(href);
  const [clientNameResult, setClientNameResult] = useState<{
    readonly href: string;
    readonly name: string | undefined;
  }>();
  const clientName = clientNameResult?.href === href ? clientNameResult?.name : undefined;
  useEffect(() => {
    if (href === undefined) {
      return Fn.constVoid;
    }
    const request = readOAuthLoginRequest(href);
    return request === undefined
      ? Fn.constVoid
      : browserRuntime.runCallback(
          readOAuthClientName(request).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Match.value(error).pipe(
                  Match.tag('HttpBodyError', 'HttpClientError', 'SchemaError', 'TimeoutError', () => Effect.void),
                  Match.exhaustive,
                ),
              onSuccess: (name) => Effect.sync(() => setClientNameResult({ href, name })),
            }),
          ),
        );
  }, [href]);
  return { clientName, href, oauthError, oauthRequest };
};

const LoginPage = () => {
  const { language, t } = useModernI18n();
  const router = useRouter();
  const toaster = useToast();
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const clearPassword = useAtomSet(passwordField.setValue);
  const refused = useAtomValue(loginForm.rootError);
  // A request, not a flag: every failed attempt focuses its field again once the form is enabled.
  const [focusRequest, setFocusRequest] = useState<{ readonly field: LoginField } | null>(null);
  // After a successful sign-in the URL moves at once, but this form stays on screen until the next page has loaded.
  // The button then says the app is opening instead of still claiming to sign in.
  const [opening, setOpening] = useState(false);
  // Signed in, but the next page did not open; said next to the form until the next attempt.
  const [navigationFailed, setNavigationFailed] = useState(false);
  const submissionError = navigationFailed ? internalErrorMessageKey : Option.getOrUndefined(refused);
  // A dead session (disabled account, session no longer accepted) arrives here with a reason; say why once.
  // A protected page opened without signing in arrives with only the page to return to: "not signed in".
  // The server snapshot keeps hydration's first render free of browser-only notices.
  const { clientName, href, oauthError, oauthRequest } = useOAuthLoginLocation();
  const reason = loginReason(href, language);
  const oauthBanner = oauthBannerText(oauthRequest, clientName, t);
  const hydrated = useHydratedMarker();
  useEffect(() => {
    if (focusRequest !== null) {
      (focusRequest.field === 'login' ? loginRef : passwordRef).current?.focus();
    }
  }, [focusRequest]);
  /** A sent attempt that did not open the app: the login stays filled, so only the password is retyped. */
  const retryFrom = (field: LoginField) => {
    clearPassword('');
    setFocusRequest({ field });
  };
  const enterShell = () => {
    if (oauthRequest !== undefined) {
      // OAuth connect flow: back to authorization without opening a Shell page.
      globalThis.location.assign(oauthRequest.authorizeUrl);
      return;
    }
    // Signed in: what remains is loading the next page, which can take a few seconds.
    setOpening(true);
    void browserRuntime.runPromise(
      endBrowserSession.pipe(
        Effect.andThen(Effect.tryPromise(() => router.invalidate({ sync: true }))),
        Effect.andThen(Effect.suspend(() => openSignedInPage(router, window.location.href, language))),
        Effect.timeout('10 seconds'),
        Effect.matchEffect({
          onFailure: (failure: Cause.TimeoutError | Cause.UnknownError) =>
            Effect.sync(() => {
              void failure;
              setNavigationFailed(true);
              retryFrom('login');
            }),
          onSuccess: Effect.succeed,
        }),
        Effect.ensuring(Effect.sync(() => setOpening(false))),
      ),
    );
  };
  useAtomSubscribe(loginForm.submit, (result) => {
    // Every attempt supersedes what the previous one said.
    setNavigationFailed(false);
    if (result.waiting) {
      return;
    }
    if (AsyncResult.isSuccess(result)) {
      toaster.dismiss();
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
    // The form shows the refusal; stale validation toasts of earlier attempts go away.
    toaster.dismiss();
    retryFrom('password');
  });

  return (
    <>
      <UltramodernRouteHead />
      <main className="flex min-h-dvh items-center justify-center bg-surface px-200 py-400 text-fg-primary">
        <section className="surface-card flex w-full max-w-md flex-col gap-200 p-300 md:p-400">
          <div className="flex items-center gap-150">
            <span className="flex size-icon-control-lg items-center justify-center rounded-md bg-primary">
              <Icon icon="icon-[mdi--hexagon-multiple-outline]" size="md" />
            </span>
            <span className="flex-1 font-semibold text-xl">OntOS</span>
            <Badge appearance="outline" severity="neutral" size="sm">
              DEMO
            </Badge>
          </div>
          <p className="text-fg-secondary text-sm">{t('shell.login.welcome')}</p>
          {oauthError === undefined ? null : (
            <div
              className="surface-tile flex flex-col gap-100 p-200 text-sm"
              data-testid="oauth-login-error"
              role="alert"
            >
              <h1 className="font-semibold text-lg">{t('shell.login.oauth.error.title')}</h1>
              <p>{t(`shell.login.oauth.error.${oauthError}`)}</p>
              <p className="text-fg-secondary">{t('shell.login.oauth.error.next')}</p>
            </div>
          )}
          {oauthBanner === undefined || oauthError !== undefined ? null : (
            <output className="block surface-tile p-200 text-sm" data-testid="oauth-login-banner">
              <span className="block">
                <strong>{oauthBanner.client}</strong> {oauthBanner.description}
              </span>
              <span className="block">{t('shell.login.oauth.continue')}</span>
              {oauthBanner.warning === undefined ? null : (
                <span className="block text-fg-secondary">{oauthBanner.warning}</span>
              )}
            </output>
          )}
          {/* Once signed in the URL has moved on, so the title and fields step aside while the next page loads.
              They are hidden, not unmounted, so their refs survive a failed navigation; the submit button stays. */}
          <div hidden={oauthError !== undefined}>
            <h1 className="text-2xl font-bold" hidden={opening}>
              {t('shell.login.title')}
            </h1>
            {/* POST to the sign-in path: a browser that submits before hydration never puts credentials in a URL,
                and the server answers such a submission with a redirect (server/credential-submission.ts). */}
            <FormRoot
              action={`/${language}/login`}
              blocked={opening}
              className="mt-200 flex flex-col gap-200"
              data-hydrated={hydrated}
              defaultValues={{ email: '', locale: language, password: '' }}
              form={loginForm}
              key={language}
              method="post"
              translateMessage={(message) => t(message, { defaultValue: t(internalErrorMessageKey) })}
            >
              <div hidden={opening}>
                <loginForm.email
                  autoComplete="username"
                  id="login"
                  label={t('shell.login.field.login')}
                  name="login"
                  ref={loginRef}
                  required
                  type="text"
                />
              </div>
              <div hidden={opening}>
                <loginForm.password
                  autoComplete="current-password"
                  id="password"
                  label={t('shell.login.field.password')}
                  name="password"
                  ref={passwordRef}
                  required
                  type="password"
                />
              </div>
              {reason === undefined || submissionError !== undefined ? null : (
                <output className="block surface-tile p-200 text-sm">
                  <span className="block font-semibold">{t(`shell.login.notice.${reason}.title`)}</span>
                  <span className="block">{t(`shell.login.notice.${reason}.body`)}</span>
                </output>
              )}
              {submissionError === undefined ? null : (
                <div className="surface-tile p-200 text-sm" role="alert">
                  <p className="font-semibold">{t(errorTitleKey)}</p>
                  <p>{t(submissionError)}</p>
                </div>
              )}
              <SubmitButton
                appearance="solid"
                block
                loadingText={t(opening ? 'shell.login.opening' : 'shell.login.pending')}
                severity="primary"
                size="md"
              >
                {t('shell.login.submit')}
              </SubmitButton>
            </FormRoot>
          </div>
          <p className="border-border-primary border-t pt-200 text-fg-secondary text-xs">
            {t('shell.login.contextHint')}
          </p>
          {/* Error card: a full page load back to the plain sign-in (the card is read from the URL once, on mount).
              Connect flow: "back to the home page" would silently abandon the client, so say how to cancel instead. */}
          {oauthError === undefined ? null : (
            <Link className="self-start text-sm" href={`/${language}/login`}>
              {t('shell.login.oauth.error.signIn')}
            </Link>
          )}
          {oauthError === undefined && oauthRequest !== undefined ? (
            <p className="text-fg-secondary text-sm">{t('shell.login.oauth.cancelHint')}</p>
          ) : null}
          {oauthError === undefined && oauthRequest === undefined ? (
            <Link as={LocalizedLink} className="self-start text-sm" to="/">
              {t('shell.login.back')}
            </Link>
          ) : null}
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
