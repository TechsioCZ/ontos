export const cachePolicy = 'public, max-age=3600';
export const hsts = 'max-age=63072000; includeSubDomains; preload';
export const secureNotice = 'Secure connection required';
export const secureChannel = 'SecureChannel';
export const prose = 'The Path is configured in the deployment manifest.';
export const link = 'https://example.com/health?domain=example.com&path=/ready';
export const sqlOrder = 'ORDER BY expires_at DESC';

export interface TypedCookieContract {
  readonly setCookieHeaders: ReadonlyArray<CookieValue>;
}

export interface CookieValue {
  readonly name: string;
  readonly value: string;
}

export const readHeader = (headers: Headers): string | null => headers.get('set-cookie');
