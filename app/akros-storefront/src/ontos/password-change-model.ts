export interface PasswordChangeInput {
  readonly currentPassword: string;
  readonly newPassword: string;
}

/** Bounds the owner enforces (`COMMERCE_PORTAL_AUTH_POLICY.password`); the browser never decides the verdict. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

/** Only the two declared fields survive; any other key is dropped rather than forwarded. */
export const passwordChangeInput = (input: unknown): PasswordChangeInput | null => {
  if (!record(input)) return null;
  const { currentPassword, newPassword } = input;
  if (
    typeof currentPassword !== "string" ||
    currentPassword.length === 0 ||
    currentPassword.length > PASSWORD_MAX_LENGTH
  )
    return null;
  if (
    typeof newPassword !== "string" ||
    newPassword.length < PASSWORD_MIN_LENGTH ||
    newPassword.length > PASSWORD_MAX_LENGTH
  )
    return null;
  return { currentPassword, newPassword };
};
