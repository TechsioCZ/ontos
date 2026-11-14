import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordRequestForm, PasswordResetForm } from "@/components/password-reset-form";

const fetchAccount = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchAccount);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fill(id: string, value: string) {
  fireEvent.change(document.getElementById(id)!, { target: { value } });
}

describe("password recovery forms", () => {
  it("requests the reset link for the typed e-mail and confirms without revealing the account", async () => {
    fetchAccount.mockResolvedValue(Response.json({ outcome: "ACCOUNT_RECOVERY_STARTED" }));
    render(<PasswordRequestForm />);

    fill("reset-request-email", "real@example.test");
    fireEvent.submit(document.getElementById("reset-request-email")!.closest("form")!);

    expect(await screen.findByText(/odeslali jsme na něj odkaz/)).toBeDefined();
    expect(fetchAccount).toHaveBeenCalledWith(
      "/api/ontos/account",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ operation: "request-password-reset", email: "real@example.test" }),
      }),
    );
  });

  it("shows the owner's rate-limit message and keeps the form available", async () => {
    fetchAccount.mockResolvedValue(
      Response.json({ message: "Příliš mnoho pokusů. Zkuste to prosím později." }, { status: 429 }),
    );
    render(<PasswordRequestForm />);

    fill("reset-request-email", "real@example.test");
    fireEvent.submit(document.getElementById("reset-request-email")!.closest("form")!);

    expect((await screen.findByRole("alert")).textContent).toContain("Příliš mnoho pokusů");
    expect(
      (screen.getByRole("button", { name: "Odeslat odkaz" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("refuses mismatched new passwords before sending anything", async () => {
    render(<PasswordResetForm />);

    fill("reset-new-password", "new-long-password");
    fill("reset-password-confirm", "different-long-password");
    fireEvent.submit(document.getElementById("reset-new-password")!.closest("form")!);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Hesla se neshodují."),
    );
    expect(fetchAccount).not.toHaveBeenCalled();
  });

  it("sets the new password through the account transport and confirms completion", async () => {
    fetchAccount.mockResolvedValue(Response.json({ outcome: "PASSWORD_RESET_COMPLETED" }));
    render(<PasswordResetForm />);

    fill("reset-new-password", "new-long-password");
    fill("reset-password-confirm", "new-long-password");
    fireEvent.submit(document.getElementById("reset-new-password")!.closest("form")!);

    expect(await screen.findByText(/Nové heslo je nastaveno/)).toBeDefined();
    expect(fetchAccount).toHaveBeenCalledWith(
      "/api/ontos/account",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "reset-password",
          newPassword: "new-long-password",
          passwordConfirmation: "new-long-password",
        }),
      }),
    );
  });
});
