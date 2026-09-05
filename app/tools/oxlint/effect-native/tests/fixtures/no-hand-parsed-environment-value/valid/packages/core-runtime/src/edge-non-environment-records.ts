// SCREAMING keys on records that are not environment bags: HTTP headers, feature payloads and
// database rows all keep their own owners, so parsing them is not audit A3.
type Headers = Readonly<Record<string, string | undefined>>;

export const traceId = (headers: Headers) => headers['X_REQUEST_ID']?.trim();
export const retry = (headers: Headers) => Number(headers['RETRY_AFTER'] ?? '0');
export const isJson = (headers: Headers) => headers['CONTENT_TYPE'] === 'application/json';
export const rowUrl = (row: { readonly WEBHOOK_URL: string }) => new URL(row.WEBHOOK_URL);
