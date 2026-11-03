import { describe, expect, it } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthView } from "../src/features/auth-view";
import { MiniLogin } from "../src/features/mini-login";
import { getDictionary } from "../src/i18n";

const dictionary = getDictionary("en");
describe("shared page and header login", () => {
  it("assigns independent field IDs when multiple shared forms are mounted", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(AuthView, { dictionary, locale: "en", mode: "login" }),
        createElement(AuthView, { dictionary, locale: "en", mode: "login" }),
      ),
    );
    const emails = [...markup.matchAll(/id="(?<field>[^"]+-email)"/gu)].map(
      (match) => match.groups?.field,
    );
    const passwords = [...markup.matchAll(/id="(?<field>[^"]+-password)"/gu)].map(
      (match) => match.groups?.field,
    );
    expect(emails).toHaveLength(2);
    expect(new Set(emails).size).toBe(2);
    expect(passwords).toHaveLength(2);
    expect(new Set(passwords).size).toBe(2);
    for (const id of [...emails, ...passwords]) {
      expect(markup).toContain(`for="${id}"`);
    }
    expect(markup).toContain('href="/en/registrace"');
    expect(markup).toContain('action="/api/account/login"');
  });
  it("keeps callback verification a notice with the login form, never customer admission", () => {
    const markup = renderToStaticMarkup(
      createElement(AuthView, {
        dictionary,
        locale: "en",
        mode: "login",
        verification: "verified",
      }),
    );
    expect(markup).toContain(dictionary.auth.emailVerified);
    expect(markup).toContain('action="/api/account/login"');
    expect(markup).not.toContain(dictionary.auth.admitted);
  });
  it("renders the existing account asset as a real controlled popover trigger", () => {
    const markup = renderToStaticMarkup(
      createElement(MiniLogin, {
        dictionary,
        locale: "en",
        onOpenChange: () => {},
        open: false,
      }),
    );
    expect(markup).toContain(`aria-label="${dictionary.account}"`);
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("account-outline.svg");
    expect(markup).not.toContain('href="/en/prihlaseni"');
  });
});
