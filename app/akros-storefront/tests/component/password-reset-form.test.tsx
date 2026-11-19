import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserAt, serveHttp } from "../support/http";
import { renderStorefront as render } from "../support/storefront";
import { PasswordRequestForm, PasswordResetForm } from "@/components/password-reset-form";

let network: Awaited<ReturnType<typeof serveHttp>>;
let accountResponse: Response;
beforeEach(async () => {
  accountResponse = Response.json({ outcome: "ACCOUNT_RECOVERY_STARTED" });
  network = await serveHttp((request) => {
    if (new URL(request.url).pathname !== "/api/ontos/account" || request.method !== "POST") {
      return new Response("Unknown endpoint", { status: 404 });
    }
    return accountResponse;
  });
  browserAt(network.origin);
});
afterEach(async () => {
  cleanup();
  await network.idle();
  await network.close();
});
function fill(id: string, value: string) {
  fireEvent.change(document.getElementById(id)!, { target: { value } });
}

describe("password recovery forms", () => {
  it("requests the reset link for the typed e-mail and confirms without revealing the account", async () => {
    render(<PasswordRequestForm />);

    fill("reset-request-email", "real@example.test");
    fireEvent.submit(document.getElementById("reset-request-email")!.closest("form")!);

    expect(await screen.findByText(/odeslali jsme na něj odkaz/)).toBeDefined();
    await network.idle();
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]?.url).toBe(`${network.origin}/api/ontos/account`);
    expect(network.requests[0]?.method).toBe("POST");
    expect(await network.requests[0]?.json()).toEqual({
      operation: "request-password-reset",
      email: "real@example.test",
    });
  });

  it("shows the owner's rate-limit message and keeps the form available", async () => {
    accountResponse = Response.json(
      { message: "Příliš mnoho pokusů. Zkuste to prosím později." },
      { status: 429 },
    );
    render(<PasswordRequestForm />);

    fill("reset-request-email", "real@example.test");
    fireEvent.submit(document.getElementById("reset-request-email")!.closest("form")!);

    expect((await screen.findByRole("alert")).textContent).toContain("Příliš mnoho pokusů");
    expect(screen.getByRole("button", { name: "Odeslat odkaz" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("refuses mismatched new passwords before sending anything", async () => {
    render(<PasswordResetForm />);

    fill("reset-new-password", "new-long-password");
    fill("reset-password-confirm", "different-long-password");
    fireEvent.submit(document.getElementById("reset-new-password")!.closest("form")!);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Hesla se neshodují."),
    );
    await network.idle();
    expect(network.requests).toHaveLength(0);
  });

  it("sets the new password through the account transport and confirms completion", async () => {
    accountResponse = Response.json({ outcome: "PASSWORD_RESET_COMPLETED" });
    render(<PasswordResetForm />);

    fill("reset-new-password", "new-long-password");
    fill("reset-password-confirm", "new-long-password");
    fireEvent.submit(document.getElementById("reset-new-password")!.closest("form")!);

    expect(await screen.findByText(/Nové heslo je nastaveno/)).toBeDefined();
    await network.idle();
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]?.url).toBe(`${network.origin}/api/ontos/account`);
    expect(network.requests[0]?.method).toBe("POST");
    expect(await network.requests[0]?.json()).toEqual({
      operation: "reset-password",
      newPassword: "new-long-password",
      passwordConfirmation: "new-long-password",
    });
  });
});
