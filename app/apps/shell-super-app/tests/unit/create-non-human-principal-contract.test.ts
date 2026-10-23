import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CreateNonHumanPrincipalPayloadSchema } from '../../shared/api.ts';

/**
 * `system` is reserved for Core-attested workloads. A persisted kind is never evidence of Core attestation, so
 * the public contract must not let a tenant identity administrator mint one.
 */

const decode = (kind: string) =>
  Effect.exit(Schema.decodeUnknownEffect(CreateNonHumanPrincipalPayloadSchema)({ displayName: 'probe', kind }));

it.effect('rejects the reserved system principal kind from the public payload', () =>
  Effect.gen(function* rejectsSystemKind() {
    expect(Exit.isFailure(yield* decode('system'))).toBe(true);
  }),
);

it.effect('accepts the non-human kinds an administrator may create', () =>
  Effect.gen(function* acceptsNonHumanKinds() {
    expect(Exit.isSuccess(yield* decode('service'))).toBe(true);
    expect(Exit.isSuccess(yield* decode('integration'))).toBe(true);
  }),
);
