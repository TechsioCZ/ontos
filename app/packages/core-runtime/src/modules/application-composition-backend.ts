import { Schema } from 'effect';

export const isLoopbackHostname = (hostname: string): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');

const backendOrigin = Schema.String.check(
  Schema.isMaxLength(1000),
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return url !== null &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === '/' &&
      value === `${url.origin}/`
      ? undefined
      : 'backend URL must be a canonical HTTPS (or loopback HTTP) origin without credentials, query, or fragment';
  }),
);

const CloudflareWorkerVersionIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CloudflareWorkerVersionId'),
);

/** An ordinary immutable Worker release bound to its account's public workers.dev origin. */
export const ApplicationCompositionCloudflareWorkerBackendSchema = Schema.Struct({
  baseUrl: backendOrigin,
  transport: Schema.Literal('cloudflare-worker'),
  versionId: CloudflareWorkerVersionIdSchema,
  workerName: Schema.String.check(Schema.isPattern(/^ontos-[a-f\d]{56}$/u)),
}).check(
  Schema.makeFilter(({ baseUrl, workerName }) => {
    const url = URL.parse(baseUrl);
    if (url === null) {
      return 'Worker backend URL must be absolute';
    }
    const [name, subdomain, provider, suffix, extra] = url.hostname.split('.');
    return url.protocol === 'https:' &&
      url.port === '' &&
      name === workerName &&
      subdomain !== undefined &&
      /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u.test(subdomain) &&
      provider === 'workers' &&
      suffix === 'dev' &&
      extra === undefined
      ? undefined
      : 'Worker backend must use its exact immutable workerName on a canonical HTTPS workers.dev origin';
  }),
);

/** Approved native backend placement for the one deployment identity the module declares. */
export const ApplicationCompositionBackendSchema = Schema.Union([
  Schema.Struct({
    baseUrl: backendOrigin,
    transport: Schema.Literal('node-http'),
  }),
  ApplicationCompositionCloudflareWorkerBackendSchema,
]);

export type ApplicationCompositionBackend = typeof ApplicationCompositionBackendSchema.Type;
