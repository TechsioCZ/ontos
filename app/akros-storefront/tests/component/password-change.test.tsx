import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import { PasswordChange, type ChangePassword } from "@/features/account/password-change";

describe("password change frontend", () => {
  afterEach(cleanup);
  it("validates required fields and confirmation without submitting its parent profile", async () => {
    const onSubmit = vi.fn<(e: FormEvent) => void>((e) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordChange />
      </form>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Změnit heslo" }));
    expect(screen.getByText("Vyplňte nové heslo.")).toBeTruthy();
    await user.type(screen.getByLabelText("Nové heslo"), "example-password");
    await user.type(screen.getByLabelText("Potvrdit heslo"), "different{Enter}");
    expect(screen.getByText("Hesla se neshodují.")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("never claims success or persists credentials without a service", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(<PasswordChange />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Nové heslo"), "example-password");
    await user.type(screen.getByLabelText("Potvrdit heslo"), "example-password");
    await user.click(screen.getByRole("button", { name: "Změnit heslo" }));
    expect(screen.getByText(/Ostatní údaje můžete uložit samostatně/)).toBeTruthy();
    expect(screen.queryByText("Heslo bylo změněno.")).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
  it("keeps failed input for retry and clears it only after service success", async () => {
    const changePassword = vi
      .fn<ChangePassword>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(undefined);
    render(<PasswordChange changePassword={changePassword} />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("Nové heslo") as HTMLInputElement;
    await user.type(input, "example-password");
    await user.type(screen.getByLabelText("Potvrdit heslo"), "example-password");
    await user.click(screen.getByRole("button", { name: "Změnit heslo" }));
    expect(await screen.findByText(/Heslo se nepodařilo změnit/)).toBeTruthy();
    expect(input.value).toBe("example-password");
    await user.click(screen.getByRole("button", { name: "Změnit heslo" }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByText("Heslo bylo změněno.")).toBeTruthy();
    expect(changePassword).toHaveBeenCalledTimes(2);
  });
});
