// Boundary correction: audit C1 targets hand-built serialization, not erased string contracts
// or opaque producer calls. D-tier framework adapters may forward already-serialized cookies;
// Cookies.fromSetCookie accepts these strings. Producer bodies are not available to this AST.
// The rule docblock says the contract check covers "a property or parameter named
// `setCookieHeaders`", but only `TSPropertySignature` / `PropertyDefinition` are visited, so the
// same raw-cookie-string contract passes freely as a parameter.
export const applyCookies = (response: Response, setCookieHeaders: readonly string[]): Response => {
  for (const header of setCookieHeaders) response.headers.append('x-forwarded', header);
  return response;
};

export function forward(setCookieHeader: string): string {
  return setCookieHeader;
}
