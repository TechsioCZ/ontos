"use client";

import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@/features/plain-link";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import { FormInput, FormInputRaw } from "./form-controls";
import { Effect, Exit, Fiber, Struct } from "effect";
import type { HttpClient } from "effect/http";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Dictionary } from "@/i18n";
import { decodePortalLogin, decodePortalMfaVerify, decodePortalRegistration } from "@/ontos/portal";
import type { PortalOutcome } from "@/ontos/portal";
import {
  loginPortal,
  logoutPortal,
  portalRuntime,
  readPortalCurrent,
  requestPortalMfaOtp,
  verifyPortalMfa,
  registerPortal,
  resumePortalEnrollment,
} from "@/ontos/portal-client";
import {
  canResumePortalEnrollment,
  portalMfaTransition,
  portalRefreshOutcome,
  portalVerificationOutcome,
} from "@/ontos/portal-model";
import { subscribePortalSessionRefresh } from "./portal-session-events";
import { makeAuthBlurValidation } from "./auth-blur-validation";
import type { AuthBlurResult } from "./auth-blur-validation";

type AuthMode = "login" | "register";
const fieldNames = [
  "firstName",
  "lastName",
  "email",
  "password",
  "passwordConfirmation",
  "termsAccepted",
] as const;
type AuthField = (typeof fieldNames)[number];
type InputField = Exclude<AuthField, "termsAccepted">;
type FieldErrors = Partial<Record<AuthField, string>>;
const passwordAutoComplete = { login: "current-password", register: "new-password" } as const;

const inputAttributes = {
  email: {
    autoComplete: "email",
    maxLength: 320,
    pattern: String.raw`[^\s@]+@[^\s@]+\.[^\s@]+`,
    type: "email",
  },
  firstName: {
    autoComplete: "given-name",
    maxLength: 100,
    pattern: String.raw`.*\S.*`,
    type: "text",
  },
  lastName: {
    autoComplete: "family-name",
    maxLength: 99,
    pattern: String.raw`.*\S.*`,
    type: "text",
  },
  password: { maxLength: 128, minLength: 12, type: "password" },
  passwordConfirmation: {
    autoComplete: "new-password",
    maxLength: 128,
    minLength: 12,
    type: "password",
  },
} as const;

/** Form composition only: field values remain in native controls, never in React or persistent storage. */
const AuthForm = ({
  dictionary: d,
  locale,
  mode,
  onEdit,
  onNavigate,
  onSubmit,
  passwordError,
  pending,
  submitting,
}: {
  dictionary: Dictionary;
  locale: string;
  mode: AuthMode;
  onEdit: () => void;
  onNavigate?: (() => void) | undefined;
  onSubmit: (fields: FormData) => void;
  passwordError: string | undefined;
  pending: boolean;
  submitting: boolean;
}) => {
  const fieldId = useId();
  const form = useRef<HTMLFormElement>(null);
  const blurValidationRef = useRef<ReturnType<typeof makeAuthBlurValidation<InputField>> | null>(
    null,
  );
  const getBlurValidation = () => {
    const validation = blurValidationRef.current ?? makeAuthBlurValidation<InputField>();
    blurValidationRef.current = validation;
    return validation;
  };
  const [errors, setErrors] = useState<FieldErrors>({});
  const [attemptedInvalid, setAttemptedInvalid] = useState(false);
  const [showPasswordHelp, setShowPasswordHelp] = useState(false);
  const [validated, setValidated] = useState({ password: false, passwordConfirmation: false });
  const clearError = (field: AuthField) => setErrors((previous) => Struct.omit(previous, [field]));
  const invalidField = (field: AuthField, valueMissing = false) =>
    setErrors((previous) => ({
      ...previous,
      [field]:
        field === "password" && valueMissing ? d.auth.passwordRequired : d.auth.errors[field],
    }));
  const commitBlur = (result: AuthBlurResult<InputField> | null) => {
    if (result === null) {
      return;
    }
    const { field, valid, valueMissing } = result;
    if (field === "password" || field === "passwordConfirmation") {
      setValidated((previous) => ({ ...previous, [field]: valid }));
    }
    if (valid) {
      clearError(field);
    } else {
      invalidField(field, valueMissing);
    }
  };
  const finishPointerValidation = () => commitBlur(getBlurValidation().finish());
  const successText = (field: InputField) => {
    if (mode !== "register") {
      return null;
    }
    if (field === "password" && validated.password) {
      return d.auth.passwordValid;
    }
    if (field === "passwordConfirmation" && validated.passwordConfirmation) {
      return d.auth.passwordsMatch;
    }
    return null;
  };
  const input = (field: InputField) => {
    const error = errors[field] ?? (field === "password" ? passwordError : undefined);
    const success = successText(field);
    const helpText = error ?? success;
    const hasHelpText = helpText !== null && helpText.length > 0;
    let status: "default" | "error" | "success" = "default";
    if (success !== null) {
      status = "success";
    }
    if (error !== undefined) {
      status = "error";
    }
    return (
      <FormInputRaw
        {...inputAttributes[field]}
        aria-describedby={hasHelpText ? `${fieldId}-${field}-help` : undefined}
        aria-invalid={error === undefined ? undefined : true}
        autoComplete={
          field === "password" ? passwordAutoComplete[mode] : inputAttributes[field].autoComplete
        }
        disabled={pending}
        helpText={
          hasHelpText ? (
            <StatusText
              id={`${fieldId}-${field}-help`}
              showIcon={status === "error"}
              size="md"
              status={status}
            >
              {helpText}
            </StatusText>
          ) : null
        }
        id={`${fieldId}-${field}`}
        label={d.auth.fields[field]}
        name={field}
        onBlur={(event) => {
          const submitButton =
            form.current?.querySelector<HTMLButtonElement>('button[type="submit"]');
          if (submitButton?.form === form.current && event.relatedTarget === submitButton) {
            return;
          }
          const confirmationMatches =
            field !== "passwordConfirmation" ||
            (form.current !== null &&
              event.currentTarget.value === new FormData(form.current).get("password"));
          const valid = event.currentTarget.validity.valid && confirmationMatches;
          commitBlur(
            getBlurValidation().validateOnBlur({
              field,
              valid,
              valueMissing: event.currentTarget.validity.valueMissing,
            }),
          );
        }}
        onChange={(event) => {
          clearError(field);
          if (field === "password") {
            clearError("passwordConfirmation");
            setValidated({ password: false, passwordConfirmation: false });
          }
          if (field === "passwordConfirmation") {
            const confirmationMatches =
              event.currentTarget.validity.valid &&
              form.current !== null &&
              event.currentTarget.value === new FormData(form.current).get("password");
            setValidated((previous) => ({
              ...previous,
              passwordConfirmation: confirmationMatches,
            }));
          }
          onEdit();
        }}
        onFocus={() => {
          if (mode === "register" && field === "password") {
            setShowPasswordHelp(true);
          }
        }}
        onInvalid={(event) => {
          event.preventDefault();
          invalidField(field, event.currentTarget.validity.valueMissing);
          if (mode === "register" && field === "password") {
            setShowPasswordHelp(true);
          }
        }}
        required
        size="md"
        validateStatus={error === undefined ? "default" : "error"}
      />
    );
  };
  return (
    <form
      action={mode === "register" ? "/api/enrollment" : "/api/account/login"}
      aria-busy={pending}
      className={
        mode === "register"
          ? "n1-auth-form flex flex-col gap-2"
          : "n1-auth-form flex flex-col gap-1"
      }
      method="post"
      onClickCapture={finishPointerValidation}
      onInvalidCapture={(event) => {
        event.preventDefault();
        if (mode === "register") {
          setAttemptedInvalid(true);
        }
        const terms = event.currentTarget.querySelector<HTMLInputElement>(
          'input[name="termsAccepted"]',
        );
        if (terms?.validity.valueMissing === true) {
          invalidField("termsAccepted");
        }
        event.currentTarget.querySelector<HTMLInputElement>("input:invalid")?.focus();
      }}
      onKeyDownCapture={finishPointerValidation}
      onPointerCancel={finishPointerValidation}
      onPointerDownCapture={(event) => {
        if (event.button === 0) {
          commitBlur(getBlurValidation().start());
        }
      }}
      onPointerLeave={finishPointerValidation}
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        if (mode === "register" && fields.get("password") !== fields.get("passwordConfirmation")) {
          setAttemptedInvalid(true);
          invalidField("passwordConfirmation");
          event.currentTarget
            .querySelector<HTMLInputElement>('input[name="passwordConfirmation"]')
            ?.focus();
          return;
        }
        if (mode === "register") {
          setShowPasswordHelp(true);
        }
        onSubmit(fields);
      }}
      ref={form}
    >
      {mode === "register" && (
        <div className="grid min-w-0 grid-cols-2 gap-1">
          <div className="min-w-0">{input("firstName")}</div>
          <div className="min-w-0">{input("lastName")}</div>
        </div>
      )}
      {input("email")}
      {input("password")}
      {mode === "register" && (
        <>
          {showPasswordHelp && errors.password === undefined && passwordError === undefined && (
            <p>{d.auth.passwordRequirements}</p>
          )}
          {input("passwordConfirmation")}
        </>
      )}
      <FormCheckbox
        disabled={pending}
        helpText={errors.termsAccepted}
        label={
          mode === "register" ? (
            <>
              {d.auth.acceptTerms}{" "}
              <Link as={NextLink} href={`/${locale}/obchodni-podminky`}>
                {d.auth.termsLink}
              </Link>
            </>
          ) : (
            d.auth.rememberMe
          )
        }
        name={mode === "register" ? "termsAccepted" : "rememberMe"}
        onCheckedChange={() => {
          clearError("termsAccepted");
          onEdit();
        }}
        required={mode === "register"}
        size="sm"
        validateStatus={errors.termsAccepted === undefined ? "default" : "error"}
        value="true"
      />
      <Button
        block
        density="compact"
        disabled={
          pending || (mode === "register" && attemptedInvalid && Object.keys(errors).length > 0)
        }
        size="sm"
        theme="solid"
        type="submit"
        variant="secondary"
      >
        {
          {
            login: submitting ? d.auth.signingIn : d.auth.signIn,
            register: submitting ? d.auth.registering : d.auth.register,
          }[mode]
        }
      </Button>
      {mode === "login" ? (
        <div className="flex justify-between gap-1">
          <Link as={NextLink} href={`/${locale}/zapomenute-heslo`} onClick={() => onNavigate?.()}>
            {d.auth.forgotPassword}
          </Link>
          <Link as={NextLink} href={`/${locale}/registrace`} onClick={() => onNavigate?.()}>
            {d.auth.register}
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap justify-center gap-1">
          <span>{d.auth.haveAccount}</span>
          <Link as={NextLink} href={`/${locale}/prihlaseni`} onClick={() => onNavigate?.()}>
            {d.auth.signInInvitation}
          </Link>
        </div>
      )}
      <noscript>{d.auth.javascriptRequired}</noscript>
    </form>
  );
};

const outcomeText = (outcome: PortalOutcome, d: Dictionary) => {
  const messages = {
    admitted: d.auth.admitted,
    anonymous: "",
    credentials: d.auth.credentials,
    "email-verified": d.auth.emailVerified,
    invalid: d.auth.invalid,
    mfa:
      outcome.state === "mfa" && outcome.feedback !== undefined && outcome.feedback !== "otp-sent"
        ? d.auth.mfa[outcome.feedback]
        : d.auth.mfaRequired,
    "mfa-authentication-required": d.auth.mfa.authenticationRequired,
    "mfa-expired": d.auth.mfa.expired,
    "rate-limited": d.auth.rateLimited,
    refused: d.auth.refused,
    "registration-progress":
      outcome.state === "registration-progress" ? d.auth.enrollment[outcome.phase] : "",
    unavailable: d.auth.unavailable,
    unconfirmed: d.auth.unconfirmed,
    "verification-required": d.auth.verificationRequired,
  } satisfies Record<PortalOutcome["state"], string>;
  return messages[outcome.state];
};

/** One in-memory owner session per scoped storefront, never persisted credentials. */
const PortalSessionContext = createContext<ReturnType<typeof usePortalSession> | null>(null);
const usePortalSession = (enabled = true) => {
  const [outcome, setOutcome] = useState<PortalOutcome>({ state: "anonymous" });
  const [pendingOperation, setPendingOperation] = useState<"read" | "action" | null>(null);
  const pending = pendingOperation !== null;
  const [loaded, setLoaded] = useState(false);
  const active = useRef<Fiber.Fiber<PortalOutcome> | null>(null);
  const activeIsRefresh = useRef(false);
  const activeIsMfa = useRef(false);
  const currentOutcome = useRef(outcome);
  const publishOutcome = (value: PortalOutcome) => {
    currentOutcome.current = value;
    setOutcome(value);
  };
  const refreshAfterRead = useRef(false);
  const start = (
    program: Effect.Effect<PortalOutcome, never, HttpClient.HttpClient>,
    isRefresh: boolean,
    expected?: PortalOutcome,
    onComplete?: (value: PortalOutcome) => void,
  ) => {
    if (
      active.current !== null ||
      (expected !== undefined && currentOutcome.current !== expected)
    ) {
      return;
    }
    setPendingOperation(isRefresh ? "read" : "action");
    activeIsRefresh.current = isRefresh;
    activeIsMfa.current = expected?.state === "mfa";
    const fiber = portalRuntime.runFork(program);
    active.current = fiber;
    fiber.addObserver((exit) => {
      if (active.current !== fiber) {
        return;
      }
      active.current = null;
      const wasMfa = activeIsMfa.current;
      activeIsRefresh.current = false;
      activeIsMfa.current = false;
      if (expected !== undefined && currentOutcome.current !== expected) {
        setPendingOperation(null);
        setLoaded(true);
        return;
      }
      const observed: PortalOutcome = Exit.isSuccess(exit) ? exit.value : { state: "unconfirmed" };
      // An external session change fences this response. Re-read, never replay MFA consumption;
      // an uncertain write must not revive its former challenge when the read is anonymous.
      if ((isRefresh || wasMfa) && refreshAfterRead.current) {
        refreshAfterRead.current = false;
        if (wasMfa) {
          publishOutcome(observed.state === "admitted" ? { state: "unconfirmed" } : observed);
        }
        start(readPortalCurrent(), true);
        return;
      }
      setPendingOperation(null);
      setLoaded(true);
      const next = isRefresh ? portalRefreshOutcome(currentOutcome.current, observed) : observed;
      publishOutcome(next);
      onComplete?.(next);
    });
  };
  const run = (
    program: Effect.Effect<PortalOutcome, never, HttpClient.HttpClient>,
    expected?: PortalOutcome,
    onComplete?: (value: PortalOutcome) => void,
  ) => start(program, false, expected, onComplete);
  const restoreSession = useEffectEvent(() => {
    if (active.current !== null) {
      if (activeIsRefresh.current || activeIsMfa.current) {
        refreshAfterRead.current = true;
      }
      return;
    }
    start(readPortalCurrent(), true);
  });
  useEffect(() => {
    if (enabled) {
      restoreSession();
    }
    const unsubscribe = enabled ? subscribePortalSessionRefresh(() => restoreSession()) : null;
    return () => {
      unsubscribe?.();
      const fiber = active.current;
      active.current = null;
      activeIsRefresh.current = false;
      activeIsMfa.current = false;
      refreshAfterRead.current = false;
      if (fiber !== null) {
        portalRuntime.runFork(Fiber.interrupt(fiber));
      }
    };
  }, [enabled]);
  const edit = () => {
    const { current } = currentOutcome;
    if (current.state === "credentials") {
      publishOutcome({ state: "anonymous" });
    } else if (
      current.state === "mfa" &&
      (current.feedback === "invalid" || current.feedback === "rejected")
    ) {
      publishOutcome(Struct.omit(current, ["feedback"]));
    }
  };
  return { edit, loaded, outcome, pending, run, submitting: pendingOperation === "action" };
};

export const PortalSessionProvider = ({ children }: { children: ReactNode }) => {
  const session = usePortalSession();
  return <PortalSessionContext.Provider value={session}>{children}</PortalSessionContext.Provider>;
};

/** Forms share the owner session and pending writes; credential fields remain local. */
export const usePortalAuth = ({
  mode,
  verification,
}: {
  mode: AuthMode;
  verification?: string | undefined;
}) => {
  const shared = useContext(PortalSessionContext);
  const local = usePortalSession(shared === null);
  const session = shared ?? local;
  const { edit, loaded, pending, run, submitting } = session;
  const outcome =
    session.outcome.state === "anonymous"
      ? portalVerificationOutcome(verification)
      : session.outcome;
  const submit = (fields: FormData) => {
    const credentials = { email: fields.get("email"), password: fields.get("password") };
    const program =
      mode === "login"
        ? decodePortalLogin({
            ...credentials,
            rememberMe: fields.get("rememberMe") === "true",
          }).pipe(Effect.flatMap(loginPortal))
        : decodePortalRegistration({
            ...credentials,
            firstName: fields.get("firstName"),
            lastName: fields.get("lastName"),
            passwordConfirmation: fields.get("passwordConfirmation"),
            requestId: crypto.randomUUID(),
            termsAccepted: fields.get("termsAccepted") === "true",
          }).pipe(Effect.flatMap(registerPortal));
    run(
      program.pipe(
        Effect.match({
          onFailure: (): PortalOutcome => ({ state: "invalid" }),
          onSuccess: (value) => value,
        }),
      ),
    );
  };
  return { edit, loaded, outcome, pending, run, submit, submitting };
};

const mfaCodeError = (outcome: PortalOutcome, d: Dictionary) =>
  outcome.state === "mfa" && (outcome.feedback === "invalid" || outcome.feedback === "rejected")
    ? d.auth.mfa[outcome.feedback]
    : undefined;

const authFeedbackText = (
  outcome: PortalOutcome,
  d: Dictionary,
  mode: AuthMode,
  codeFieldVisible: boolean,
) => {
  if (
    outcome.state === "anonymous" ||
    (mode === "login" && outcome.state === "credentials") ||
    (codeFieldVisible && mfaCodeError(outcome, d) !== undefined)
  ) {
    return "";
  }
  return outcomeText(outcome, d);
};

/** Shared presentation for page and header; only owner admission shows a customer. */
export const AuthContent = ({
  controller,
  dictionary: d,
  locale,
  mode,
  onNavigate,
}: {
  controller: ReturnType<typeof usePortalAuth>;
  dictionary: Dictionary;
  locale: string;
  mode: AuthMode;
  onNavigate?: (() => void) | undefined;
}) => {
  const { edit, outcome, pending, run, submit, submitting } = controller;
  const feedbackError = outcome.state === "refused" || outcome.state === "unavailable";
  const toaster = useToast();
  const codeError = mfaCodeError(outcome, d);
  const mfaId = useId();
  const mfaForm = useRef<HTMLFormElement>(null);
  const [selection, setSelection] = useState<{
    method: "totp" | "otp";
    methods: readonly ("totp" | "otp")[];
  } | null>(null);
  const selectedMethod =
    outcome.state === "mfa" && selection?.methods === outcome.methods ? selection.method : null;
  const feedbackText = authFeedbackText(outcome, d, mode, selectedMethod !== null);
  const verifyMfa = (fields: FormData) => {
    if (outcome.state !== "mfa" || selectedMethod === null) {
      return;
    }
    run(
      decodePortalMfaVerify({ code: fields.get("code"), method: selectedMethod }).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.succeed(
              portalMfaTransition(outcome, outcome, { reason: "invalid", state: "mfa-error" }),
            ),
          onSuccess: (input) =>
            verifyPortalMfa(input).pipe(
              Effect.map((result) => portalMfaTransition(outcome, outcome, result)),
            ),
        }),
      ),
      outcome,
    );
    mfaForm.current?.reset();
  };
  const requestOtp = () => {
    if (outcome.state !== "mfa" || !outcome.methods.includes("otp")) {
      return;
    }
    mfaForm.current?.reset();
    run(
      requestPortalMfaOtp().pipe(
        Effect.map((result) => portalMfaTransition(outcome, outcome, result)),
      ),
      outcome,
      (accepted) => {
        if (accepted.state === "mfa" && accepted.feedback === "otp-sent") {
          toaster.create({ title: d.auth.mfa.otpSent, type: "success" });
        }
      },
    );
  };
  const terminal = [
    "admitted",
    "unconfirmed",
    "mfa",
    "registration-progress",
    "verification-required",
  ].includes(outcome.state);
  return (
    <>
      {feedbackText !== "" && (
        <StatusText
          aria-atomic={true}
          aria-live={feedbackError ? undefined : "polite"}
          className="mb-2"
          showIcon={false}
          size="md"
          status={feedbackError ? "error" : "default"}
        >
          {feedbackText}
        </StatusText>
      )}
      {outcome.state === "mfa" && (
        <div className="flex flex-col gap-1">
          <fieldset className="flex flex-wrap gap-1">
            <legend>{d.auth.mfa.methodLabel}</legend>
            {outcome.methods.map((available) => (
              <Button
                aria-pressed={selectedMethod === available}
                disabled={pending}
                key={available}
                onClick={() => {
                  setSelection({ method: available, methods: outcome.methods });
                  mfaForm.current?.reset();
                  edit();
                }}
                size="sm"
                theme="solid"
                type="button"
                variant="secondary"
              >
                {d.auth.mfa.methods[available]}
              </Button>
            ))}
          </fieldset>
          {selectedMethod !== null && (
            <form
              action="/api/account/mfa/verify"
              aria-busy={pending}
              className="flex flex-col gap-1"
              method="post"
              onSubmit={(event) => {
                event.preventDefault();
                verifyMfa(new FormData(event.currentTarget));
              }}
              ref={mfaForm}
            >
              {selectedMethod === "otp" && (
                <Button
                  disabled={pending}
                  onClick={requestOtp}
                  size="sm"
                  theme="solid"
                  type="button"
                  variant="secondary"
                >
                  {d.auth.mfa.sendOtp}
                </Button>
              )}
              <FormInput
                autoComplete="one-time-code"
                disabled={pending}
                helpText={codeError}
                id={`${mfaId}-code`}
                label={d.auth.mfa.code}
                maxLength={32}
                minLength={1}
                name="code"
                onChange={edit}
                required
                type="text"
                validateStatus={codeError === undefined ? "default" : "error"}
              />
              <Button
                block
                disabled={pending}
                size="sm"
                theme="solid"
                type="submit"
                variant="primary"
              >
                {d.auth.mfa.verify}
              </Button>
            </form>
          )}
        </div>
      )}
      {outcome.state === "admitted" && (
        <div className="mb-4 space-y-2">
          <p>{outcome.name}</p>
          <p className="wrap-break-word">{outcome.email}</p>
          <Link as={NextLink} href={`/${locale}/ucet`} onClick={() => onNavigate?.()}>
            {d.accountPage.heading}
          </Link>
          <Button
            disabled={pending}
            onClick={() => run(logoutPortal())}
            size="sm"
            theme="solid"
            type="button"
            variant="secondary"
          >
            {d.auth.signOut}
          </Button>
        </div>
      )}
      {!terminal && (
        <AuthForm
          dictionary={d}
          locale={locale}
          mode={mode}
          onEdit={edit}
          onNavigate={onNavigate}
          onSubmit={submit}
          passwordError={outcome.state === "credentials" ? d.auth.credentials : undefined}
          pending={pending}
          submitting={submitting}
        />
      )}
      {terminal && outcome.state !== "admitted" && (
        <div className="flex flex-wrap gap-2">
          {canResumePortalEnrollment(outcome) && (
            <Button
              disabled={pending}
              onClick={() => run(resumePortalEnrollment())}
              size="sm"
              theme="solid"
              type="button"
              variant="primary"
            >
              {pending ? d.auth.continuing : d.auth.continueEnrollment}
            </Button>
          )}
          <Button
            disabled={pending}
            onClick={() => run(readPortalCurrent())}
            size="sm"
            theme="solid"
            type="button"
            variant="secondary"
          >
            {pending ? d.auth.checking : d.auth.checkSession}
          </Button>
        </div>
      )}
    </>
  );
};

/** Route feature maps real Portal outcomes; provider session is never customer admission. */
export const AuthView = ({
  dictionary: d,
  locale,
  mode,
  verification,
}: {
  dictionary: Dictionary;
  locale: string;
  mode: AuthMode;
  verification?: string | undefined;
}) => {
  const controller = usePortalAuth({ mode, verification });
  return (
    <section
      className={
        mode === "register"
          ? "w-full pt-7 pb-6 md:min-h-n1-auth-register"
          : "w-full pt-7 pb-6 md:min-h-n1-auth-login"
      }
    >
      <div className="mx-auto w-full max-w-n1-auth">
        <h1 className="sr-only">{mode === "register" ? d.auth.register : d.auth.signIn}</h1>
        <AuthContent controller={controller} dictionary={d} locale={locale} mode={mode} />
      </div>
    </section>
  );
};
