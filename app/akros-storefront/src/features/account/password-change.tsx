"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";

export type ChangePassword = (password: string) => Promise<void>;

export function PasswordChange({ changePassword }: { changePassword?: ChangePassword }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const passwordError = attempted && !password.trim() ? "Vyplňte nové heslo." : "";
  const confirmationError = attempted
    ? !confirmation
      ? "Potvrďte nové heslo."
      : password !== confirmation
        ? "Hesla se neshodují."
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
      setMessage(
        "Změna hesla zatím není připojena k účtu. Ostatní údaje můžete uložit samostatně.",
      );
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await changePassword(password);
      setPassword("");
      setConfirmation("");
      setAttempted(false);
      setMessage("Heslo bylo změněno.");
    } catch {
      setMessage("Heslo se nepodařilo změnit. Zkontrolujte údaje a zkuste to znovu.");
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
    <div id="zmena-hesla" className="akros-password-change" ref={root}>
      <h3>Změna hesla</h3>
      <FormInput
        id="account-password"
        label="Nové heslo"
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
        label="Potvrdit heslo"
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
        loadingText="Měním heslo…"
      >
        Změnit heslo
      </Button>
      <p className="akros-account-notice">
        {changePassword
          ? "Změna hesla se ukládá samostatně."
          : "Změna hesla bude dostupná po připojení zákaznického účtu."}
      </p>
      {message && <output aria-live="polite">{message}</output>}
    </div>
  );
}
