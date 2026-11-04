import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import {
  PasswordChange,
  PasswordChangeRefused,
  requestPasswordChange,
  type ChangePassword,
} from "@/features/account/password-change";

const current = "current-password-1";
const fresh = "example-password-12";

describe("password change frontend", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("validates the current password, the new password and its confirmation without submitting the parent", async () => {
    const onSubmit = vi.fn<(e: FormEvent) => void>((e) => e.preventDefault());
    const changePassword = vi.fn<ChangePassword>().mockResolvedValue(undefined);
    render(
      <form onSubmit={onSubmit}>
        <PasswordChange changePassword={changePassword} />
      </form>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Změnit heslo" }));
    expect(screen.getByText("Vyplňte současné heslo.")).toBeTruthy();
    expect(screen.getByText("Vyplňte nové heslo.")).toBeTruthy();
    await user.type(screen.getByLabelText("Současné heslo"), current);
    await user.type(screen.getByLabelText("Nové heslo"), fresh);
    await user.type(screen.getByLabelText("Potvrdit heslo"), "different{Enter}");
    expect(screen.getByText("Hesla se neshodují.")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(changePassword).not.toHaveBeenCalled();
  });
  it("submits the current and new password, and clears them only after the owner confirms", async () => {
    const changePassword = vi
      .fn<ChangePassword>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(undefined);
    render(<PasswordChange changePassword={changePassword} />);
    const user = userEvent.setup();
    const currentInput = screen.getByLabelText("Současné heslo") as HTMLInputElement;
    const input = screen.getByLabelText("Nové heslo") as HTMLInputElement;
    await user.type(currentInput, current);
    await user.type(input, fresh);
    await user.type(screen.getByLabelText("Potvrdit heslo"), fresh);
    await user.click(screen.getByRole("button", { name: "Změnit heslo" }));
    expect(await screen.findByText(/Heslo se nepodařilo změnit/)).toBeTruthy();
    expect(currentInput.value).toBe(current);
    expect(input.value).toBe(fresh);
    await user.click(screen.getByRole("button", { name: "Změnit heslo" }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(currentInput.value).toBe("");
    expect(screen.getByText("Heslo bylo změněno.")).toBeTruthy();
    expect(changePassword).toHaveBeenNthCalledWith(1, {
      currentPassword: current,
      newPassword: fresh,
    });
    expect(changePassword).toHaveBeenNthCalledWith(2, {
      currentPassword: current,
      newPassword: fresh,
    });
  });
  it("shows the owner's own explanation for a refused current password and never stores credentials", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const changePassword = vi
      .fn<ChangePassword>()
      .mockRejectedValue(new PasswordChangeRefused("Současné heslo nesouhlasí."));
    render(<PasswordChange changePassword={changePassword} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Současné heslo"), current);
    await user.type(screen.getByLabelText("Nové heslo"), fresh);
    await user.type(screen.getByLabelText("Potvrdit heslo"), fresh);
    await user.click(screen.getByRole("button", { name: "Změnit heslo" }));
    expect(await screen.findByText("Současné heslo nesouhlasí.")).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
  it("posts only the two passwords and turns a refusal into a typed error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ outcome: "PASSWORD_CHANGED" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Současné heslo nesouhlasí." }), { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await requestPasswordChange({ currentPassword: current, newPassword: fresh });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ontos/account/password",
      expect.objectContaining({
        body: JSON.stringify({ currentPassword: current, newPassword: fresh }),
        method: "POST",
      }),
    );
    await expect(
      requestPasswordChange({ currentPassword: "wrong", newPassword: fresh }),
    ).rejects.toBeInstanceOf(PasswordChangeRefused);
  });
});
