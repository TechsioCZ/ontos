"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { AccountShell } from "@/components/account-shell";
import type { CustomerAccount } from "@/ontos/account";
import { isCustomerProfile } from "@/ontos/profile-model";
import type { CustomerProfile } from "@/ontos/profile-model";

/** Login identity is read-only; editable contact data is owned by Party Registry through Commerce. */
export function AccountProfilePage({
  account,
  profile,
}: {
  account: CustomerAccount;
  profile: CustomerProfile;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"save" | "logout" | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [values, setValues] = useState(profile);
  const [sourceVersion, setSourceVersion] = useState(profile.version);
  if (sourceVersion !== profile.version) {
    setSourceVersion(profile.version);
    setValues(profile);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending("save");
    setError("");
    setSaved(false);
    try {
      const response = await fetch("/api/ontos/account/profile", {
        body: JSON.stringify(values),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json()) as {
        message?: string;
        outcome?: string;
        profile?: unknown;
      };
      if (!response.ok) {
        throw new Error(result.message ?? "Uložení údajů se nepodařilo.");
      }
      if (result.outcome !== "PROFILE_SAVED" || !isCustomerProfile(result.profile)) {
        throw new Error("OntOS nepotvrdil uložení údajů. Obnovte stránku a zkontrolujte je.");
      }
      setValues(result.profile);
      setSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Uložení údajů se nepodařilo.");
    } finally {
      setPending(null);
      // A refused multi-command save can have completed some native commands; show the owner's real state.
      router.refresh();
    }
  }
  async function logout() {
    if (pending) {
      return;
    }
    setPending("logout");
    setError("");
    try {
      const response = await fetch("/api/ontos/account", {
        body: JSON.stringify({ operation: "logout" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Odhlášení se nepodařilo. Zkuste to znovu.");
      }
      router.replace("/prihlaseni");
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Odhlášení se nepodařilo.");
    } finally {
      setPending(null);
    }
  }
  const edit = (field: "displayName" | "phone" | "contactEmail", value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setSaved(false);
  };
  return (
    <AccountShell active="profile">
      <h1>Můj účet</h1>
      <form
        action="/api/ontos/account/profile"
        className="akros-auth-form"
        method="post"
        onSubmit={save}
      >
        <FormInput
          autoComplete="name"
          disabled={pending !== null}
          id="account-name"
          label="Jméno"
          maxLength={300}
          name="displayName"
          onChange={(event) => edit("displayName", event.target.value)}
          required
          size="sm"
          value={values.displayName}
        />
        <FormInput
          autoComplete="username"
          id="account-email"
          label="Přihlašovací e-mail"
          name="email"
          readOnly
          size="sm"
          type="email"
          value={account.email}
        />
        <p>Přihlašovací e-mail nelze změnit úpravou kontaktních údajů.</p>
        <FormInput
          autoComplete="tel"
          disabled={pending !== null}
          id="account-phone"
          label="Telefonní kontakt"
          maxLength={100}
          name="phone"
          onChange={(event) => edit("phone", event.target.value)}
          size="sm"
          type="tel"
          value={values.phone}
        />
        <FormInput
          disabled={pending !== null}
          id="account-contact-email"
          label="Kontaktní e-mail"
          maxLength={320}
          name="contactEmail"
          onChange={(event) => edit("contactEmail", event.target.value)}
          size="sm"
          type="email"
          value={values.contactEmail}
        />
        <p>
          Kontaktní údaje se ukládají do OntOS. Jejich změna nemění přihlašovací e-mail ani heslo.
        </p>
        <Button disabled={pending !== null} size="sm" type="submit" variant="primary">
          {pending === "save" ? "Ukládám…" : "Uložit změny"}
        </Button>
        <Button
          disabled={pending !== null}
          onClick={logout}
          size="sm"
          type="button"
          variant="primary"
        >
          {pending === "logout" ? "Odhlašuji…" : "Odhlásit se"}
        </Button>
        {saved && <output>Údaje byly uloženy v OntOS a znovu načteny.</output>}
        {error && <p role="alert">{error}</p>}
      </form>
    </AccountShell>
  );
}
