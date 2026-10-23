import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { LoginForm, RegistrationForm } from "@/components/auth-form";
import { AccountProfilePage } from "@/features/account/account-profile-page";
import { CartProvider } from "@/features/cart/cart-provider";

// These markup tests never navigate. Fail if a form unexpectedly invokes the router.
function unexpectedNavigation(): never {
  throw new Error("Unexpected navigation");
}
const router = {
  bfcacheId: "auth-form-attributes",
  back: unexpectedNavigation,
  forward: unexpectedNavigation,
  refresh: unexpectedNavigation,
  hmrRefresh: unexpectedNavigation,
  push: unexpectedNavigation,
  replace: unexpectedNavigation,
  prefetch: unexpectedNavigation,
};

afterEach(cleanup);

function expectInput(id: string, attributes: Record<string, string>) {
  const input = document.getElementById(id);
  expect(input).toBeInstanceOf(HTMLInputElement);
  for (const [name, value] of Object.entries(attributes)) {
    expect(input?.getAttribute(name), `${id}: ${name}`).toBe(value);
  }
  return input as HTMLInputElement;
}

function expectForm(input: HTMLInputElement, action: string) {
  expect(input.form?.getAttribute("method")).toBe("post");
  expect(input.form?.getAttribute("action")).toBe(action);
}

function expectNewPasswords(firstId: string, confirmationId: string) {
  const attributes = {
    type: "password",
    autocomplete: "new-password",
    minlength: "12",
    passwordrules: "minlength: 12;",
  };
  const first = expectInput(firstId, { ...attributes, name: "password" });
  const confirmation = expectInput(confirmationId, {
    ...attributes,
    name: "passwordConfirmation",
  });
  expect(first.form).not.toBeNull();
  expect(first.form).toBe(confirmation.form);
  expect(first.form?.querySelectorAll('input[autocomplete="new-password"]')).toHaveLength(2);
  return first;
}

describe("password-manager form semantics with the published UI-kit", () => {
  it("names registration fields and keeps both generated-password targets in one POST form", () => {
    render(<RegistrationForm />);

    expectInput("register-first-name", {
      name: "firstName",
      type: "text",
      autocomplete: "given-name",
    });
    expectInput("register-last-name", {
      name: "lastName",
      type: "text",
      autocomplete: "family-name",
    });
    // WHATWG permits one field-name token: username identifies this email as the credential.
    expectInput("register-email", { name: "email", type: "email", autocomplete: "username" });
    expectInput("register-phone", { name: "phone", type: "tel", autocomplete: "tel" });
    const password = expectNewPasswords("register-password", "register-password-confirm");
    expectForm(password, "/api/ontos/account");
    expect(password.required).toBe(true);
    expect(
      (document.getElementById("register-password-confirm") as HTMLInputElement).required,
    ).toBe(true);
    expect(screen.getByRole("checkbox", { name: /Souhlasím/ }).getAttribute("name")).toBe(
      "privacyConsent",
    );
    expect(screen.queryByRole("checkbox", { name: /newsletter/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Vytvořit účet" }).getAttribute("type")).toBe(
      "submit",
    );
  });

  it("identifies the login email as username and password as current-password", () => {
    render(
      <AppRouterContext.Provider value={router}>
        <LoginForm />
      </AppRouterContext.Provider>,
    );

    const email = expectInput("login-email", {
      name: "email",
      type: "email",
      autocomplete: "username",
    });
    const password = expectInput("login-password", {
      name: "password",
      type: "password",
      autocomplete: "current-password",
    });
    expectForm(password, "/api/ontos/account");
    expect(email.form).toBe(password.form);
    expect(screen.getByRole("checkbox", { name: "Zapamatovat si mě" }).getAttribute("name")).toBe(
      "rememberMe",
    );
  });

  it("shows the authenticated account and does not simulate password changes", () => {
    render(
      <AppRouterContext.Provider value={router}>
        <PathnameContext.Provider value="/muj-ucet">
          <CartProvider storage={null}>
            <AccountProfilePage
              account={{
                id: "customer-1",
                partyId: "party-1",
                tenantId: "tenant-1",
                email: "customer@example.test",
                name: "Customer One",
              }}
              profile={{
                displayName: "Customer One",
                phone: "",
                contactEmail: "customer@example.test",
                version: "a".repeat(64),
              }}
            />
          </CartProvider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    );

    expect(document.getElementById("account-password")).toBeNull();
    const email = expectInput("account-email", {
      name: "email",
      type: "email",
      autocomplete: "username",
    });
    expect(email.value).toBe("customer@example.test");
    expect(email.readOnly).toBe(true);
  });
});
