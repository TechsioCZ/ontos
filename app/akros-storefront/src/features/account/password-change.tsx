"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@/components/form-controls";
import { useDictionary } from "@/ontos/market-context";

export interface PasswordChangeRequest {
  readonly currentPassword: string;
  readonly newPassword: string;
}

export type ChangePassword = (request: PasswordChangeRequest) => Promise<void>;

/** A refusal the server explains in the customer's language; any other failure shows the generic message. */
export class PasswordChangeRefused extends Error {
  override readonly name = "PasswordChangeRefused";
}

/** The server's own explanation of a refusal, read by the error's name; empty for any other failure. */
const refusalExplanation = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "name" in cause &&
  cause.name === "PasswordChangeRefused" &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : "";

/** Submits the signed-in customer's change; the storefront route verifies the current password in OntOS. */
export async function requestPasswordChange(request: PasswordChangeRequest): Promise<void> {
  const response = await fetch("/api/ontos/account/password", {
    body: JSON.stringify(request),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (response.ok) return;
  const result = (await response.json().catch(() => ({}))) as { message?: unknown };
  throw new PasswordChangeRefused(typeof result.message === "string" ? result.message : "");
}

/** Password change, validated and submitted separately from the profile. It never stores either password. */
export function PasswordChange({ changePassword }: { changePassword: ChangePassword }) {
  const cs = useDictionary().account.password;
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const currentError = attempted && !currentPassword ? cs.currentRequired : "";
  const passwordError = attempted && !password.trim() ? cs.required : "";
  const confirmationError = attempted
    ? !confirmation
      ? cs.confirmationRequired
      : password !== confirmation
        ? cs.mismatch
        : ""
    : "";
  async function submit() {
    if (busy.current) return;
    setAttempted(true);
    setMessage("");
    if (!currentPassword || !password.trim() || !confirmation || password !== confirmation) {
      const origin = document.activeElement;
      requestAnimationFrame(() => {
        // A later pointer/keyboard action takes precedence over automatic error focus.
        if (document.activeElement === origin)
          root.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await changePassword({ currentPassword, newPassword: password });
      setCurrentPassword("");
      setPassword("");
      setConfirmation("");
      setAttempted(false);
      setMessage(cs.changed);
    } catch (cause) {
      setMessage(refusalExplanation(cause) || cs.failed);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function onPasswordKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }
  return (
    <div id="zmena-hesla" className="sf-password-change" ref={root}>
      <h3>{cs.title}</h3>
      <FormInput
        id="account-password-current"
        label={cs.currentPassword}
        size="sm"
        type="password"
        autoComplete="current-password"
        onKeyDown={onPasswordKeyDown}
        value={currentPassword}
        disabled={pending}
        validateStatus={currentError ? "error" : "default"}
        helpText={currentError}
        showHelpTextIcon={false}
        onChange={(e) => {
          setCurrentPassword(e.target.value);
          setMessage("");
        }}
      />
      <FormInput
        id="account-password"
        label={cs.newPassword}
        size="sm"
        type="password"
        autoComplete="new-password"
        onKeyDown={onPasswordKeyDown}
        value={password}
        disabled={pending}
        validateStatus={passwordError ? "error" : "default"}
        helpText={passwordError}
        showHelpTextIcon={false}
        onChange={(e) => {
          setPassword(e.target.value);
          setMessage("");
        }}
      />
      <FormInput
        id="account-password-confirmation"
        onKeyDown={onPasswordKeyDown}
        label={cs.confirmation}
        size="sm"
        type="password"
        autoComplete="new-password"
        value={confirmation}
        disabled={pending}
        validateStatus={confirmationError ? "error" : "default"}
        helpText={confirmationError}
        showHelpTextIcon={false}
        onChange={(e) => {
          setConfirmation(e.target.value);
          setMessage("");
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        theme="outlined"
        onClick={submit}
        isLoading={pending}
        loadingText={cs.pending}
      >
        {cs.submit}
      </Button>
      <p className="sf-account-notice">{cs.savedSeparately}</p>
      {message && <output aria-live="polite">{message}</output>}
    </div>
  );
}
