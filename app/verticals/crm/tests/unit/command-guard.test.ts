import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { assertCommandAllowed, principalKindOf, withCommandGuard } from '../../shared/actions/command-guard.ts';
import { CrmPermissionDenied } from '../../shared/errors/crm-permission-denied.ts';

const deniedCommands = [
  'ArchiveClient',
  'AssignClient',
  'CreateClient',
  'UpdateClient',
  'AddContactPerson',
  'UpdateContactPerson',
  'RecordVisit',
  'PairOrder',
  'AiDecideChanges',
  'AiRevertBatch',
] as const;
const isRejection = Schema.is(CrmPermissionDenied);

it('treats sessions as human and API keys or system jobs as non-human', () => {
  expect(principalKindOf('session')).toBe('human');
  expect(principalKindOf('support_impersonation')).toBe('human');
  expect(principalKindOf('api_key')).toBe('non_human');
  expect(principalKindOf('system')).toBe('non_human');
});

it.effect('lets humans run every command', () =>
  Effect.forEach(deniedCommands, (tag) => assertCommandAllowed('human', tag), { discard: true }),
);

it.effect('rejects reserved commands for non-human principals', () =>
  Effect.forEach(
    deniedCommands,
    (tag) =>
      assertCommandAllowed('non_human', tag).pipe(
        Effect.flip,
        Effect.map((failure) => expect(isRejection(failure)).toBe(true)),
      ),
    { discard: true },
  ),
);

it.effect('lets non-human principals only propose AI changes', () =>
  assertCommandAllowed('non_human', 'AiProposeChanges'),
);

it.effect('guards the wrapped handler before it runs', () =>
  Effect.gen(function* guardedHandler() {
    let ran = false;
    const guarded = withCommandGuard(
      (
        _payload: { readonly command: { readonly _tag: string } },
        _context: { readonly scope: { readonly authMethod: 'api_key' | 'session' } },
      ) =>
        Effect.sync(() => {
          ran = true;
        }),
    );
    const failure = yield* guarded({ command: { _tag: 'ArchiveClient' } }, { scope: { authMethod: 'api_key' } }).pipe(
      Effect.flip,
    );
    expect(isRejection(failure)).toBe(true);
    expect(ran).toBe(false);
    yield* guarded({ command: { _tag: 'ArchiveClient' } }, { scope: { authMethod: 'session' } });
    expect(ran).toBe(true);
  }),
);
