import { describe, expect, it } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthContent } from "../src/features/auth-view";
import { getDictionary } from "../src/i18n";
import type { PortalOutcome } from "../src/ontos/portal";

const renderFeedback = (
  state: "refused" | "unavailable" | "unconfirmed" | "verification-required",
  locale: string,
) => {
  const outcome: PortalOutcome = { state };
  return renderToStaticMarkup(
    <AuthContent
      controller={{
        edit: () => {},
        loaded: true,
        outcome,
        pending: false,
        run: () => {},
        submit: () => {},
        submitting: false,
      }}
      dictionary={getDictionary(locale)}
      locale={locale}
      mode="register"
    />,
  );
};

describe("owner auth feedback presentation", () => {
  it.each(["cs", "en"])(
    "marks confirmed refusal and unavailability as general errors in %s",
    (locale) => {
      for (const state of ["refused", "unavailable"] as const) {
        const html = renderFeedback(state, locale);
        expect(html).toContain(getDictionary(locale).auth[state]);
        expect(html).toContain('data-status="error"');
        expect(html).toContain('aria-atomic="true"');
        expect(html.match(/role="alert"/gu)).toHaveLength(1);
        expect(html).not.toContain('aria-invalid="true"');
      }
    },
  );
  it.each(["cs", "en"])(
    "does not call uncertain or verification-pending registration a failure in %s",
    (locale) => {
      for (const state of ["unconfirmed", "verification-required"] as const) {
        const html = renderFeedback(state, locale);
        expect(html).not.toContain('data-status="error"');
        expect(html).toContain('aria-live="polite"');
        expect(html).not.toContain('role="alert"');
        expect(html).not.toContain('name="password"');
      }
    },
  );
});
