import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm, RegistrationForm } from "@/components/auth-form";

const router = vi.hoisted(() => ({
  push: vi.fn<(path: string) => void>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const fetchAccount = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchAccount);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fill(id: string, value: string) {
  fireEvent.change(document.getElementById(id)!, { target: { value } });
}
function login() {
  fill("login-email", "real@example.test");
  fill("login-password", "real-long-password");
  fireEvent.submit(document.getElementById("login-password")!.closest("form")!);
}
function register(confirmation = "real-long-password") {
  for (const [id, value] of Object.entries({
    "register-first-name": "Real",
    "register-last-name": "Customer",
    "register-email": "real@example.test",
    "register-phone": "+420777123456",
    "register-password": "real-long-password",
    "register-password-confirm": confirmation,
  }))
    fill(id, value);
  fireEvent.click(screen.getByRole("checkbox", { name: /Souhlasím/ }));
  fireEvent.submit(document.getElementById("register-password")!.closest("form")!);
}

describe("real customer forms", () => {
  it("does not navigate or store a profile when real authentication rejects the password", async () => {
    fetchAccount.mockResolvedValue(
      Response.json({ message: "Nesprávný e-mail nebo heslo." }, { status: 401 }),
    );
    render(<LoginForm />);
    login();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Nesprávný e-mail nebo heslo.",
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it("checks admission after a created session instead of assuming enrollment completed", async () => {
    fetchAccount.mockResolvedValue(Response.json({ outcome: "SESSION_CREATED" }));
    render(<LoginForm />);
    login();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dokonceni-registrace"));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(localStorage.length).toBe(0);
  });
  it("rejects mismatched passwords without submitting credentials", async () => {
    render(<RegistrationForm />);
    register("different-password");
    expect((await screen.findByRole("alert")).textContent).toContain("Hesla se neshodují.");
    expect(fetchAccount).not.toHaveBeenCalled();
  });
  it("sends phone and consent and truthfully acknowledges started enrollment, not a completed fake profile", async () => {
    fetchAccount.mockResolvedValue(Response.json({ outcome: "ENROLLMENT_STARTED" }));
    render(<RegistrationForm />);
    register();
    expect(await screen.findByText(/Registrace byla přijata/)).toBeTruthy();
    const [path, init] = fetchAccount.mock.calls[0]!;
    expect(path).toBe("/api/ontos/account");
    expect(JSON.parse(String(init!.body))).toMatchObject({
      operation: "register",
      phone: "+420777123456",
      termsAccepted: true,
      password: "real-long-password",
      passwordConfirmation: "real-long-password",
    });
    expect(localStorage.length).toBe(0);
    expect(screen.getByRole("button", { name: "Vytvořit účet" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.queryByText(/Účet byl vytvořen/)).toBeNull();
  });
});

it("offers a real email-only resend on login without navigating or persisting a profile", async () => {
  fetchAccount.mockResolvedValue(Response.json({ outcome: "EMAIL_VERIFICATION_STARTED" }));
  render(<LoginForm />);
  fill("verification-resend-email", "waiting@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Poslat ověřovací e-mail znovu" }));
  expect(await screen.findByText(/Pokud účet s tímto e-mailem čeká na ověření/)).toBeTruthy();
  const [path, init] = fetchAccount.mock.calls[0]!;
  expect(path).toBe("/api/ontos/account");
  expect(JSON.parse(String(init!.body))).toEqual({
    operation: "resend-verification",
    email: "waiting@example.test",
  });
  expect(router.push).not.toHaveBeenCalled();
  expect(router.refresh).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});

it("disables resend while awaiting the owner and shows a real rate-limit refusal", async () => {
  let complete: (value: Response) => void = () => {
    throw new Error("Request not pending");
  };
  fetchAccount.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  render(<LoginForm />);
  fill("verification-resend-email", "waiting@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Poslat ověřovací e-mail znovu" }));
  expect(screen.getByRole("button", { name: "Odesílám…" }).hasAttribute("disabled")).toBe(true);
  expect(fetchAccount).toHaveBeenCalledOnce();
  complete(
    Response.json({ message: "Příliš mnoho pokusů. Zkuste to prosím později." }, { status: 429 }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("Příliš mnoho pokusů");
  expect(screen.queryByText(/Pokud účet s tímto e-mailem čeká na ověření/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Poslat ověřovací e-mail znovu" }).hasAttribute("disabled"),
  ).toBe(false);
});
