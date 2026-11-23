import { Schema } from 'effect';

/** An external image reference, not an upload or a server fetch destination. */
export const ImportImageUrlSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.makeFilter((value) => {
    const parsed = URL.parse(value);
    if (parsed === null || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      return 'An image must be a public HTTPS URL without credentials';
    }
    const host = parsed.hostname.toLowerCase();
    return host.includes('.') &&
      !host.includes(':') &&
      !/^\d+(?:\.\d+){3}$/u.test(host) &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local') &&
      !host.endsWith('.internal') &&
      parsed.hash === '' &&
      (parsed.port === '' || parsed.port === '443')
      ? undefined
      : 'An image must use a public hostname and the HTTPS port';
  }),
);
