import { updateTagAction } from '../../src/actions/update-tag.action.ts';
import { prepareTaggingCommand } from '../../src/services/persistence.service.ts';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TaggingCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { taggingRegistration } from '../../vertical.registration.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:tagging-command',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeSync(TaggingCommandPayloadSchema)({
  command: {
    _tag: 'CreateTag',
    color: 'blue',
    name: 'Regresní test',
    subjectKinds: ['opportunity'],
  },
  expectedRevision: 0,
});

const commands = [
  payload,
  Schema.decodeSync(TaggingCommandPayloadSchema)({
    command: { _tag: 'UpdateTag', id: '50000000-0000-4000-8000-000000000001', patch: { name: 'Upravený štítek' } },
    expectedRevision: 1,
  }),
];
for (const [index, command] of commands.entries()) {
  for (const access of ['denied', 'unavailable'] as const) {
    it.effect(`registered tagging command ${index} refuses ${access} before owner SQL`, () =>
      Effect.scoped(
        Effect.gen(function* refusesBeforeSql() {
          const harness = yield* makeActionTestHarness({ access, ownerRegistration: taggingRegistration });
          const request = {
            payload: Schema.encodeSync(TaggingCommandPayloadSchema)(command),
            principal,
            transport: { correlationId: 'tagging-command', idempotencyKey: `tagging-${index}-${access}` },
          };
          const failure = yield* (
            index === 0
              ? harness.runtime.runAction({ ...request, registration: applyCommandAction })
              : harness.runtime.runAction({ ...request, registration: updateTagAction })
          ).pipe(Effect.flip);
          expect(failure._tag).toBe(access === 'denied' ? 'ActionPermissionDenied' : 'ActionPermissionCheckError');
          expect(harness.snapshot().transactionCount).toBe(0);
          expect(harness.snapshot().committed).toEqual([]);
        }),
      ),
    );
  }
}
it.effect('owner preparation does not re-decide run after Core admits an approval', () =>
  prepareTaggingCommand(payload.command, { ...principal, correlationId: 'approved-command' }),
);
