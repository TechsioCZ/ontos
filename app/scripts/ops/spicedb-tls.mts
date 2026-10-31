import { isIP } from 'node:net';
import nodePath from 'node:path';

import { Effect, FileSystem, Redacted, Schema } from 'effect';

import { runCommand } from './ops-shell.mts';
import { StageOperationError } from './stage-operation-error.mts';

/**
 * The SpiceDB gRPC listener's TLS material: a self-signed certificate for `spicedb`, `localhost` and
 * `127.0.0.1`, which clients pin as their only trusted CA (`SPICEDB_CA_CERT`).
 */
const SPICEDB_SERVICE_HOSTNAME = 'spicedb';
const SPICEDB_GRPC_TLS_NAMES = ['spicedb', 'localhost', '127.0.0.1'] as const;
const SELF_SIGNED_VALIDITY_DAYS = 3650;

const TlsMaterialSchema = Schema.Struct({ certificate: Schema.String, privateKey: Schema.Redacted(Schema.String) });
type TlsMaterial = typeof TlsMaterialSchema.Type;

const PEM_BLOCK = /-----BEGIN (?<label>[A-Z ]+)-----\r?\n[\s\S]+?\r?\n-----END \k<label>-----/gu;

/** The PEM blocks of `text` by label, such as `PRIVATE KEY` or `CERTIFICATE`. */
const pemBlocks = (text: string): ReadonlyMap<string, string> =>
  new Map(
    [...text.matchAll(PEM_BLOCK)].map((match) => {
      const { label = '' } = match.groups ?? {};
      return [label, `${match[0]}\n`];
    }),
  );

const OPENSSL = 'openssl';
// LibreSSL otherwise emits explicit EC parameters that SpiceDB's Go X.509 parser rejects.
const EC_KEY_ARGS = [
  '-newkey',
  'ec',
  '-pkeyopt',
  'ec_paramgen_curve:prime256v1',
  '-pkeyopt',
  'ec_param_enc:named_curve',
  '-nodes',
];
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
