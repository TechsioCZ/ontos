"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import StoreLink from "@/components/store-link";
import Image from "next/image";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { PhoneInput } from "@techsio/ui-kit/molecules/phone-input";
import { Accordion } from "@techsio/ui-kit/molecules/accordion";
import { AccountShell } from "@/components/account-shell";
import { useAccountProfileSnapshot } from "./use-account-profile";
import { CheckoutSelect } from "@/features/checkout/checkout-select";
import {
  accountProfileStorageKey,
  parseAccountProfile,
  validateAccountProfile,
  type AccountProfile,
  type AccountProfileErrors,
} from "@/mock-storefront/account-profile";

const sections = ["contact", "billing", "company"];
const phoneCountries = [
  {
    value: "CZ" as const,
    label: "Česká republika",
    callingCode: "420",
    flag: <Image src="/akros/account/czechia.svg" width={40} height={40} alt="" />,
  },
];
type AccountTextKey = Exclude<keyof AccountProfile, "newsletter" | "privacyConsent">;

function ProfileSection({
  value,
  title,
  id,
  children,
}: {
  value: string;
  title: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <Accordion.Item value={value} id={id}>
      <Accordion.Header
        data-account-section-heading
        className="w-fit [&>button]:gap-(--dimension-10) [&>button]:leading-(--akros-account-heading-leading) max-sm:[&>button]:min-h-(--dimension-44)"
      >
        <Accordion.Title>{title}</Accordion.Title>
        <Accordion.Indicator
          icon="token-icon-akros-account-disclosure"
          className="[&>span]:data-[state=expanded]:rotate-(--akros-account-disclosure-rotation)"
        />
      </Accordion.Header>
      <Accordion.Content className="pt-(--dimension-24)">{children}</Accordion.Content>
    </Accordion.Item>
  );
}

export function AccountProfilePage() {
  const stored = useAccountProfileSnapshot();
  const [edited, setEdited] = useState<AccountProfile | null>(null);
  const profile = edited ?? parseAccountProfile(stored ?? null);
  const ready = stored !== undefined;
  const [open, setOpen] = useState(sections);
  const [errors, setErrors] = useState<AccountProfileErrors>({});
  const [feedback, setFeedback] = useState("");
  const [companyFeedback, setCompanyFeedback] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const hash = window.location.hash;
    const frame = requestAnimationFrame(() => {
      if (hash === "#dorucovaci-adresa") setOpen([...sections, "delivery"]);
      if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const update = <K extends keyof AccountProfile>(key: K, value: AccountProfile[K]) => {
    setEdited((current) => ({ ...(current ?? profile), [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setFeedback("");
  };
  const input = (key: AccountTextKey, label: string, autoComplete?: string, type = "text") => (
    <div
      data-account-field
      data-invalid={errors[key] ? "true" : undefined}
      className="max-w-(--akros-account-field-width)"
    >
      <FormInput
        id={`account-${key}`}
        name={key}
        label={label}
        size="sm"
        type={type}
        autoComplete={autoComplete}
        value={profile[key]}
        onChange={(event) => update(key, event.target.value)}
        validateStatus={errors[key] ? "error" : "default"}
        helpText={errors[key]}
        showHelpTextIcon={false}
      />
    </div>
  );
  const phone = (key: "phone" | "phone2", label: string) => (
    <PhoneInput
      id={`account-${key}`}
      countries={phoneCountries}
      defaultCountry="CZ"
      size="sm"
      value={profile[key]}
      onValueChange={({ value }) => update(key, value)}
      nativeValidation={false}
      validateStatus={errors[key] ? "error" : "default"}
    >
      <PhoneInput.Label>{label}</PhoneInput.Label>
      <PhoneInput.Control
        data-account-phone-control
        className="gap-(--dimension-4) overflow-visible"
      >
        <PhoneInput.CountryPicker
          triggerProps={{
            "aria-label": `Předvolba: ${label}`,
            className: "rounded-input-sm max-sm:w-auto [&>.token-icon-select-indicator]:hidden",
            children: (
              <>
                <PhoneInput.CountryValue>
                  <PhoneInput.CountryFlag />
                  <PhoneInput.CountryCallingCode />
                </PhoneInput.CountryValue>
                <Icon icon="token-icon-akros-account-select-chevron" />
              </>
            ),
          }}
        />
        <PhoneInput.Input
          autoComplete="billing tel"
          placeholder="111 222 333"
          className="border-(length:--border-width-input)"
        />
      </PhoneInput.Control>
      {errors[key] && <PhoneInput.StatusText status="error">{errors[key]}</PhoneInput.StatusText>}
    </PhoneInput>
  );
  return (
    <AccountShell active="profile">
      <h1 className="sr-only">Můj účet</h1>
      {!ready ? (
        <output>Načítám údaje…</output>
      ) : (
        <form
          action="/muj-ucet"
          method="post"
          ref={formRef}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const invalid = validateAccountProfile(profile);
            setErrors(invalid);
            if (Object.keys(invalid).length) {
              const requiredSections = Object.keys(invalid).map((key) =>
                key.startsWith("delivery")
                  ? "delivery"
                  : ["email", "newsletter", "privacyConsent"].includes(key)
                    ? "contact"
                    : ["company", "companyId", "vatId"].includes(key)
                      ? "company"
                      : "billing",
              );
              setOpen((current) => [...new Set([...current, ...requiredSections])]);
              requestAnimationFrame(() =>
                formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
              );
              setFeedback("Zkontrolujte zvýrazněné údaje.");
              return;
            }
            if (password || confirmation) {
              setOpen((current) => [...new Set([...current, "contact"])]);
              setFeedback(
                "Změna hesla není připojena k účtu. Pro uložení ostatních údajů vymažte pole hesla.",
              );
              return;
            }
            try {
              localStorage.setItem(
                accountProfileStorageKey,
                JSON.stringify({ version: 1, profile }),
              );
              setFeedback("Údaje byly uložené v tomto prohlížeči.");
            } catch {
              setFeedback(
                "Údaje se nepodařilo uložit. Povolte úložiště prohlížeče a zkuste to znovu.",
              );
            }
          }}
        >
          <Accordion
            value={open}
            onChange={setOpen}
            multiple
            collapsible
            variant="borderless"
            shadow="none"
            size="sm"
            className="gap-(--dimension-60)"
          >
            <ProfileSection value="contact" title="Kontaktní údaje" id="kontaktni-udaje">
              <div className="grid max-w-(--akros-account-form-width) gap-(--dimension-24) md:grid-cols-2">
                <div className="grid gap-(--dimension-32)">
                  {input("email", "Email", "username", "email")}
                  <div id="zmena-hesla">
                    <FormInput
                      id="account-password"
                      name="password"
                      minLength={12}
                      {...{ passwordrules: "minlength: 12;" }}
                      label="Heslo"
                      size="sm"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <FormInput
                    id="account-password-confirmation"
                    name="passwordConfirmation"
                    minLength={12}
                    {...{ passwordrules: "minlength: 12;" }}
                    label="Potvrdit heslo"
                    size="sm"
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                  />
                </div>
                <aside className="grid h-fit gap-(--dimension-32) rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24)">
                  <h2 className="text-(length:--akros-account-section-size) leading-(--akros-account-heading-leading) font-bold">
                    Přejete si dostávat občasné emaily s aktuálními nabídkami
                  </h2>
                  <div data-account-newsletter>
                    <FormCheckbox
                      className="[&_[data-part=control]]:border-(length:--border-width-checkbox) [&_[data-part=indicator][data-state=checked]]:token-icon-circle [&_[data-part=indicator]]:text-(length:--dimension-16)"
                      id="account-newsletter"
                      size="sm"
                      label="Chci odebírat novinky"
                      checked={profile.newsletter}
                      onCheckedChange={(value) => update("newsletter", value)}
                    />
                  </div>
                  <FormCheckbox
                    className="[&_[data-part=control]]:border-(length:--border-width-checkbox)"
                    id="account-privacy"
                    size="sm"
                    label={
                      <>
                        Souhlasím se zpracováním{" "}
                        <StoreLink href="/gdpr" className="underline">
                          osobních údajů
                        </StoreLink>
                      </>
                    }
                    checked={profile.privacyConsent}
                    onCheckedChange={(value) => update("privacyConsent", value)}
                    validateStatus={errors.privacyConsent ? "error" : "default"}
                    helpText={errors.privacyConsent}
                  />
                </aside>
              </div>
            </ProfileSection>
            <ProfileSection value="billing" title="Fakturační údaje" id="fakturacni-udaje">
              <div className="grid max-w-(--akros-account-billing-width) gap-x-(--dimension-24) gap-y-(--dimension-32) md:grid-cols-2">
                {input("firstName", "Jméno", "billing given-name")}
                {input("street", "Ulice", "billing street-address")}
                {input("lastName", "Příjmení", "billing family-name")}
                {input("city", "Město", "billing address-level2")}
                {input("billingEmail", "Email", "billing email", "email")}
                {input("postalCode", "PSČ", "billing postal-code")}
                {phone("phone", "Telefon")}
                <CheckoutSelect
                  id="account-country"
                  label="Země"
                  items={[{ value: "CZ", label: "Česká republika" }]}
                  value={profile.country}
                  error={errors.country}
                  onChange={(value) => update("country", value)}
                  indicator={<Icon icon="token-icon-akros-account-select-chevron" />}
                />
                {phone("phone2", "Telefon 2")}
              </div>
            </ProfileSection>
            <ProfileSection value="company" title="Firemní údaje" id="firemni-udaje">
              <div className="grid gap-(--dimension-24)">
                <Button
                  data-account-action
                  type="button"
                  size="sm"
                  variant="primary"
                  uppercase
                  className="w-full max-w-(--akros-account-save-width) leading-(--akros-account-heading-leading)"
                  onClick={() =>
                    setCompanyFeedback(
                      "ARES není v této ukázce připojený. Firemní údaje můžete vyplnit ručně.",
                    )
                  }
                >
                  Načíst data z ARES
                </Button>
                {companyFeedback && (
                  <output className="text-(length:--dimension-16)">{companyFeedback}</output>
                )}
                <div className="grid max-w-(--akros-account-field-width) gap-(--dimension-32)">
                  {input("company", "Společnost", "organization")}
                  {input("companyId", "IČ")}
                  {input("vatId", "DIČ")}
                </div>
              </div>
            </ProfileSection>
            <ProfileSection value="delivery" title="Doručovací adresa" id="dorucovaci-adresa">
              <div className="grid max-w-(--akros-account-form-width) gap-(--dimension-24) md:grid-cols-2">
                {input("deliveryStreet", "Ulice", "shipping street-address")}
                {input("deliveryCity", "Město", "shipping address-level2")}
                {input("deliveryPostalCode", "PSČ", "shipping postal-code")}
              </div>
              <p className="mt-(--dimension-16) text-(length:--dimension-16)">
                Prázdná doručovací adresa znamená použití fakturační adresy.
              </p>
            </ProfileSection>
          </Accordion>
          <div className="mt-(--akros-account-actions-gap) flex flex-wrap items-center justify-end gap-(--dimension-24)">
            {feedback && (
              <output className="min-w-0 flex-1 text-(length:--dimension-16)">{feedback}</output>
            )}
            <Button
              data-account-action
              type="submit"
              size="sm"
              variant="primary"
              uppercase
              className="w-full leading-(--akros-account-heading-leading) md:w-(--akros-account-save-width)"
            >
              Změnit údaje
            </Button>
          </div>
        </form>
      )}
    </AccountShell>
  );
}
