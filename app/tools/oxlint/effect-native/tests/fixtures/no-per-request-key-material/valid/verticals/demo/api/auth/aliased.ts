// Alias, submodule-namespace and root-barrel imports of Layer must all be recognised as "built once".
import { Layer as L } from 'effect';
import * as EffectNs from 'effect';
import * as LayerNs from 'effect/Layer';
import * as jose from 'jose';

declare const Tag: unknown;

export const A = L.effect(
  Tag as never,
  EffectNs.Effect.sync(() => jose.createLocalJWKSet({ keys: [] } as never)),
);

export const B = LayerNs.scoped(
  Tag as never,
  EffectNs.Effect.promise(() => jose.importJWK({} as never, 'EdDSA')),
);

export const C = EffectNs.Layer.sync(Tag as never, () => jose.importSPKI('pem', 'EdDSA'));

export const D = EffectNs.Effect.cachedWithTTL(
  EffectNs.Effect.sync(() => jose.createRemoteJWKSet(new URL('https://issuer.example/jwks'))),
  '5 minutes',
);
