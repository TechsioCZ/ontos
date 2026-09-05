// Positions outside the rule's four sites: index signature parameters, variable declarators,
// ambient declarations and catch bindings.
export interface CredentialBag {
  [secret: string]: unknown;
}

declare const secret: string;

export const password: string = secret;

export function read(): string {
  try {
    return password;
  } catch (apiKey) {
    return String(apiKey);
  }
}

export type SecretReader = typeof read;
