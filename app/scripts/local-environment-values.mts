import { DATABASE_IDENTITIES } from '../database/identity-enrollment.ts';
import { Config, ConfigProvider, Effect, Option, Redacted } from 'effect';

import { SHARED_RUNTIME_IDENTITY } from '../packages/core-runtime/src/db/database-identities.ts';

const assignmentPattern = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u;

const existingValues = (lines: readonly string[]): Readonly<Record<string, string>> =>
  Object.fromEntries(
    lines.flatMap((line) => {
      const match = assignmentPattern.exec(line);
      const key = match?.groups?.key;
      const value = match?.groups?.value;
      return key === undefined || value === undefined ? [] : [[key, value] as const];
    }),
  );

/** A dotenv double-quoted value; the loader expands `\n`, so a PEM keeps its line breaks. */
const dotenvQuoted = (value: string) => {
  const escaped = value
    .trim()
    .replaceAll('\r\n', '\n')
    .replaceAll('\n', String.raw`\n`);
  return `"${escaped}"`;
};

export interface LocalEnvironmentOverrides {
  readonly grpcPort?: string | undefined;
  readonly httpPort?: string | undefined;
  readonly preSharedKey?: Redacted.Redacted | undefined;
}

export interface LocalPublicClientTopology {
  readonly partyRegistryApiBaseUrl: string;
  readonly priceGroupCatalogApiBaseUrl: string;
  readonly shellId: string;
  readonly shellPort: number;
}

export const localPublicClientValues = (lines: readonly string[], topology: LocalPublicClientTopology) => {
  const existing = existingValues(lines);
  return {
    ONTOS_PARTY_REGISTRY_API_BASE_URL: existing.ONTOS_PARTY_REGISTRY_API_BASE_URL ?? topology.partyRegistryApiBaseUrl,
    ONTOS_PRICE_GROUP_CATALOG_BASE_URL:
      existing.ONTOS_PRICE_GROUP_CATALOG_BASE_URL ?? topology.priceGroupCatalogApiBaseUrl,
    ONTOS_SHELL_GATEWAY_BASE_URL:
      existing.ONTOS_SHELL_GATEWAY_BASE_URL ?? `http://localhost:${topology.shellPort}/${topology.shellId}-api`,
  };
};

export const localSpiceDbValues = (
  lines: readonly string[],
  overrides: LocalEnvironmentOverrides,
  certificate: string,
) => {
  const existing = existingValues(lines);
  const grpcPort = overrides.grpcPort ?? existing.SPICEDB_GRPC_PORT ?? '50051';
  const httpPort = overrides.httpPort ?? existing.SPICEDB_HTTP_PORT ?? '8443';
  const resolvePreSharedKey = () =>
    (overrides.preSharedKey === undefined ? undefined : Redacted.value(overrides.preSharedKey)) ??
    existing.SPICEDB_PRESHARED_KEY ??
    'ontos-local-development-key';
  const preSharedKey = resolvePreSharedKey();

  return {
    // The local certificate is the source of truth; it replaces any earlier value.
    SPICEDB_CA_CERT: dotenvQuoted(certificate),
    SPICEDB_ENDPOINT:
      overrides.grpcPort === undefined && existing.SPICEDB_ENDPOINT !== undefined
        ? existing.SPICEDB_ENDPOINT
        : `localhost:${grpcPort}`,
    SPICEDB_GRPC_PORT: grpcPort,
    SPICEDB_HTTP_PORT: httpPort,
    SPICEDB_PRESHARED_KEY: preSharedKey,
  };
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const loopbackDatabaseUrl = (value: string | undefined): Option.Option<URL> => {
  if (value === undefined || !URL.canParse(value)) {
    return Option.none();
  }
  const url = new URL(value);
  return /^postgres(?:ql)?:$/u.test(url.protocol) && LOOPBACK_HOSTS.has(url.hostname)
    ? Option.some(url)
    : Option.none();
};

/**
 * The local URLs of the dedicated database identities that the environment lacks. Each reuses the host,
 * port and database of a loopback `DATABASE_URL`, with user and password equal to the role, as the local
 * bootstrap creates them. Present keys are never returned, so an existing value is never overwritten.
 */
export const localDatabaseIdentityValues = (lines: readonly string[]) =>
  Effect.gen(function* localDatabaseIdentityValuesEffect() {
    const provider = ConfigProvider.fromDotEnvContents(lines.join('\n'), { preserveEmptyStrings: true });
    const entries = yield* Effect.all(
      DATABASE_IDENTITIES.map((identity) =>
        Config.option(Config.String(identity.urlKey))
          .parse(provider)
          .pipe(Effect.map((value) => [identity.urlKey, Option.getOrUndefined(value)] as const)),
      ),
    );
    const existing = Object.fromEntries(entries);
    return Option.match(loopbackDatabaseUrl(existing[SHARED_RUNTIME_IDENTITY.urlKey]), {
      onNone: () => ({}),
      onSome: (runtimeUrl) =>
        Object.fromEntries(
          DATABASE_IDENTITIES.filter(
            (identity) => identity.id !== SHARED_RUNTIME_IDENTITY.id && existing[identity.urlKey] === undefined,
          ).map((identity) => {
            const url = new URL(runtimeUrl);
            url.username = identity.role;
            url.password = identity.role;
            return [identity.urlKey, url.toString()] as const;
          }),
        ),
    });
  });
