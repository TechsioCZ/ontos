import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/account/route";
import { LoginForm, RegistrationForm } from "@/components/auth-form";
import { VerificationResendForm } from "@/components/verification-resend-form";
import { dictionaryFor } from "@/i18n";
import { ownerRequest } from "@/ontos/gateway";
import { MarketProvider } from "@/ontos/market-context";
import { MARKET_LOCALE_HEADER } from "@/ontos/market-locale";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/ontos/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ontos/gateway")>()),
  ownerRequest: vi.fn<typeof ownerRequest>(),
}));
vi.mock("@/ontos/config", () => ({
  getConfig: () => ({ legalEntityId: "server-selling-entity" }),
}));

const fetchAccount = vi.fn<typeof fetch>();
const originalPath = window.location.href;
const email = "locale@example.test";
const password = "locale-test-password";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchAccount);
  fetchAccount.mockImplementation((_input, init) =>
    POST(
      new Request(`${window.location.origin}/api/ontos/account`, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          origin: window.location.origin,
        },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", originalPath);
  vi.unstubAllGlobals();
});

function fill(id: string, value: string) {
  fireEvent.change(document.getElementById(id)!, { target: { value } });
}

function submit(id: string) {
  fireEvent.submit(document.getElementById(id)!.closest("form")!);
}

function requestBody(init: RequestInit | undefined) {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected a JSON string request body");
  }
  return JSON.parse(init.body);
}

describe.each(["cs", "sk", "en"] as const)("authentication in the %s market", (locale) => {
  const copy = dictionaryFor(locale);

  function mount(Component: typeof LoginForm) {
    window.history.replaceState(null, "", `/${locale}/prihlaseni`);
    return render(
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
      </MarketProvider>,
    );
  }

  function expectSingleRequest(operation: string) {
    expect(fetchAccount).toHaveBeenCalledOnce();
    const [path, init] = fetchAccount.mock.calls[0]!;
    expect(path).toBe("/api/ontos/account");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get(MARKET_LOCALE_HEADER)).toBe(locale);
    expect(requestBody(init)).toMatchObject({ operation, email });
    expect(ownerRequest).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  }

  it("shows the route's localized credential refusal without replaying the password", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json({ code: "invalid_credentials" }, { status: 401 }),
    );
    mount(LoginForm);
    fill("login-email", email);
    fill("login-password", password);
    submit("login-password");

    expect((await screen.findByRole("alert")).textContent).toBe(
      copy.server.account.wrongCredentials,
    );
    expectSingleRequest("login");
    expect(requestBody(fetchAccount.mock.calls[0]![1])).toMatchObject({ password });
  });

  it("keeps the locale and request identity across an explicit registration retry only", async () => {
    vi.mocked(ownerRequest).mockImplementation(async () => Response.json({}, { status: 503 }));
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
    expectSingleRequest("register");
    const initialBody = fetchAccount.mock.calls[0]![1]?.body;
    const firstKey = new Headers(vi.mocked(ownerRequest).mock.calls[0]![2]?.headers).get(
      "idempotency-key",
    );
    expect(firstKey).toMatch(/^storefront-enrollment:[\da-f-]{36}$/u);
    expect(requestBody(fetchAccount.mock.calls[0]![1])).toMatchObject({
      password,
      passwordConfirmation: password,
      termsAccepted: true,
    });

    submit("register-password");
    await waitFor(() => expect(ownerRequest).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      copy.server.account.unavailable,
    );
    expect(fetchAccount).toHaveBeenCalledTimes(2);
    expect(fetchAccount.mock.calls[1]![1]?.body).toBe(initialBody);
    expect(new Headers(fetchAccount.mock.calls[1]![1]?.headers).get(MARKET_LOCALE_HEADER)).toBe(
      locale,
    );
    expect(
      new Headers(vi.mocked(ownerRequest).mock.calls[1]![2]?.headers).get("idempotency-key"),
    ).toBe(firstKey);
  });

  it("shows the localized resend refusal with an email-only owner request", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(Response.json({}, { status: 429 }));
    mount(VerificationResendForm);
    fill("verification-resend-email", email);
    submit("verification-resend-email");

    expect((await screen.findByRole("alert")).textContent).toBe(
      copy.server.account.tooManyAttempts,
    );
    expectSingleRequest("resend-verification");
    expect(requestBody(fetchAccount.mock.calls[0]![1])).toEqual({
      operation: "resend-verification",
      email,
    });
    expect(requestBody(vi.mocked(ownerRequest).mock.calls[0]![2])).toEqual({ email });
  });
});
