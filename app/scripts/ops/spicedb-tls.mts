import { X509Certificate, sign, verify } from 'node:crypto';
import { isIP } from 'node:net';
import nodePath from 'node:path';

import { Console, DateTime, Duration, Effect, FileSystem, Match, Option, Redacted, Schema } from 'effect';

import { ZeropsPublicApi } from '../zerops-public-api.mts';
import { CloudflareApi } from './cloudflare-api.mts';
import { runCommand } from './ops-shell.mts';
import { StageOperationError } from './stage-operation-error.mts';
import { listZeropsServices, perform } from './stage-operations.mts';

/**
 * TLS material for the stage SpiceDB service, kept as sensitive secrets on the Zerops `spicedb`
 * service. SpiceDB serves two listeners with two certificates:
 *
 * - gRPC (50051), used by the Node runtimes: a self-signed certificate for `spicedb`, `localhost`
 *   and `127.0.0.1`. Clients pin it as their only trusted CA.
 * - the HTTP gateway (8443), which Workers reach through the Workers VPC service: a Cloudflare
 *   Origin CA certificate for the gateway hostname, which Workers VPC verifies with `verify_full`.
 *   The hostname is only the TLS server name; it needs no public DNS record.
 *
 * Creating the material is idempotent. A pair that exists and holds is kept; a partial or invalid
 * pair fails with guidance instead of being rotated silently.
 */
export const SPICEDB_SERVICE_HOSTNAME = 'spicedb';
export const SPICEDB_GRPC_TLS_NAMES = ['spicedb', 'localhost', '127.0.0.1'] as const;
/** A certificate must stay valid at least this long, so a verify never passes on the eve of expiry. */
export const MINIMUM_REMAINING_VALIDITY = Duration.days(30);
const SELF_SIGNED_VALIDITY_DAYS = 3650;

export interface SpicedbTlsPair {
  readonly certificateKey: string;
  readonly label: string;
  readonly privateKeyKey: string;
}

export const SPICEDB_GRPC_TLS: SpicedbTlsPair = {
  certificateKey: 'SPICEDB_GRPC_TLS_CERT',
  label: 'gRPC',
  privateKeyKey: 'SPICEDB_GRPC_TLS_KEY',
};

export const SPICEDB_HTTP_TLS: SpicedbTlsPair = {
  certificateKey: 'SPICEDB_HTTP_TLS_CERT',
  label: 'HTTP gateway',
  privateKeyKey: 'SPICEDB_HTTP_TLS_KEY',
};

export interface SpicedbTlsTarget {
  /** The server name Workers VPC verifies on the HTTP gateway, such as `ontos-stage-spicedb.<zone>`. */
  readonly gatewayHostname: string;
  readonly projectId: string;
}

const TlsMaterialSchema = Schema.Struct({ certificate: Schema.String, privateKey: Schema.Redacted(Schema.String) });
export type TlsMaterial = typeof TlsMaterialSchema.Type;

interface PairExpectation {
  readonly names: readonly string[];
  /** The gateway certificate must chain to the Cloudflare Origin CA, so a self-issued one never holds. */
  readonly signedByAnotherCa: boolean;
}

const PEM_BLOCK = /-----BEGIN (?<label>[A-Z ]+)-----\r?\n[\s\S]+?\r?\n-----END \k<label>-----/gu;

/** The PEM blocks of `text` by label, such as `PRIVATE KEY` or `CERTIFICATE`. */
export const pemBlocks = (text: string): ReadonlyMap<string, string> =>
  new Map(
    [...text.matchAll(PEM_BLOCK)].map((match) => {
      const { label = '' } = match.groups ?? {};
      return [label, `${match[0]}\n`];
    }),
  );

const KEY_PAIR_PROBE = Buffer.from('ontos spicedb tls key pair probe');

const attempt = <A,>(read: () => A): Option.Option<A> => {
  try {
    return Option.some(read());
  } catch {
    return Option.none();
  }
};

const nameProblem = (certificate: X509Certificate, name: string) => {
  const matched = isIP(name) === 0 ? certificate.checkHost(name) : certificate.checkIP(name);
  return matched === undefined ? Option.some(`it does not cover ${name}`) : Option.none<string>();
};

/** Why a certificate and private key do not hold for these names at `now`, if they do not. */
export const tlsMaterialProblem = (
  material: TlsMaterial,
  expectation: PairExpectation,
  now: DateTime.Utc,
): Option.Option<string> => {
  const certificate = attempt(() => new X509Certificate(material.certificate));
  if (Option.isNone(certificate)) {
    return Option.some('the certificate is not a PEM X.509 certificate');
  }
  // A signature over a fixed probe that the certificate's public key accepts proves the key pair.
  const signature = attempt(() => sign('sha256', KEY_PAIR_PROBE, Redacted.value(material.privateKey)));
  if (Option.isNone(signature)) {
    return Option.some('the private key is not a PEM private key');
  }
  const matches = attempt(() => verify('sha256', KEY_PAIR_PROBE, certificate.value.publicKey, signature.value));
  if (!Option.getOrElse(matches, () => false)) {
    return Option.some('the private key does not belong to the certificate');
  }
  if (expectation.signedByAnotherCa && certificate.value.checkIssued(certificate.value)) {
    return Option.some('the certificate is self-issued, not signed by the Cloudflare Origin CA');
  }
  const uncovered = expectation.names.map((name) => nameProblem(certificate.value, name)).find(Option.isSome);
  if (uncovered !== undefined) {
    return uncovered;
  }
  const validTo = DateTime.makeUnsafe(certificate.value.validToDate);
  return DateTime.isLessThan(validTo, DateTime.addDuration(now, MINIMUM_REMAINING_VALIDITY))
    ? Option.some(`the certificate expires ${DateTime.formatIso(validTo)}`)
    : Option.none();
};

const grpcExpectation: PairExpectation = { names: SPICEDB_GRPC_TLS_NAMES, signedByAnotherCa: false };
const gatewayExpectation = (target: SpicedbTlsTarget): PairExpectation => ({
  names: [target.gatewayHostname],
  signedByAnotherCa: true,
});

// ---------------------------------------------------------------------------------------------
// Reading the stored pairs

const AbsentPair = Schema.TaggedStruct('Absent', {});
const PartialPair = Schema.TaggedStruct('Partial', { present: Schema.String });
const StoredPairMaterial = Schema.TaggedStruct('Stored', { material: TlsMaterialSchema });
type StoredPair = typeof AbsentPair.Type | typeof PartialPair.Type | typeof StoredPairMaterial.Type;

interface PairEntry {
  readonly expectation: PairExpectation;
  readonly pair: SpicedbTlsPair;
  readonly stored: StoredPair;
}

/**
 * Reads one pair from the `spicedb` service secrets. Their values come from the Zerops API: `zcli project env`
 * prints sensitive secrets as `REDACTED`, which would read as an invalid certificate.
 */
const readStoredPair = (secrets: ReadonlyMap<string, Redacted.Redacted>, pair: SpicedbTlsPair): StoredPair => {
  const certificate = secrets.get(pair.certificateKey);
  const privateKey = secrets.get(pair.privateKeyKey);
  if (certificate === undefined && privateKey === undefined) {
    return AbsentPair.make({});
  }
  if (certificate === undefined || privateKey === undefined) {
    return PartialPair.make({ present: certificate === undefined ? pair.privateKeyKey : pair.certificateKey });
  }
  return StoredPairMaterial.make({ material: { certificate: Redacted.value(certificate), privateKey } });
};

const pairLabel = (pair: SpicedbTlsPair) =>
  `the ${SPICEDB_SERVICE_HOSTNAME} ${pair.label} TLS secrets ${pair.certificateKey} and ${pair.privateKeyKey}`;

const repairGuidance = (pair: SpicedbTlsPair) =>
  `remove ${pair.certificateKey} and ${pair.privateKeyKey} from the Zerops ${SPICEDB_SERVICE_HOSTNAME} service secrets, then run spicedb-tls to create both again`;

/** Why a stored pair does not hold, if it does not. */
const storedPairProblem = ({ expectation, pair, stored }: PairEntry, now: DateTime.Utc): Option.Option<string> =>
  Match.value(stored).pipe(
    Match.tagsExhaustive({
      Absent: () => Option.some('they do not exist; run spicedb-tls'),
      Partial: ({ present }) => Option.some(`only ${present} exists; ${repairGuidance(pair)}`),
      Stored: ({ material }) =>
        tlsMaterialProblem(material, expectation, now).pipe(
          Option.map((problem) => `${problem}; ${repairGuidance(pair)}`),
        ),
    }),
  );

const spicedbServiceId = (projectId: string) =>
  listZeropsServices(projectId).pipe(
    Effect.flatMap((services) => {
      const service = services.find(({ hostname }) => hostname === SPICEDB_SERVICE_HOSTNAME);
      return service === undefined
        ? Effect.fail(
            new StageOperationError({
              message: `Zerops project ${projectId} has no ${SPICEDB_SERVICE_HOSTNAME} service`,
            }),
          )
        : Effect.succeed(service.id);
    }),
  );

const readStoredPairs = (target: SpicedbTlsTarget) =>
  Effect.gen(function* readStoredPairsEffect() {
    const api = yield* ZeropsPublicApi;
    const secrets = yield* api.serviceSecrets(yield* spicedbServiceId(target.projectId));
    const grpc: PairEntry = {
      expectation: grpcExpectation,
      pair: SPICEDB_GRPC_TLS,
      stored: readStoredPair(secrets, SPICEDB_GRPC_TLS),
    };
    const gateway: PairEntry = {
      expectation: gatewayExpectation(target),
      pair: SPICEDB_HTTP_TLS,
      stored: readStoredPair(secrets, SPICEDB_HTTP_TLS),
    };
    return { gateway, grpc };
  });

/** The verification item: both pairs exist on the `spicedb` service and hold. */
export const spicedbTlsState = (target: SpicedbTlsTarget) =>
  Effect.gen(function* spicedbTlsStateEffect() {
    const now = yield* DateTime.now;
    const { gateway, grpc } = yield* readStoredPairs(target);
    const problems = [grpc, gateway].flatMap((entry) =>
      Option.match(storedPairProblem(entry, now), {
        onNone: () => [],
        onSome: (problem) => [`${pairLabel(entry.pair)}: ${problem}`],
      }),
    );
    return problems.length === 0 ? Option.none<string>() : Option.some(problems.join('; '));
  });

// ---------------------------------------------------------------------------------------------
// Creating the pairs

const OPENSSL = 'openssl';
const EC_KEY_ARGS = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
const CERTIFICATE_BLOCK = 'CERTIFICATE';

const sanEntry = (name: string) => (isIP(name) === 0 ? `DNS:${name}` : `IP:${name}`);
const subjectAltName = (names: readonly string[]) => `subjectAltName=${names.map(sanEntry).join(',')}`;

/**
 * Runs OpenSSL with its key and output in a private temporary directory, removed afterwards, and
 * reads both back. Linux OpenSSL cannot open `/dev/stdout` when it is a socket, as Node's child
 * standard output is, so the files are the portable path.
 */
const opensslOutput = (args: readonly string[], block: string) =>
  Effect.scoped(
    Effect.gen(function* opensslOutputEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'spicedb-tls-' });
      const keyPath = nodePath.join(directory, 'key.pem');
      const outputPath = nodePath.join(directory, 'output.pem');
      yield* runCommand({ args: [...args, '-keyout', keyPath, '-out', outputPath], command: OPENSSL });
      const privateKey = pemBlocks(yield* fileSystem.readFileString(keyPath)).get('PRIVATE KEY');
      const other = pemBlocks(yield* fileSystem.readFileString(outputPath)).get(block);
      return privateKey === undefined || other === undefined
        ? yield* new StageOperationError({ message: `openssl did not write a private key and a ${block}` })
        : { other, privateKey: Redacted.make(privateKey) };
    }),
  ).pipe(
    Effect.catchTag('PlatformError', (cause) =>
      Effect.fail(new StageOperationError({ cause, message: `openssl output could not be read (${cause.message})` })),
    ),
  );

/** A self-signed server certificate for the gRPC names, never marked as a CA. */
export const generateGrpcMaterial = opensslOutput(
  [
    'req',
    '-x509',
    ...EC_KEY_ARGS,
    '-days',
    String(SELF_SIGNED_VALIDITY_DAYS),
    '-subj',
    `/CN=${SPICEDB_SERVICE_HOSTNAME}`,
    '-addext',
    subjectAltName(SPICEDB_GRPC_TLS_NAMES),
    '-addext',
    'basicConstraints=critical,CA:FALSE',
    '-addext',
    'extendedKeyUsage=serverAuth',
  ],
  CERTIFICATE_BLOCK,
).pipe(Effect.map(({ other, privateKey }): TlsMaterial => ({ certificate: other, privateKey })));

/** A fresh key whose CSR the Cloudflare Origin CA signs for the gateway hostname. */
export const generateGatewayMaterial = (gatewayHostname: string) =>
  Effect.gen(function* generateGatewayMaterialEffect() {
    const { other: csr, privateKey } = yield* opensslOutput(
      ['req', '-new', ...EC_KEY_ARGS, '-subj', `/CN=${gatewayHostname}`],
      `${CERTIFICATE_BLOCK} REQUEST`,
    );
    const api = yield* CloudflareApi;
    const { certificate } = yield* api.createOriginCertificate({ csr, hostnames: [gatewayHostname] });
    return { certificate, privateKey } satisfies TlsMaterial;
  });

const storePair = <E, R>(target: SpicedbTlsTarget, entry: PairEntry, generate: Effect.Effect<TlsMaterial, E, R>) =>
  Effect.gen(function* storePairEffect() {
    const { expectation, pair } = entry;
    const material = yield* generate;
    const problem = tlsMaterialProblem(material, expectation, yield* DateTime.now);
    if (Option.isSome(problem)) {
      return yield* new StageOperationError({
        message: `the new ${pair.label} TLS material does not hold: ${problem.value}; nothing was stored`,
      });
    }
    const serviceId = yield* spicedbServiceId(target.projectId);
    const api = yield* ZeropsPublicApi;
    // The key goes first: a run that fails in between leaves only the key, which the next run reports.
    yield* api.createServiceSecret(serviceId, pair.privateKeyKey, Redacted.value(material.privateKey));
    yield* api.createServiceSecret(serviceId, pair.certificateKey, material.certificate);
    return yield* Effect.void;
  });

const ensurePair = <E, R>(
  target: SpicedbTlsTarget,
  entry: PairEntry,
  create: { readonly description: string; readonly generate: Effect.Effect<TlsMaterial, E, R> },
) =>
  Effect.gen(function* ensurePairEffect() {
    const { pair } = entry;
    const absent = Match.value(entry.stored).pipe(
      Match.tag('Absent', () => true),
      Match.orElse(() => false),
    );
    if (absent) {
      return yield* perform(
        `${create.description} and store it as the sensitive ${SPICEDB_SERVICE_HOSTNAME} secrets ${pair.certificateKey} and ${pair.privateKeyKey}`,
        storePair(target, entry, create.generate),
      );
    }
    const problem = storedPairProblem(entry, yield* DateTime.now);
    if (Option.isSome(problem)) {
      return yield* new StageOperationError({ message: `${pairLabel(pair)}: ${problem.value}` });
    }
    return yield* Console.log(`${pairLabel(pair)} exist and hold`);
  });

/**
 * Creates each missing pair on the Zerops `spicedb` service. Values reach Zerops only through its
 * REST API (`zcli` cannot set service secrets); SpiceDB reads them from its next deploy on.
 */
export const ensureSpicedbTls = (target: SpicedbTlsTarget) =>
  Effect.gen(function* ensureSpicedbTlsEffect() {
    const { gateway, grpc } = yield* readStoredPairs(target);
    yield* ensurePair(target, grpc, {
      description: `create a self-signed ${SPICEDB_GRPC_TLS.label} certificate for ${SPICEDB_GRPC_TLS_NAMES.join(', ')}`,
      generate: generateGrpcMaterial,
    });
    yield* ensurePair(target, gateway, {
      description: `request a Cloudflare Origin CA ${SPICEDB_HTTP_TLS.label} certificate for ${target.gatewayHostname}`,
      generate: generateGatewayMaterial(target.gatewayHostname),
    });
  });
