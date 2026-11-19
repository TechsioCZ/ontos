import { describe, expect, it } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthContent, AuthView } from "../src/features/auth-view";
import { getDictionary } from "../src/i18n";

const dictionary = getDictionary("en");
describe("shared page and header login", () => {
  for (const locale of ["cs", "en"] as const) {
    for (const mode of ["login", "register"] as const) {
      it(`reserves the ${locale} ${mode} action label for a submission, not a session read`, () => {
        const copy = getDictionary(locale);
        for (const submitting of [false, true]) {
          const markup = renderToStaticMarkup(
            createElement(AuthContent, {
              controller: {
                edit: () => {},
                loaded: true,
                outcome: { state: "anonymous" },
                pending: true,
                run: () => {},
                submit: () => {},
                submitting,
              },
              dictionary: copy,
              locale,
              mode,
            }),
          );
          const button = /<button\b[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/u.exec(markup)?.[0];
          const action = mode === "login" ? copy.auth.signIn : copy.auth.register;
          const working = mode === "login" ? copy.auth.signingIn : copy.auth.registering;
          expect(button).toContain(submitting ? working : action);
          expect(button).toContain("disabled");
          expect(markup).toContain('aria-busy="true"');
        }
      });
    }
  }

  for (const mode of ["login", "register"] as const) {
    it(`rejects incomplete email domains at the ${mode} field before submission`, () => {
      const markup = renderToStaticMarkup(
        createElement(AuthView, { dictionary, locale: "en", mode }),
      );
      const emailInput = /<input\b[^>]*\bname="email"[^>]*>/u.exec(markup)?.[0];
      const pattern = /\bpattern="(?<constraint>[^"]+)"/u.exec(emailInput ?? "")?.groups
        ?.constraint;
      expect(pattern).toBeDefined();
      if (pattern === undefined) {
        return;
      }
      const constraint = new RegExp(`^(?:${pattern})$`, "v");
      for (const address of ["a@b", "name@", "not-an-email", "name@bad domain.test"]) {
        expect(constraint.test(address)).toBe(false);
      }
      for (const address of ["a@b.cz", "shopper+demo@example.test", "name@sub.example.com"]) {
        expect(constraint.test(address)).toBe(true);
      }
    });
  }
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
});

describe("ongoing MFA presentation", () => {
  for (const methods of [["totp"], ["otp"], ["totp", "otp"]] as const) {
    it(`offers only the native advertised ${methods.join("/")} methods before explicit choice`, () => {
      const html = renderToStaticMarkup(
        createElement(AuthContent, {
          controller: {
            edit: () => {},
            loaded: true,
            outcome: { methods, state: "mfa" },
            pending: false,
            run: () => {},
            submit: () => {},
            submitting: false,
          },
          dictionary,
          locale: "en",
          mode: "login",
        }),
      );
      for (const method of ["totp", "otp"] as const) {
        expect(html.includes(dictionary.auth.mfa.methods[method])).toBe(
          methods.some((value) => value === method),
        );
      }
      expect(html).not.toContain('name="password"');
      expect(html).not.toContain('name="code"');
      expect(html).not.toContain(dictionary.auth.mfa.otpSent);
      expect(html).not.toContain('name="trustDevice"');
    });
  }
  it("returns expired MFA to the credential form without an automatic resend", () => {
    const html = renderToStaticMarkup(
      createElement(AuthContent, {
        controller: {
          edit: () => {},
          loaded: true,
          outcome: { state: "mfa-expired" },
          pending: false,
          run: () => {},
          submit: () => {},
          submitting: false,
        },
        dictionary,
        locale: "en",
        mode: "login",
      }),
    );
    expect(html).toContain(dictionary.auth.mfa.expired);
    expect(html).toContain('name="password"');
    expect(html).not.toContain(dictionary.auth.mfa.sendOtp);
  });
});

for (const locale of ["cs", "en"] as const) {
  it(`keeps one accessible ${locale} rejection message before a method is chosen`, () => {
    const copy = getDictionary(locale);
    const html = renderToStaticMarkup(
      createElement(AuthContent, {
        controller: {
          edit: () => {},
          loaded: true,
          outcome: { feedback: "rejected", methods: ["totp"], state: "mfa" },
          pending: false,
          run: () => {},
          submit: () => {},
          submitting: false,
        },
        dictionary: copy,
        locale,
        mode: "login",
      }),
    );
    expect(html.split(copy.auth.mfa.rejected)).toHaveLength(2);
    expect(html).toContain('aria-live="polite"');
  });
}
