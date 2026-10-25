import { Cause, Effect, Option, Predicate, Schema } from 'effect';

const ERROR_TAGS = new Set([
  'AuthConfigError',
  'AuthDatabaseConnectionError',
  'ConfigError',
  'DatabaseConfigError',
  'DatabaseConnectionError',
  'ExternalIdentityProviderDeploymentConfigError',
  'SchemaError',
  'SpiceDbConfigError',
  'SqlError',
]);
const CONFIG_KEYS = [
  'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_TRUSTED_ORIGINS',
  'DATABASE_URL',
  'HYPERDRIVE',
  'GATEWAY_ISSUER_HYPERDRIVE',
  'SHELL_GATEWAY_ISSUER_DATABASE_URL',
  'SPICEDB_ENDPOINT',
  'SPICEDB_PRESHARED_KEY',
  'SPICEDB_CA_CERT',
  'ONTOS_GATEWAY_ISSUER',
  'ONTOS_GATEWAY_PRIVATE_JWK',
  'ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT',
  'ONTOS_ACTIVE_APPLICATION_COMPOSITION',
] as const;

const DiagnosticPropertySchema = Schema.Struct({ value: Schema.Unknown });
type DiagnosticProperty = typeof DiagnosticPropertySchema.Type;

// Error evidence is an untrusted boundary: never invoke getters or serialize arbitrary objects.
const dataProperty = (evidence: DiagnosticProperty, key: string) => {
  const { value } = evidence;
  if (!Predicate.isObject(value)) {
    return Option.none();
  }
  try {
    return Schema.decodeUnknownOption(DiagnosticPropertySchema)(Object.getOwnPropertyDescriptor(value, key));
  } catch {
    return Option.none();
  }
};

const configurationKeys = (value: DiagnosticProperty) => {
  const keys = new Set<string>();
  for (const field of ['reason', 'message']) {
    const property = dataProperty(value, field);
    if (Option.isSome(property) && Predicate.isString(property.value.value)) {
      const tokens = new Set(property.value.value.slice(0, 4096).split(/[^A-Z0-9_]+/u));
      for (const key of CONFIG_KEYS) {
        if (tokens.has(key)) {
          keys.add(key);
        }
      }
    }
  }
  return keys;
};

const initializationAnnotations = (cause: Cause.Cause<unknown>) => {
  const errorTags = new Set<string>();
  const configKeys = new Set<string>();
  const failureKinds = new Set<string>();
  const pending: DiagnosticProperty[] = [];
  for (const reason of cause.reasons.slice(0, 16)) {
    if (Cause.isFailReason(reason)) {
      failureKinds.add('failure');
      pending.push({ value: reason.error });
    } else if (Cause.isDieReason(reason)) {
      failureKinds.add('defect');
      pending.push({ value: reason.defect });
    } else {
      failureKinds.add('interruption');
    }
  }
  const seen = new Set<object>();
  for (const evidence of pending) {
    const { value } = evidence;
    if (!Predicate.isObject(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const tag = dataProperty(evidence, '_tag');
    if (Option.isSome(tag)) {
      const label = tag.value.value;
      if (Predicate.isString(label) && ERROR_TAGS.has(label)) {
        errorTags.add(label);
      }
    }
    for (const key of configurationKeys(evidence)) {
      configKeys.add(key);
    }
    for (const field of ['cause', 'reason', 'error', 'defect']) {
      const property = dataProperty(evidence, field);
      if (Option.isSome(property) && pending.length < 32) {
        pending.push(property.value);
      }
    }
  }
  return {
    configKeys: [...configKeys].toSorted().join(',') || 'none',
    errorTags: [...errorTags].toSorted().join(',') || 'unknown',
    failureKinds: [...failureKinds].toSorted().join(',') || 'unknown',
    initializationBoundary: 'shell.requestServices',
  };
};

/** One diagnostic before Layer.orDie; only bounded, allow-listed labels leave the failure boundary. */
export const logRequestServicesFailure = (cause: Cause.Cause<unknown>) =>
  Effect.logError('Shell request services initialization failed').pipe(
    Effect.annotateLogs(initializationAnnotations(cause)),
  );
