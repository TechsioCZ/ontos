// Boundary correction: audit C1 targets hand-built serialization, not erased string contracts
// or opaque producer calls. D-tier framework adapters may forward already-serialized cookies;
// Cookies.fromSetCookie accepts these strings. Producer bodies are not available to this AST.
export interface SessionResult {
  readonly selectedLegalEntityId: string;
  readonly setCookieHeaders: readonly string[];
}

export type RefreshResult = {
  setCookieHeader: string;
};

export class CookieCarrier {
  readonly cookieHeaders: Array<string> = [];
}
