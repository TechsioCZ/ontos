"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { Accordion } from "@techsio/ui-kit/molecules/accordion";
import { AccountShell } from "@/components/account-shell";
import { CustomerNewsletterConsentForm } from "./customer-newsletter-consent";
import type { CustomerAccount } from "@/ontos/account";
import { isCustomerProfile } from "@/ontos/profile-model";
import type { CustomerProfile } from "@/ontos/profile-model";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

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
      setError(isError(error) ? error.message : "Uložení údajů se nepodařilo.");
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
      setError(isError(error) ? error.message : "Odhlášení se nepodařilo.");
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
      <h1 className="sr-only">Můj účet</h1>
      <Accordion
        defaultValue={["profile", "consent"]}
        multiple
        collapsible
        variant="borderless"
        shadow="none"
        size="sm"
        className="gap-(--dimension-60)"
      >
        <Accordion.Item value="profile">
          <Accordion.Header
            data-account-section-heading
            className="w-fit [&>button]:leading-(--akros-account-heading-leading) max-sm:[&>button]:min-h-(--dimension-44)"
          >
            <Accordion.Title>Kontaktní údaje</Accordion.Title>
            <Accordion.Indicator
              icon="token-icon-akros-account-disclosure"
              className="[&>span]:data-[state=expanded]:rotate-(--akros-account-disclosure-rotation)"
            />
          </Accordion.Header>
          <Accordion.Content className="pt-(--dimension-24)">
            <form
              action="/api/ontos/account/profile"
              className="grid max-w-(--akros-account-form-width) gap-(--dimension-32)"
              method="post"
              onSubmit={save}
            >
              <div className="grid gap-(--dimension-32) md:grid-cols-2">
                <FormInput
                  autoComplete="name"
                  disabled={pending !== null}
                  id="account-name"
                  label="Jméno a příjmení"
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
              </div>
              <p>
                Kontaktní údaje se ukládají do OntOS. Jejich změna nemění přihlašovací e-mail ani
                heslo.
              </p>
              <div className="flex flex-wrap justify-end gap-(--dimension-16)">
                <Button disabled={pending !== null} size="sm" type="submit" variant="primary">
                  {pending === "save" ? "Ukládám…" : "Uložit změny"}
                </Button>
                <Button
                  disabled={pending !== null}
                  onClick={logout}
                  size="sm"
                  type="button"
                  variant="secondary"
                  theme="outlined"
                >
                  {pending === "logout" ? "Odhlašuji…" : "Odhlásit se"}
                </Button>
              </div>
              {saved && <output>Údaje byly uloženy v OntOS a znovu načteny.</output>}
              {error && <p role="alert">{error}</p>}
            </form>
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="consent">
          <Accordion.Header
            data-account-section-heading
            className="w-fit [&>button]:leading-(--akros-account-heading-leading) max-sm:[&>button]:min-h-(--dimension-44)"
          >
            <Accordion.Title>Odběr novinek</Accordion.Title>
            <Accordion.Indicator
              icon="token-icon-akros-account-disclosure"
              className="[&>span]:data-[state=expanded]:rotate-(--akros-account-disclosure-rotation)"
            />
          </Accordion.Header>
          <Accordion.Content className="pt-(--dimension-24)">
            <CustomerNewsletterConsentForm />
          </Accordion.Content>
        </Accordion.Item>
      </Accordion>
    </AccountShell>
  );
}
