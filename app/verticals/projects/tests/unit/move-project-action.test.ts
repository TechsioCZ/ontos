import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MoveProjectPayloadSchema } from '../../shared/actions/move-project.ts';
import { projectId } from '../support/project.ts';

it.effect('represents a Move to the root explicitly', () =>
  Effect.gen(function* moveToRoot() {
    const payload = yield* Schema.decodeUnknownEffect(MoveProjectPayloadSchema)({ parentProjectId: null, projectId });
    expect(Option.isNone(payload.parentProjectId)).toBe(true);
  }),
);
it.effect('rejects Prefix or creation metadata as Move fields', () =>
  Effect.gen(function* immutableMoveFields() {
    const decoded = yield* Schema.decodeUnknownEffect(MoveProjectPayloadSchema)(
      { parentProjectId: null, prefix: 'NEW', projectId },
      { onExcessProperty: 'error' },
    ).pipe(Effect.result);
    expect(Result.isFailure(decoded)).toBe(true);
  }),
);
