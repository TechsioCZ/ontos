import { describe, expect, it } from "vitest";
import { passwordChangeInput } from "@/ontos/password-change-model";

describe("password change input", () => {
  it("keeps only the two declared fields inside the 12 to 128 character bounds", () => {
    expect(
      passwordChangeInput({
        currentPassword: "current-password-1",
        newPassword: "example-password-12",
        partyId: "not-forwarded",
      }),
    ).toEqual({ currentPassword: "current-password-1", newPassword: "example-password-12" });
    expect(
      passwordChangeInput({ currentPassword: "current", newPassword: "x".repeat(11) }),
    ).toBeNull();
    expect(
      passwordChangeInput({ currentPassword: "current", newPassword: "x".repeat(12) }),
    ).not.toBeNull();
    expect(
      passwordChangeInput({ currentPassword: "current", newPassword: "x".repeat(129) }),
    ).toBeNull();
    expect(passwordChangeInput({ currentPassword: "", newPassword: "x".repeat(12) })).toBeNull();
    expect(passwordChangeInput({ currentPassword: 1, newPassword: "x".repeat(12) })).toBeNull();
    expect(passwordChangeInput(null)).toBeNull();
  });
});
