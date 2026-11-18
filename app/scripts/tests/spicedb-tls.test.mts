import { X509Certificate, createPrivateKey } from 'node:crypto';

import { Effect, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { LocalSpicedbTlsLive } from '../local-spicedb-tls.mts';
import { generateGrpcMaterial } from '../ops/spicedb-tls.mts';

// DER of the prime256v1 OID (1.2.840.10045.3.1.7): present only when the key names its curve.
const PRIME256V1_OID = Buffer.from('06082a8648ce3d030107', 'hex');

it.effect('generates a gRPC server certificate for the SpiceDB names with a named curve SpiceDB accepts', () =>
  Effect.gen(function* generatesGrpcMaterial() {
    const material = yield* generateGrpcMaterial;
    const certificate = new X509Certificate(material.certificate);
    expect(certificate.checkHost('spicedb')).toBe('spicedb');
    expect(certificate.checkHost('localhost')).toBe('localhost');
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(certificate.ca).toBe(false);
    expect(certificate.checkPrivateKey(createPrivateKey(Redacted.value(material.privateKey)))).toBe(true);
    // Go's X.509 parser requires a named-curve OID instead of explicit EC field parameters.
    const publicKey = certificate.publicKey.export({ format: 'der', type: 'spki' });
    expect(certificate.publicKey.asymmetricKeyType).toBe('ec');
    expect(publicKey.includes(PRIME256V1_OID)).toBe(true);
  }).pipe(Effect.provide(LocalSpicedbTlsLive)),
);
