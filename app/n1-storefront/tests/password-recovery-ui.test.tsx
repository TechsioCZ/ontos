import { describe, expect, it } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthView } from "../src/features/auth-view";
import { PasswordRecoveryView } from "../src/features/password-recovery-view";
import { getDictionary } from "../src/i18n";
import { Schema } from "effect";
import { PasswordRecoveryRequestSchema } from "../src/ontos/password-recovery";

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

  it.each(["cs", "en"])(
    "rejects malformed recovery identifiers in the %s browser form",
    (locale) => {
      const html = renderToStaticMarkup(
        createElement(PasswordRecoveryView, {
          dictionary: getDictionary(locale),
          locale,
          mode: "request",
        }),
      );
      const input = /<input[^>]*name="email"[^>]*>/u.exec(html)?.[0];
      const pattern = /pattern="(?<pattern>[^"]+)"/u.exec(input ?? "")?.groups?.pattern;
      expect(pattern).toBeDefined();
      if (pattern === undefined) {
        return;
      }
      const browserPattern = new RegExp(`^(?:${pattern})$`, "u");
      for (const email of [
        "not-an-email",
        "qa@example",
        "qa@@example.com",
        "qa@exam ple.com",
        "qa@example.invalid",
        "test+demo@example.com",
      ]) {
        expect(browserPattern.test(email)).toBe(
          Schema.is(PasswordRecoveryRequestSchema)({ email }),
        );
      }
    },
  );

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
