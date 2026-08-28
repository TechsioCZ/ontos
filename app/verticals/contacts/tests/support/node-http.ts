// @effect-diagnostics nodeBuiltinImport:off
import type { IncomingHttpHeaders } from 'node:http';

export const appendRequestChunk = (chunks: Uint8Array[], chunk: string | Uint8Array): void => {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
};

export const webHeadersFromNode = (headers: IncomingHttpHeaders): Headers => {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(name, item);
      }
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
};

export const webRequestInit = (
  chunks: readonly Uint8Array[],
  headers: IncomingHttpHeaders,
  method: string | undefined,
): RequestInit => {
  const init: RequestInit = {
    headers: webHeadersFromNode(headers),
    method: method ?? 'GET',
  };
  if (chunks.length > 0) {
    init.body = Buffer.concat(chunks);
  }
  return init;
};
