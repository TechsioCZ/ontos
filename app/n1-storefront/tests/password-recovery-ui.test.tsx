import { describe, expect, it } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthView } from "../src/features/auth-view";
import { PasswordRecoveryView } from "../src/features/password-recovery-view";
import { getDictionary } from "../src/i18n";

describe("password recovery presentation boundary", () => {
  it("does not offer a password submission without the server cookie-presence proof", () => {
    const html = renderToStaticMarkup(
      createElement(PasswordRecoveryView, {
        dictionary: getDictionary("cs"),
        locale: "cs",
        mode: "reset",
      }),
    );
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("<form");
    expect(html).toContain('href="/cs/zapomenute-heslo"');
    expect(html).toContain(getDictionary("cs").passwordRecovery.missingToken);
  });

  it("accepts only new password fields, never a browser-supplied reset token", () => {
    const html = renderToStaticMarkup(
      createElement(PasswordRecoveryView, {
        dictionary: getDictionary("cs"),
        locale: "cs",
        mode: "reset",
        tokenPresent: true,
      }),
    );
    expect(html).toContain('action="/api/account/password/reset"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="newPassword"');
    expect(html).toContain('name="passwordConfirmation"');
    expect(html).toContain('minLength="12"');
    expect(html).toContain('maxLength="128"');
    expect(html).not.toContain('name="token"');
    expect(html).not.toContain('type="hidden"');
  });

  it("offers the same identifier-only recovery form in English without account claims", () => {
    const html = renderToStaticMarkup(
      createElement(PasswordRecoveryView, {
        dictionary: getDictionary("en"),
        locale: "en",
        mode: "request",
      }),
    );
    expect(html).toContain('name="email"');
    expect(html).toContain('type="email"');
    expect(html).not.toContain('type="password"');
    expect(html).toContain(getDictionary("en").passwordRecovery.requestHeading);
    expect(html).toContain('href="/en/prihlaseni"');
    expect(html).not.toContain("accountId");
  });

  it("connects the existing Figma login link to the localized recovery route", () => {
    const html = renderToStaticMarkup(
      createElement(AuthView, {
        dictionary: getDictionary("en"),
        locale: "en",
        mode: "login",
      }),
    );
    expect(html).toContain('href="/en/zapomenute-heslo"');
  });
});
