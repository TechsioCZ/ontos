// Boundary correction: audit C1 targets hand-built serialization, not erased string contracts
// or opaque producer calls. D-tier framework adapters may forward already-serialized cookies;
// Cookies.fromSetCookie accepts these strings. Producer bodies are not available to this AST.
// `abstract` class members parse as `TSAbstractPropertyDefinition`, which the rule never visits,
// so the raw cookie-string contract survives at the abstract base that defines it.
export abstract class CookieCarrier {
  abstract readonly setCookieHeader: string;
  abstract setCookieHeaders: readonly string[];
}
