// Boundary correction: audit C1 targets hand-built serialization, not erased string contracts
// or opaque producer calls. D-tier framework adapters may forward already-serialized cookies;
// Cookies.fromSetCookie accepts these strings. Producer bodies are not available to this AST.
// `headers.set('set-cookie', serializeCookie(...))` is reported, but the identical anti-pattern
// written as a headers object literal is not: the property check demands a hand-built *value*
// instead of asking (like the call check does) whether the value is Cookies-owned.
declare const serializeCookie: (name: string, value: string) => string;

export const respond = (name: string, value: string): Response =>
  new Response(null, { headers: { 'Set-Cookie': serializeCookie(name, value) } });
