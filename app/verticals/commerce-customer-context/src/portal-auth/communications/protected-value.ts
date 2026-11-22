import { Context, Crypto, Effect, Layer, Option, Redacted, Ref, Result, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';

import { CommercePortalAuthConfig } from '../../../api/portal-auth/provider/config-service.ts';
import { withSafeCause } from '../../../api/portal-auth/provider/safe-failure.ts';

import { PortalAuthCommunicationUnavailable } from './communication-unavailable.ts';
import type { HeldIssuance, PortalAuthIssuance } from './issuance.ts';

/**
 * The SEALED form of an issuance's protected side (D2): the original address, the secret and the ledger token, encrypted with
 * AES-256-GCM under a key Auth derives from its own realm secret, with the issuance's identity, flow and subject as associated
 * data. Only an Auth process holding the realm secret can open it, and only as the issuance it was sealed for: a value moved to
 * another row does not open. A value that does not open (another or rotated secret, a tampered row) is never guessed at: the
 * issuance is NOT_RESUMABLE, a truthful stop, and nothing is reproduced or reissued.
 */
export interface ProtectedValueSealerService {
  readonly open: (
    issuance: PortalAuthIssuance,
    sealed: string,
  ) => Effect.Effect<Option.Option<Pick<HeldIssuance, 'endpoint' | 'ledgerToken' | 'secret'>>>;
  readonly seal: (held: HeldIssuance) => Effect.Effect<string, PortalAuthCommunicationUnavailable>;
}

export class CommercePortalAuthProtectedValueSealer extends Context.Service<
  CommercePortalAuthProtectedValueSealer,
  ProtectedValueSealerService
>()(
  '@app/commerce-customer-context/portal-auth/communications/protected-value/CommercePortalAuthProtectedValueSealer',
) {}

const FORMAT = 'v1';
const IV_BYTES = 12;
const KEY_SALT = 'commerce.customer-context.portal-auth';
const KEY_INFO = 'commerce.customer-context/portal-auth/communications/protected-value/v1';
const SEAL_OPERATION = 'protected-value-seal';
/** A local cipher call that does not answer in time is an unavailable sealer, never a hang of the flow. */
const CIPHER_TIMEOUT = '5 seconds';

const ProtectedValueSchema = Schema.fromJsonString(
  Schema.Struct({
    endpoint: Schema.RedactedFromValue(Schema.String),
    ledgerToken: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
    secret: Schema.RedactedFromValue(Schema.String),
  }),
);
const encodePlain = Schema.encodeEffect(ProtectedValueSchema);
const decodePlain = Schema.decodeUnknownOption(ProtectedValueSchema);

const utf8 = (text: string) => new TextEncoder().encode(text);
const associatedDataOf = (issuance: PortalAuthIssuance) =>
  utf8(`${issuance.issuanceRef}|${issuance.flow}|${issuance.providerSubjectId}`);

/** The failure keeps only its safe kind: a cipher or encoding failure must never carry the plain value. */
const sealUnavailable = (cause: unknown) =>
  withSafeCause(new PortalAuthCommunicationUnavailable({ operation: SEAL_OPERATION }), cause);
const timedOut = () => Effect.fail(sealUnavailable('timeout'));

/** One WebCrypto call, bounded and typed. */
const cipherCall = <Value>(call: () => Promise<Value>) =>
  Effect.tryPromise({ catch: sealUnavailable, try: call }).pipe(
    Effect.timeoutOrElse({ duration: CIPHER_TIMEOUT, orElse: timedOut }),
  );

/** The AES-GCM key of the realm secret; never exported. */
const deriveKey = (secret: Redacted.Redacted) => {
  const { subtle } = globalThis.crypto;
  return cipherCall(
    subtle.importKey.bind(subtle, 'raw', utf8(Redacted.value(secret)), 'HKDF', false, ['deriveKey']),
  ).pipe(
    Effect.flatMap((base) =>
      cipherCall(
        subtle.deriveKey.bind(
          subtle,
          { hash: 'SHA-256', info: utf8(KEY_INFO), name: 'HKDF', salt: utf8(KEY_SALT) },
          base,
          { length: 256, name: 'AES-GCM' },
          false,
          ['encrypt', 'decrypt'],
        ),
      ),
    ),
  );
};

const plainOf = (held: HeldIssuance) =>
  held.ledgerToken === undefined
    ? { endpoint: held.endpoint, secret: held.secret }
    : { endpoint: held.endpoint, ledgerToken: held.ledgerToken, secret: held.secret };

const sealedParts = (sealed: string) => {
  const [format, iv, body, ...rest] = sealed.split('.');
  if (format !== FORMAT || iv === undefined || body === undefined || rest.length > 0) {
    return Option.none();
  }
  const ivBytes = Base64Url.decode(iv);
  const bodyBytes = Base64Url.decode(body);
  return Result.isSuccess(ivBytes) && Result.isSuccess(bodyBytes)
    ? Option.some({ body: new Uint8Array(bodyBytes.success), iv: new Uint8Array(ivBytes.success) })
    : Option.none();
};

const openedValueOf = (bytes: ArrayBuffer) => decodePlain(new TextDecoder().decode(bytes));

/** The sealer over one realm secret. */
const makeProtectedValueSealer = Effect.fn('CommercePortalAuthProtectedValueSealer.make')(function* makeSealer(
  secret: Redacted.Redacted,
) {
  const crypto = yield* Crypto.Crypto;
  // only a derived key is kept for the process: a failed derivation (a timeout, an unavailable WebCrypto) is retried by the
  // next seal or open instead of making every later one fail until the process restarts
  const derivedKey = yield* Ref.make(Option.none<CryptoKey>());
  const key = Ref.get(derivedKey).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => deriveKey(secret).pipe(Effect.tap((derived) => Ref.set(derivedKey, Option.some(derived)))),
        onSome: Effect.succeed,
      }),
    ),
  );
  const { subtle } = globalThis.crypto;

  const seal = Effect.fn('CommercePortalAuthProtectedValueSealer.seal')(function* sealValue(held: HeldIssuance) {
    // the plain text exists only inside this function: an encoding failure keeps no part of it
    const [derived, iv, plain] = yield* Effect.all(
      [
        key,
        crypto.randomBytes(IV_BYTES).pipe(Effect.mapError(sealUnavailable)),
        encodePlain(plainOf(held)).pipe(Effect.mapError(sealUnavailable)),
      ],
      { concurrency: 1 },
    );
    const body = yield* cipherCall(
      subtle.encrypt.bind(
        subtle,
        { additionalData: associatedDataOf(held.issuance), iv: new Uint8Array(iv), name: 'AES-GCM' },
        derived,
        utf8(plain),
      ),
    );
    return `${FORMAT}.${Base64Url.encode(iv)}.${Base64Url.encode(new Uint8Array(body))}`;
  });

  const open = Effect.fn('CommercePortalAuthProtectedValueSealer.open')(function* openValue(
    issuance: PortalAuthIssuance,
    sealed: string,
  ) {
    const parts = sealedParts(sealed);
    const derived = yield* key.pipe(Effect.option);
    if (Option.isNone(parts) || Option.isNone(derived)) {
      return Option.none();
    }
    // a value that does not authenticate (another secret, another issuance, a tampered row) opens to nothing
    const plain = yield* cipherCall(
      subtle.decrypt.bind(
        subtle,
        { additionalData: associatedDataOf(issuance), iv: parts.value.iv, name: 'AES-GCM' },
        derived.value,
        parts.value.body,
      ),
    ).pipe(Effect.option);
    return plain.pipe(Option.flatMap(openedValueOf));
  });

  return { open, seal } satisfies ProtectedValueSealerService;
});

/** The sealer over a given realm secret (a test or a composition that already holds the secret). */
export const protectedValueSealerLayer = (secret: Redacted.Redacted) =>
  Layer.effect(CommercePortalAuthProtectedValueSealer, makeProtectedValueSealer(secret));

/** The sealer over the realm secret of this deployment: every Auth process of the deployment opens the same values (D2). */
export const CommercePortalAuthProtectedValueSealerLive = Layer.effect(
  CommercePortalAuthProtectedValueSealer,
  Effect.gen(function* makeCommercePortalAuthProtectedValueSealerLive() {
    const configuration = yield* CommercePortalAuthConfig;
    return yield* makeProtectedValueSealer(configuration.secret);
  }),
);
