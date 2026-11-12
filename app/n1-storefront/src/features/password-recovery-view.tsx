"use client";

import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@/features/plain-link";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import { passwordRecoveryActionFeedback } from "./action-feedback";
import { FormInput } from "./form-controls";
import { Effect, Exit, Schema } from "effect";
import type { Fiber } from "effect";
import { useEffect, useId, useRef, useState } from "react";
import type { Dictionary } from "@/i18n";
import {
  PasswordRecoveryRequestSchema,
  PasswordRecoveryResetSchema,
} from "@/ontos/password-recovery";
import type { PasswordRecoveryOutcome } from "@/ontos/password-recovery";
import {
  completePasswordRecovery,
  requestPasswordRecovery,
} from "@/ontos/password-recovery-client";
import { portalRuntime } from "@/ontos/portal-client";

type RecoveryMode = "request" | "reset";
const terminalStates = new Set<PasswordRecoveryOutcome["state"]>([
  "completed",
  "invalid-token",
  "reconciliation",
  "requested",
  "unconfirmed",
]);

const RecoveryFeedback = ({
  dictionary: d,
  mode,
  result,
}: {
  dictionary: Dictionary;
  mode: RecoveryMode;
  result: PasswordRecoveryOutcome | null;
}) => {
  if (result === null) {
    return <output aria-live="polite" />;
  }
  const guidance =
    (mode === "request" && result.state === "requested") ||
    (mode === "reset" && result.state === "completed");
  const { statusText } = passwordRecoveryActionFeedback(result.state, mode, d);
  return (
    <output aria-live="polite">
      <StatusText status={guidance ? "default" : "warning"}>{statusText}</StatusText>
    </output>
  );
};

/** Password fields stay in native controls; a reset token never enters this component. */
const useRecoveryForm = (mode: RecoveryMode, dictionary: Dictionary) => {
  const toaster = useToast();
  const form = useRef<HTMLFormElement>(null);
  const active = useRef<Fiber.Fiber<PasswordRecoveryOutcome> | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PasswordRecoveryOutcome | null>(null);
  useEffect(
    () => () => {
      // Do not interrupt or replay a potentially dispatched password write on navigation.
      active.current = null;
    },
    [],
  );
  const submit = (fields: FormData) => {
    if (active.current !== null || (result !== null && terminalStates.has(result.state))) {
      return;
    }
    const program =
      mode === "request"
        ? Schema.decodeUnknownEffect(PasswordRecoveryRequestSchema)({
            email: fields.get("email"),
          }).pipe(Effect.flatMap(requestPasswordRecovery))
        : Schema.decodeUnknownEffect(PasswordRecoveryResetSchema)({
            newPassword: fields.get("newPassword"),
            passwordConfirmation: fields.get("passwordConfirmation"),
          }).pipe(Effect.flatMap(completePasswordRecovery));
    setPending(true);
    const fiber = portalRuntime.runFork(
      program.pipe(
        Effect.match({
          onFailure: (): PasswordRecoveryOutcome => ({ state: "invalid" }),
          onSuccess: (value) => value,
        }),
      ),
    );
    active.current = fiber;
    fiber.addObserver((exit) => {
      if (active.current !== fiber) {
        return;
      }
      active.current = null;
      const next = Exit.isSuccess(exit) ? exit.value : { state: "unconfirmed" as const };
      if (terminalStates.has(next.state)) {
        form.current?.reset();
      }
      setResult(next);
      setPending(false);
      const { successToast } = passwordRecoveryActionFeedback(next.state, mode, dictionary);
      if (successToast !== null) {
        toaster.create(successToast);
      }
    });
  };
  return { form, pending, result, submit };
};

/** Reuses the Figma333:4671 auth composition; there is no dedicated reset frame. */
export const PasswordRecoveryView = ({
  dictionary: d,
  locale,
  mode,
  tokenPresent = false,
}: {
  dictionary: Dictionary;
  locale: string;
  mode: RecoveryMode;
  tokenPresent?: boolean;
}) => {
  const fieldId = useId();
  const { form, pending, result, submit } = useRecoveryForm(mode, d);
  const text = d.passwordRecovery;
  const blocked = result !== null && terminalStates.has(result.state);
  const missingToken = mode === "reset" && !tokenPresent;
  const invalid = result?.state === "invalid";
  return (
    <section className="w-full pt-7 pb-6 md:min-h-n1-auth-login">
      <div className="mx-auto flex w-full max-w-n1-auth flex-col gap-4 px-4 md:px-0">
        <h1 className="text-xl font-bold">
          {mode === "request" ? text.requestHeading : text.resetHeading}
        </h1>
        {missingToken ? (
          <StatusText>{text.missingToken}</StatusText>
        ) : (
          <>
            {!blocked && (
              <form
                action={`/api/account/password/${mode}`}
                aria-busy={pending}
                className="flex flex-col gap-1"
                method="post"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit(new FormData(event.currentTarget));
                }}
                ref={form}
              >
                {mode === "request" ? (
                  <FormInput
                    autoComplete="email"
                    disabled={pending}
                    id={`${fieldId}-email`}
                    label={d.auth.fields.email}
                    maxLength={320}
                    name="email"
                    required
                    size="md"
                    type="email"
                    validateStatus={invalid ? "error" : "default"}
                  />
                ) : (
                  <>
                    <FormInput
                      autoComplete="new-password"
                      disabled={pending}
                      helpText={d.auth.passwordRequirements}
                      id={`${fieldId}-password`}
                      label={text.newPassword}
                      maxLength={128}
                      minLength={12}
                      name="newPassword"
                      required
                      size="md"
                      type="password"
                      validateStatus={invalid ? "error" : "default"}
                    />
                    <FormInput
                      autoComplete="new-password"
                      disabled={pending}
                      id={`${fieldId}-confirmation`}
                      label={d.auth.fields.passwordConfirmation}
                      maxLength={128}
                      minLength={12}
                      name="passwordConfirmation"
                      required
                      size="md"
                      type="password"
                      validateStatus={invalid ? "error" : "default"}
                    />
                  </>
                )}
                <Button
                  block
                  density="compact"
                  disabled={pending}
                  isLoading={pending}
                  loadingText={mode === "request" ? text.requesting : text.resetting}
                  size="sm"
                  theme="solid"
                  type="submit"
                  variant="primary"
                >
                  {mode === "request" ? text.request : text.reset}
                </Button>
                <noscript>
                  <StatusText status="warning">{d.auth.javascriptRequired}</StatusText>
                </noscript>
              </form>
            )}
            <RecoveryFeedback dictionary={d} mode={mode} result={result} />
          </>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          {/* Credential recovery must reload the shared Portal admission, including revoked sessions. */}
          <Link href={`/${locale}/prihlaseni`}>{text.backToLogin}</Link>
          {mode === "reset" && (
            <Link as={NextLink} href={`/${locale}/zapomenute-heslo`}>
              {text.request}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
};
