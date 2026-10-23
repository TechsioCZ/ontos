"use client";

import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { AccountShell } from "@/components/account-shell";
import type { CustomerAccount } from "@/ontos/account";

/** Render only the account admitted by the Commerce owner; never browser-local profile data. */
export function AccountProfilePage({ account }: { account: CustomerAccount }) {
  return (
    <AccountShell active="profile">
      <h1>Můj účet</h1>
      <div className="akros-auth-form">
        <FormInput id="account-name" name="name" label="Jméno" value={account.name} readOnly autoComplete="name" size="sm" />
        <FormInput id="account-email" name="email" label="Přihlašovací e-mail" value={account.email} readOnly type="email" autoComplete="username" size="sm" />
        <p>Přihlašovací e-mail ani heslo nelze změnit úpravou kontaktních údajů.</p>
      </div>
    </AccountShell>
  );
}
