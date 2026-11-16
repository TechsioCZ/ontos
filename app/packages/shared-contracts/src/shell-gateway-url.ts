import { Config, Schema } from 'effect';

/** Hosts a module may reach the Shell on over plain HTTP: the same machine (the app host's loopback relay, a dev box). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The Shell gateway address every client that presents a key (module, workload, tenant or service key) sends it to:
 * HTTPS, or plain HTTP to a loopback host only, and no credentials, query or fragment. One rule for all of them, so no
 * client can carry a key in clear text off the machine.
 */
export const ShellGatewayBaseUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
      ? undefined
      : 'The Shell gateway requires HTTPS (plain HTTP only to a loopback host) without credentials, query or fragment',
  ),
);

/** `ONTOS_SHELL_GATEWAY_BASE_URL`, read under that one rule. */
export const shellGatewayBaseUrlConfig = Config.schema(ShellGatewayBaseUrlSchema, 'ONTOS_SHELL_GATEWAY_BASE_URL');
