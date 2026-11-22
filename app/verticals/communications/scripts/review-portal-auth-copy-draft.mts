#!/usr/bin/env node
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { PrepareTemplateRevisionPayloadSchema, TemplateScopeSchema } from '../shared/template-revision.ts';
import { portalAuthCopyPreparePayloads, portalAuthCopyReview } from '../src/domain/catalog/portal-auth-copy-draft.ts';

/**
 * `copy:portal-auth:review` — read-only. Prints the DRAFT Portal Auth e-mail copy with its placeholders visible and the
 * content digest each prepared revision must carry. With both `--scope` and `--reason` it also prints the six payloads of
 * the governed `prepare-template-revision` Action. It writes nothing, calls no Action and never activates anything: the
 * operator submits the payloads under their own authenticated session, which supplies the Tenant and the principal.
 */

class PortalAuthCopyReviewInputInvalid extends Schema.TaggedError<PortalAuthCopyReviewInputInvalid>()(
  'PortalAuthCopyReviewInputInvalid',
  { message: Schema.String },
) {}

const LEGAL_ENTITY_PREFIX = 'legal-entity:';
const decodeScope = Schema.decodeUnknownEffect(TemplateScopeSchema);
const encodePayloads = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(PrepareTemplateRevisionPayloadSchema), { space: 2 }),
);
const invalid = (message: string) => new PortalAuthCopyReviewInputInvalid({ message });

const scopeOf = (value: string) =>
  decodeScope(
    value.startsWith(LEGAL_ENTITY_PREFIX)
      ? { kind: 'legal-entity', legalEntityId: value.slice(LEGAL_ENTITY_PREFIX.length) }
      : { kind: value },
  ).pipe(Effect.mapError(() => invalid('--scope must be "tenant" or "legal-entity:<uuid>"')));

const payloadsOf = Effect.fn('PortalAuthCopyReview.payloads')(function* payloads(scope: string, reason: string) {
  const prepared = yield* portalAuthCopyPreparePayloads({ reason, scope: yield* scopeOf(scope) }).pipe(
    Effect.mapError(() => invalid('--reason must be 1 to 500 characters without surrounding whitespace')),
  );
  return yield* encodePayloads(prepared).pipe(Effect.mapError(() => invalid('the payloads could not be encoded')));
});

const review = Effect.fn('PortalAuthCopyReview.run')(function* run(
  scope: Option.Option<string>,
  reason: Option.Option<string>,
) {
  if (Option.isSome(scope) !== Option.isSome(reason)) {
    return yield* invalid(
      '--scope and --reason are both required to print the prepare payloads; neither has a default',
    );
  }
  yield* Console.log(yield* portalAuthCopyReview());
  if (Option.isSome(scope) && Option.isSome(reason)) {
    yield* Console.log(`\n# prepare-template-revision payloads\n\n${yield* payloadsOf(scope.value, reason.value)}`);
  }
  return yield* Effect.void;
});

const command = Command.make(
  'review-portal-auth-copy-draft',
  { reason: Flag.String('reason').pipe(Flag.optional), scope: Flag.String('scope').pipe(Flag.optional) },
  ({ reason, scope }) => review(scope, reason),
);

const mainLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid));
