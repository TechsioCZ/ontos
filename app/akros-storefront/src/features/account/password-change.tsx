"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { useDictionary } from "@/ontos/market-context";

export type ChangePassword = (password: string) => Promise<void>;

/**
 * Password change, validated and submitted separately from the profile. Without a `changePassword` service it
 * never claims success and never stores the input (OntOS has no signed-in password change yet).
 */
export function PasswordChange({ changePassword }: { changePassword?: ChangePassword }) {
  const cs = useDictionary().account.password;
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
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
    if (!password.trim() || !confirmation || password !== confirmation) {
      const origin = document.activeElement;
      requestAnimationFrame(() => {
        // A later pointer/keyboard action takes precedence over automatic error focus.
        if (document.activeElement === origin)
          root.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    if (!changePassword) {
      setMessage(cs.notConnected);
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await changePassword(password);
      setPassword("");
      setConfirmation("");
      setAttempted(false);
      setMessage(cs.changed);
    } catch {
      setMessage(cs.failed);
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
      <p className="sf-account-notice">
        {changePassword ? cs.savedSeparately : cs.unavailableNote}
      </p>
      {message && <output aria-live="polite">{message}</output>}
    </div>
  );
}
