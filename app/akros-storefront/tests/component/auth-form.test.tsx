import { settleBrowser } from "../support/browser";
import {
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentAppRouterState } from "next/dist/client/components/app-router-instance";
import { browserAt, serveHttp } from "../support/http";
import { NextRouter, flightResponse } from "../support/router";
import { LoginForm, RegistrationForm } from "@/components/auth-form";
import { VerificationResendForm } from "@/components/verification-resend-form";
import { renderToString } from "react-dom/server";

const admissionReply = await flightResponse("signed in");

function render(children: ReactNode) {
  return renderComponent(<NextRouter>{children}</NextRouter>);
}
function isRefresh(request: Request) {
  return decodeURIComponent(request.headers.get("next-router-state-tree") ?? "").includes(
    "refetch",
  );
}
let network: Awaited<ReturnType<typeof serveHttp>>;
let responses: (Response | Promise<Response>)[];
let arrived: ReturnType<typeof Promise.withResolvers<void>>;
let refreshArrived: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(async () => {
  responses = [];
  arrived = Promise.withResolvers<void>();
  refreshArrived = Promise.withResolvers<void>();
  network = await serveHttp((request) => {
    if (request.method === "GET" && new URL(request.url).pathname === "/dokonceni-registrace") {
      if (isRefresh(request)) refreshArrived.resolve();
      return admissionReply.clone();
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/ontos/account")
      return new Response("Unknown endpoint", { status: 404 });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected account request");
    arrived.resolve();
    return response;
  });
  browserAt(`${network.origin}/prihlaseni`);
  localStorage.clear();
});
afterEach(async () => {
  cleanup();
  try {
    await network.idle();
  } finally {
    await network.close();
  }
});
function requestAt(index: number) {
  const request = network.requests[index];
  if (!request) throw new Error(`Missing account request ${index}`);
  return request;
}
function fill(id: string, value: string) {
  fireEvent.change(input(id), { target: { value } });
}
function input(id: string) {
  const element = document.querySelector<HTMLInputElement>(`input[id="${id}"]`);
  if (!element) throw new Error(`Missing input ${id}`);
  return element;
}
function submit(id: string) {
  const form = input(id).form;
  if (!form) throw new Error(`Missing form for ${id}`);
  fireEvent.submit(form);
}
function login() {
  fill("login-email", "real@example.test");
  fill("login-password", "real-long-password");
  submit("login-password");
}
// The UI-kit checkbox toggles on a real pointer or keyboard activation, not on a bare synthetic click.
async function register(confirmation = "real-long-password") {
  for (const [id, value] of Object.entries({
    "register-first-name": "Real",
    "register-last-name": "Customer",
    "register-email": "real@example.test",
    "register-phone": "+420777123456",
    "register-password": "real-long-password",
    "register-password-confirm": confirmation,
  }))
    fill(id, value);
  await userEvent.click(screen.getByRole("checkbox", { name: /Souhlasím/ }));
  submit("register-password");
}

describe("real customer forms", () => {
  it.each([LoginForm, RegistrationForm, VerificationResendForm])(
    "keeps the SSR credential and verification forms POST-only with a fixed same-origin action",
    (Component) => {
      const document = new DOMParser().parseFromString(
        renderToString(
          <NextRouter>
            <Component />
          </NextRouter>,
        ),
        "text/html",
      );
      const form = document.querySelector("form");
      expect(form?.getAttribute("method")).toBe("post");
      expect(form?.getAttribute("action")).toBe("/api/ontos/account");
    },
  );
  it("does not navigate or store a profile when real authentication rejects the password", async () => {
    responses.push(Response.json({ message: "Nesprávný e-mail nebo heslo." }, { status: 401 }));
    render(<LoginForm />);
    expect(screen.queryByRole("button", { name: "Poslat ověřovací e-mail znovu" })).toBeNull();
    login();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Nesprávný e-mail nebo heslo.",
    );
    expect(screen.queryByRole("button", { name: "Poslat ověřovací e-mail znovu" })).toBeNull();
    await settleBrowser();
    expect(window.location.href).toBe(`${network.origin}/prihlaseni`);
    expect(network.requests.filter((request) => request.method === "GET")).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });
  it("checks admission after a created session instead of assuming enrollment completed", async () => {
    responses.push(Response.json({ outcome: "SESSION_CREATED" }));
    render(<LoginForm />);
    login();
    await refreshArrived.promise;
    await settleBrowser();
    await waitFor(() =>
      expect(getCurrentAppRouterState()?.canonicalUrl).toBe("/dokonceni-registrace"),
    );
    const destinationRequests = network.requests.filter(
      (request) =>
        request.method === "GET" && new URL(request.url).pathname === "/dokonceni-registrace",
    );
    expect(destinationRequests).toHaveLength(2);
    expect(destinationRequests.filter(isRefresh)).toHaveLength(1);
    expect(destinationRequests.filter((request) => !isRefresh(request))).toHaveLength(1);
    for (const request of destinationRequests) expect(request.headers.get("rsc")).toBe("1");
    expect(localStorage.length).toBe(0);
  });
  it("rejects mismatched passwords without submitting credentials", async () => {
    render(<RegistrationForm />);
    await register("different-password");
    expect((await screen.findByRole("alert")).textContent).toContain("Hesla se neshodují.");
    await settleBrowser();
    expect(network.requests).toHaveLength(0);
  });
  it("sends phone and consent and truthfully acknowledges started enrollment, not a completed fake profile", async () => {
    responses.push(Response.json({ outcome: "ENROLLMENT_STARTED" }));
    render(<RegistrationForm />);
    await register();
    expect(await screen.findByText(/Registrace byla přijata/)).toBeTruthy();
    await settleBrowser();
    expect(network.requests).toHaveLength(1);
    const request = requestAt(0);
    expect(new URL(request.url).pathname).toBe("/api/ontos/account");
    expect(request.method).toBe("POST");
    expect(await request.json()).toMatchObject({
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

it("offers email-only resend only after the owner rejects an unverified login", async () => {
  responses.push(
    Response.json(
      { code: "verification_required", message: "Nejprve potvrďte e-mail." },
      { status: 403 },
    ),
    Response.json({ outcome: "EMAIL_VERIFICATION_STARTED" }),
  );
  render(<LoginForm />);
  expect(screen.queryByRole("button", { name: "Poslat ověřovací e-mail znovu" })).toBeNull();
  login();
  await screen.findByRole("button", { name: "Poslat ověřovací e-mail znovu" });
  fill("verification-resend-email", "waiting@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Poslat ověřovací e-mail znovu" }));
  expect(await screen.findByText(/Pokud účet s tímto e-mailem čeká na ověření/)).toBeTruthy();
  await settleBrowser();
  expect(network.requests).toHaveLength(2);
  const request = requestAt(1);
  expect(new URL(request.url).pathname).toBe("/api/ontos/account");
  expect(request.method).toBe("POST");
  expect(await request.json()).toEqual({
    operation: "resend-verification",
    email: "waiting@example.test",
  });
  expect(window.location.href).toBe(`${network.origin}/prihlaseni`);
  expect(network.requests.filter((request) => request.method === "GET")).toHaveLength(0);
  expect(localStorage.length).toBe(0);
});

it("disables resend while awaiting the owner and shows a real rate-limit refusal", async () => {
  const complete = Promise.withResolvers<Response>();
  const refusal = Response.json(
    { message: "Příliš mnoho pokusů. Zkuste to prosím později." },
    { status: 429 },
  );
  responses.push(
    Response.json(
      { code: "verification_required", message: "Nejprve potvrďte e-mail." },
      { status: 403 },
    ),
    complete.promise,
  );
  try {
    render(<LoginForm />);
    login();
    await screen.findByRole("button", { name: "Poslat ověřovací e-mail znovu" });
    fill("verification-resend-email", "waiting@example.test");
    arrived = Promise.withResolvers<void>();
    fireEvent.click(screen.getByRole("button", { name: "Poslat ověřovací e-mail znovu" }));
    expect(screen.getByRole("button", { name: "Odesílám…" }).hasAttribute("disabled")).toBe(true);
    await arrived.promise;
    expect(network.requests).toHaveLength(2);
    complete.resolve(refusal);
    expect(await screen.findByText("Příliš mnoho pokusů. Zkuste to prosím později.")).toBeTruthy();
    await settleBrowser();
    expect(screen.queryByText(/Pokud účet s tímto e-mailem čeká na ověření/)).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Poslat ověřovací e-mail znovu" })
        .hasAttribute("disabled"),
    ).toBe(false);
  } finally {
    complete.resolve(refusal);
  }
});

it("clears the verification offer when another login is rejected for a different reason", async () => {
  responses.push(
    Response.json(
      { code: "verification_required", message: "Nejprve potvrďte e-mail." },
      { status: 403 },
    ),
    Response.json({ message: "Nesprávný e-mail nebo heslo." }, { status: 401 }),
  );
  render(<LoginForm />);
  login();
  await screen.findByRole("button", { name: "Poslat ověřovací e-mail znovu" });
  login();
  await screen.findByText("Nesprávný e-mail nebo heslo.");
  expect(screen.queryByRole("button", { name: "Poslat ověřovací e-mail znovu" })).toBeNull();
});

it("does not infer verification state from a translated error message", async () => {
  responses.push(Response.json({ message: "Nejprve potvrďte e-mail." }, { status: 403 }));
  render(<LoginForm />);
  login();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Poslat ověřovací e-mail znovu" })).toBeNull();
});
