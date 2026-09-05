// A4/A5 prohibit duplicated wire problems and raw failure prose, not UI metadata or sanitizers.
export const health = { status: 200, title: 'Healthy' };
export const mime = { status: 200, type: 'application/json', body: {} };
export const retry = { status: 429, retryable: true };
declare const error: unknown;
declare const sanitize: (error: unknown) => string;
export const toast = { title: String(error), type: 'error' };
export const safeDetail = { title: 'Unavailable', type: 'https://example.test/problems/unavailable', detail: sanitize(error) };
