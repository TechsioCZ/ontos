import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import { renderStorefront as render } from "../support/storefront";
import { browserAt, serveHttp } from "../support/http";
import {
  PasswordChange,
  PasswordChangeRefused,
  requestPasswordChange,
  type ChangePassword,
} from "@/features/account/password-change";

const current = "current-password-1";
const fresh = "example-password-12";

describe("password change frontend", () => {
  let network: Awaited<ReturnType<typeof serveHttp>>;

  beforeEach(async () => {
    network = await serveHttp(async (request) => {
      if (
        new URL(request.url).pathname !== "/api/ontos/account/password" ||
        request.method !== "POST"
      )
        return new Response("Unknown endpoint", { status: 404 });
      const payload: unknown = await request.json();
      if (
        typeof payload === "object" &&
        payload !== null &&
        "currentPassword" in payload &&
        payload.currentPassword === "wrong"
      )
        return Response.json({ message: "Současné heslo nesouhlasí." }, { status: 400 });
      return Response.json({ outcome: "PASSWORD_CHANGED" });
    });
    browserAt(network.origin);
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    await network.idle();
    await network.close();
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
    await network.idle();
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
    const currentInput = screen.getByLabelText<HTMLInputElement>("Současné heslo");
    const input = screen.getByLabelText<HTMLInputElement>("Nové heslo");
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
    await network.idle();
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
    localStorage.setItem("unrelated-setting", "keep-local");
    sessionStorage.setItem("unrelated-setting", "keep-session");
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
    await network.idle();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("unrelated-setting")).toBe("keep-local");
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem("unrelated-setting")).toBe("keep-session");
  });
  it("posts only the two passwords and turns a refusal into a typed error", async () => {
    await requestPasswordChange({ currentPassword: current, newPassword: fresh });
    await network.idle();
    expect(network.requests).toHaveLength(1);
    const [request] = network.requests;
    expect(new URL(request.url).pathname).toBe("/api/ontos/account/password");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.text()).toBe(
      JSON.stringify({ currentPassword: current, newPassword: fresh }),
    );
    await expect(
      requestPasswordChange({ currentPassword: "wrong", newPassword: fresh }),
    ).rejects.toBeInstanceOf(PasswordChangeRefused);
    await network.idle();
    expect(network.requests).toHaveLength(2);
    expect(await network.requests[1].json()).toEqual({
      currentPassword: "wrong",
      newPassword: fresh,
    });
  });
});
