"use client";

import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
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
import { decodePortalLogin, decodePortalRegistration } from "@/ontos/portal";
import type { PortalOutcome } from "@/ontos/portal";
import {
  loginPortal,
  logoutPortal,
  portalRuntime,
  readPortalCurrent,
  registerPortal,
  resumePortalEnrollment,
} from "@/ontos/portal-client";
import { canResumePortalEnrollment, portalVerificationOutcome } from "@/ontos/portal-model";

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
  email: { autoComplete: "email", maxLength: 320, type: "email" },
  firstName: { autoComplete: "given-name", maxLength: 100, pattern: ".*\\S.*", type: "text" },
  lastName: { autoComplete: "family-name", maxLength: 99, pattern: ".*\\S.*", type: "text" },
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
}: {
  dictionary: Dictionary;
  locale: string;
  mode: AuthMode;
  onEdit: () => void;
  onNavigate?: (() => void) | undefined;
  onSubmit: (fields: FormData) => void;
  passwordError: string | undefined;
  pending: boolean;
}) => {
  const fieldId = useId();
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [showPasswordHelp, setShowPasswordHelp] = useState(false);
  const [validated, setValidated] = useState({ password: false, passwordConfirmation: false });
  const clearError = (field: AuthField) => setErrors((previous) => Struct.omit(previous, [field]));
  const invalidField = (field: AuthField) =>
    setErrors((previous) => ({ ...previous, [field]: d.auth.errors[field] }));
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
    let status: "default" | "error" | "success" = "default";
    if (success !== null) {
      status = "success";
    }
    if (error !== undefined) {
      status = "error";
    }
    return (
      <FormInput
        {...inputAttributes[field]}
        autoComplete={
          field === "password" ? passwordAutoComplete[mode] : inputAttributes[field].autoComplete
        }
        disabled={pending}
        helpText={error ?? success}
        id={`${fieldId}-${field}`}
        label={d.auth.fields[field]}
        name={field}
        onBlur={(event) => {
          const confirmationMatches =
            field !== "passwordConfirmation" ||
            (form.current !== null &&
              event.currentTarget.value === new FormData(form.current).get("password"));
          const valid = event.currentTarget.validity.valid && confirmationMatches;
          if (field === "password" || field === "passwordConfirmation") {
            setValidated((previous) => ({ ...previous, [field]: valid }));
          }
          if (valid) {
            clearError(field);
          } else {
            invalidField(field);
          }
        }}
        onChange={() => {
          clearError(field);
          if (field === "password") {
            setValidated({ password: false, passwordConfirmation: false });
          }
          if (field === "passwordConfirmation") {
            setValidated((previous) => ({ ...previous, passwordConfirmation: false }));
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
          invalidField(field);
          if (mode === "register" && field === "password") {
            setShowPasswordHelp(true);
          }
        }}
        required
        size="md"
        validateStatus={status}
      />
    );
  };
  return (
    <form
      action={mode === "register" ? "/api/enrollment" : "/api/account/login"}
      aria-busy={pending}
      className={mode === "register" ? "flex flex-col gap-2" : "flex flex-col gap-1"}
      method="post"
      onInvalidCapture={(event) => {
        event.preventDefault();
        const terms = event.currentTarget.querySelector<HTMLInputElement>(
          'input[name="termsAccepted"]',
        );
        if (terms?.validity.valueMissing === true) {
          invalidField("termsAccepted");
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        if (mode === "register" && fields.get("password") !== fields.get("passwordConfirmation")) {
          invalidField("passwordConfirmation");
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
        disabled={pending}
        size="sm"
        theme="solid"
        type="submit"
        variant="primary"
      >
        {
          {
            login: pending ? d.auth.signingIn : d.auth.signIn,
            register: pending ? d.auth.registering : d.auth.register,
          }[mode]
        }
      </Button>
      {mode === "login" ? (
        <div className="flex justify-between gap-1">
          <Link aria-disabled="true" title={d.featureUnavailable}>
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
    mfa: d.auth.mfaRequired,
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
  const [pending, setPending] = useState(false);
  const active = useRef<Fiber.Fiber<PortalOutcome> | null>(null);
  const run = (program: Effect.Effect<PortalOutcome, never, HttpClient.HttpClient>) => {
    if (active.current !== null) {
      return;
    }
    setPending(true);
    const fiber = portalRuntime.runFork(program);
    active.current = fiber;
    fiber.addObserver((exit) => {
      if (active.current !== fiber) {
        return;
      }
      active.current = null;
      setPending(false);
      setOutcome(Exit.isSuccess(exit) ? exit.value : { state: "unconfirmed" });
    });
  };
  const restoreSession = useEffectEvent(() => run(readPortalCurrent()));
  useEffect(() => {
    if (enabled) {
      restoreSession();
    }
    return () => {
      const fiber = active.current;
      active.current = null;
      if (fiber !== null) {
        portalRuntime.runFork(Fiber.interrupt(fiber));
      }
    };
  }, [enabled]);
  const edit = () => {
    if (outcome.state === "credentials") {
      setOutcome({ state: "anonymous" });
    }
  };
  return { edit, outcome, pending, run };
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
  const { edit, pending, run } = session;
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
  return { edit, outcome, pending, run, submit };
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
  const { edit, outcome, pending, run, submit } = controller;
  const terminal = [
    "admitted",
    "unconfirmed",
    "mfa",
    "registration-progress",
    "verification-required",
  ].includes(outcome.state);
  return (
    <>
      {outcome.state !== "anonymous" &&
        (mode === "register" || outcome.state !== "credentials") && (
          <output aria-live="polite" className="mb-2 block">
            {outcomeText(outcome, d)}
          </output>
        )}
      {outcome.state === "admitted" && (
        <div className="mb-4 space-y-2">
          <p>{outcome.name}</p>
          <p className="wrap-break-word">{outcome.email}</p>
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
