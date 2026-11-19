import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/account/route";
import { LoginForm, RegistrationForm } from "@/components/auth-form";
import { VerificationResendForm } from "@/components/verification-resend-form";
import { dictionaryFor } from "@/i18n";
import { MarketProvider } from "@/ontos/market-context";
import { MARKET_LOCALE_HEADER } from "@/ontos/market-locale";
import { browserAt, serveHttp } from "../support/http";

const originalPath = window.location.href;
const email = "locale@example.test";
const password = "locale-test-password";
const legalEntityId = "71000000-0000-4000-8000-000000000024";
const ownerBase = "/shell-super-app-api/commerce-customer-context";
const navigations: string[] = [];
// Explicit framework input: every router action is observable, without replacing next/navigation.
const router = {
  bfcacheId: "auth-form-locale",
  back: () => {
    navigations.push("back");
  },
  forward: () => {
    navigations.push("forward");
  },
  refresh: () => {
    navigations.push("refresh");
  },
  hmrRefresh: () => {
    navigations.push("hmrRefresh");
  },
  push: (href: string) => {
    navigations.push(`push:${href}`);
  },
  replace: (href: string) => {
    navigations.push(`replace:${href}`);
  },
  prefetch: (href: string) => {
    navigations.push(`prefetch:${href}`);
  },
};
let network: Awaited<ReturnType<typeof serveHttp>>;
let ownerStatus: number;
let ownerBody: { code?: string };

beforeEach(async () => {
  navigations.length = 0;
  ownerStatus = 503;
  ownerBody = {};
  network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/ontos/account") {
      // happy-dom omits Origin on same-origin POSTs. Supply this explicit route-input
      // fixture at the server boundary, as the original test did; never replace fetch.
      request.headers.set("origin", network.origin);
      return POST(request);
    }
    if (path === "/shell-super-app-api/auth/api-key/gateway-context") {
      return Response.json({
        apiBaseUrl: ownerBase,
        compositionRevision: "a".repeat(64),
        token: "locale-test-gateway-assertion",
        expiresAt: Date.now() + 60_000,
      });
    }
    if (path.startsWith(`${ownerBase}/api/portal-auth/`)) {
      return Response.json(ownerBody, { status: ownerStatus });
    }
    return Response.json({ message: `Unexpected request: ${path}` }, { status: 404 });
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "locale-test-api-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
});

afterEach(async () => {
  cleanup();
  await network.close();
  browserAt(originalPath);
  vi.unstubAllEnvs();
});

function input(id: string) {
  const element = document.querySelector<HTMLInputElement>(`input[id="${id}"]`);
  if (!element) throw new Error(`Missing input: ${id}`);
  return element;
}

function fill(id: string, value: string) {
  fireEvent.change(input(id), { target: { value } });
}

function submit(id: string) {
  const form = input(id).form;
  if (!form) throw new Error(`Missing form for: ${id}`);
  fireEvent.submit(form);
}

function browserRequests() {
  return network.requests.filter(
    (request) => new URL(request.url).pathname === "/api/ontos/account",
  );
}

function ownerRequests() {
  return network.requests.filter((request) =>
    new URL(request.url).pathname.startsWith(`${ownerBase}/api/portal-auth/`),
  );
}

function requestAt(requests: Request[], index: number) {
  const request = requests[index];
  if (!request) throw new Error(`Missing request ${index}`);
  return request;
}

// The saved request stays readable for both payload equality and field-level assertions.
async function requestBody(request: Request) {
  const body: unknown = await request.clone().json();
  return body;
}

describe.each(["cs", "sk", "en"] as const)("authentication in the %s market", (locale) => {
  const copy = dictionaryFor(locale);

  function mount(Component: typeof LoginForm) {
    browserAt(`${network.origin}/${locale}/prihlaseni`);
    return render(
      <AppRouterContext.Provider value={router}>
        <MarketProvider
          market={{
            locale,
            marketCode: `TEST-${locale}`,
            currency: "EUR",
            formatLocale: locale,
            configured: true,
            live: [],
          }}
        >
          <Component />
        </MarketProvider>
      </AppRouterContext.Provider>,
    );
  }

  async function expectSingleRequest(operation: string, ownerPath: string) {
    // Called after the visible route response; idle closes the count/non-navigation observation window.
    await network.idle();
    expect(browserRequests()).toHaveLength(1);
    const request = requestAt(browserRequests(), 0);
    expect(new URL(request.url).pathname).toBe("/api/ontos/account");
    expect(request.method).toBe("POST");
    expect(request.headers.get(MARKET_LOCALE_HEADER)).toBe(locale);
    expect(await requestBody(request)).toMatchObject({ operation, email });
    expect(ownerRequests()).toHaveLength(1);
    const owner = requestAt(ownerRequests(), 0);
    expect(new URL(owner.url).pathname).toBe(`${ownerBase}/api/portal-auth${ownerPath}`);
    expect(owner.method).toBe("POST");
    expect(navigations).toEqual([]);
  }

  it("shows the route's localized credential refusal without replaying the password", async () => {
    ownerStatus = 401;
    ownerBody = { code: "invalid_credentials" };
    mount(LoginForm);
    fill("login-email", email);
    fill("login-password", password);
    submit("login-password");

    expect((await screen.findByRole("alert")).textContent).toBe(
      copy.server.account.wrongCredentials,
    );
    await expectSingleRequest("login", "/sign-in/email");
    expect(await requestBody(requestAt(browserRequests(), 0))).toMatchObject({ password });
  });

  it("keeps the locale and request identity across an explicit registration retry only", async () => {
    ownerStatus = 503;
    mount(RegistrationForm);
    for (const [id, value] of Object.entries({
      "register-first-name": "Locale",
      "register-last-name": "Customer",
      "register-email": email,
      "register-phone": "+420777123456",
      "register-password": password,
      "register-password-confirm": password,
    })) {
      fill(id, value);
    }
    // The UI-kit checkbox toggles on a real pointer or keyboard activation, not on a bare synthetic click.
    await userEvent.click(
      screen.getByRole("checkbox", { name: (name) => name.includes(copy.auth.consent) }),
    );
    submit("register-password");

    expect((await screen.findByRole("alert")).textContent).toBe(copy.server.account.unavailable);
    await expectSingleRequest("register", "/enrollment/start");
    const initialBody = await requestAt(browserRequests(), 0).clone().text();
    const firstKey = requestAt(ownerRequests(), 0).headers.get("idempotency-key");
    expect(firstKey).toMatch(/^storefront-enrollment:[\da-f-]{36}$/u);
    expect(await requestBody(requestAt(browserRequests(), 0))).toMatchObject({
      password,
      passwordConfirmation: password,
      termsAccepted: true,
    });

    submit("register-password");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      copy.server.account.unavailable,
    );
    await network.idle();
    expect(ownerRequests()).toHaveLength(2);
    expect(browserRequests()).toHaveLength(2);
    expect(await requestAt(browserRequests(), 1).clone().text()).toBe(initialBody);
    expect(requestAt(browserRequests(), 1).headers.get(MARKET_LOCALE_HEADER)).toBe(locale);
    expect(requestAt(ownerRequests(), 1).headers.get("idempotency-key")).toBe(firstKey);
  });

  it("shows the localized resend refusal with an email-only owner request", async () => {
    ownerStatus = 429;
    mount(VerificationResendForm);
    fill("verification-resend-email", email);
    submit("verification-resend-email");

    expect((await screen.findByRole("alert")).textContent).toBe(
      copy.server.account.tooManyAttempts,
    );
    await expectSingleRequest("resend-verification", "/send-verification-email");
    expect(await requestBody(requestAt(browserRequests(), 0))).toEqual({
      operation: "resend-verification",
      email,
    });
    expect(await requestBody(requestAt(ownerRequests(), 0))).toEqual({ email });
  });
});
