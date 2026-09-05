// Naming the header without writing a value is not cookie serialization: redaction allowlists,
// membership sets, deletion and reads all mention `set-cookie` but serialize nothing.
export const redactedHeaders = new Set<string>();
redactedHeaders.add('set-cookie');

export const sensitive = new Set(['set-cookie', 'authorization']);

export const strip = (headers: Headers): string | null => {
  headers.delete('set-cookie');
  return headers.get('set-cookie');
};
