import { expect, it } from 'effect-rstest';

import { Effect, Option, Predicate } from 'effect';
import type {
  PrincipalManagementPersistence,
  PrincipalManagementRepositoryService,
} from '../../src/auth/principal-management.ts';
import {
  bindApiKey,
  changePrincipalStatus,
  PrincipalManagementRepository,
  principalManagementRepositoryFromPersistence,
  setApiKeyBindingStatus,
  validateSupportImpersonation,
} from '../../src/auth/principal-management.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const authBindingId = '30000000-0000-4000-8000-000000000001';

const unconfigured = (operation: string) =>
  Effect.die(`${operation} is not configured in this test`);
const repositoryDefaults: PrincipalManagementPersistence = {
  createPrincipal: () => unconfigured('createPrincipal'),
  insertApiKeyBinding: () => unconfigured('insertApiKeyBinding'),
  loadApiKeyBinding: () => unconfigured('loadApiKeyBinding'),
  loadPrincipal: () => unconfigured('loadPrincipal'),
  loadSupportBindings: () => unconfigured('loadSupportBindings'),
  updateApiKeyBindingStatus: () => unconfigured('updateApiKeyBindingStatus'),
  updatePrincipalStatus: () => unconfigured('updatePrincipalStatus'),
};
const repository = (
  overrides: Partial<PrincipalManagementPersistence>,
): PrincipalManagementRepositoryService =>
  principalManagementRepositoryFromPersistence({ ...repositoryDefaults, ...overrides });
type OptionValue<Outcome> = Outcome extends Option.Option<infer Value> ? Value : never;
type PrincipalRecord = OptionValue<
  Effect.Success<ReturnType<PrincipalManagementPersistence['loadPrincipal']>>
>;
type ApiKeyBindingRecord = OptionValue<
  Effect.Success<ReturnType<PrincipalManagementPersistence['loadApiKeyBinding']>>
>;
const selectingPrincipal = (record: PrincipalRecord | undefined) =>
  repository({ loadPrincipal: () => Effect.succeed(Option.fromNullishOr(record)) });
const selectingBinding = (record: ApiKeyBindingRecord | undefined) =>
  repository({ loadApiKeyBinding: () => Effect.succeed(Option.fromNullishOr(record)) });
const repositoryForSupportParticipants = (
  results: readonly (readonly { readonly authBindingId: string }[])[],
) => {
  let call = 0;
  return repository({
    loadSupportBindings: () =>
      Effect.sync(() => {
        const result = results[call] ?? [];
        call += 1;
        return result;
      }),
  });
};
const provideRepository = (service: PrincipalManagementRepositoryService) =>
  Effect.provideService(PrincipalManagementRepository, service);
it.effect('rejects human principal administration and managed keys targeting humans', () =>
  Effect.gen(function* rejectsHumanPrincipalAdministration() {
    const transaction = selectingPrincipal({ kind: 'human', status: 'active' });
    const principalError = yield* Effect.flip(
      changePrincipalStatus({
        expectedStatus: 'active',
        newStatus: 'disabled',
        principalId,
        reason: 'Offboarding',
        tenantId,
      }).pipe(provideRepository(transaction)),
    );
    const bindingError = yield* Effect.flip(
      bindApiKey({
        managed: true,
        principalId,
        providerSubjectId: 'provider-key-id',
        tenantId,
      }).pipe(provideRepository(transaction)),
    );

    expect(Predicate.isTagged(principalError, 'IdentityTargetInvalidError')).toBe(true);
    expect(Predicate.isTagged(bindingError, 'IdentityTargetInvalidError')).toBe(true);
  }),
);
it.effect('enforces expected state, terminal revocation, and revocation reasons', () =>
  Effect.gen(function* enforcesBindingLifecycle() {
    const conflictError = yield* Effect.flip(
      setApiKeyBindingStatus({
        authBindingId,
        expectedStatus: 'active',
        managed: true,
        newStatus: 'revoked',
        principalId,
        reason: 'Rotate',
        tenantId,
      }).pipe(
        provideRepository(
          selectingBinding({
            bindingStatus: 'disabled',
            principalKind: 'service',
            principalStatus: 'active',
          }),
        ),
      ),
    );
    const terminalError = yield* Effect.flip(
      setApiKeyBindingStatus({
        authBindingId,
        expectedStatus: 'revoked',
        managed: true,
        newStatus: 'active',
        principalId,
        tenantId,
      }).pipe(
        provideRepository(
          selectingBinding({
            bindingStatus: 'revoked',
            principalKind: 'service',
            principalStatus: 'active',
          }),
        ),
      ),
    );
    const reasonError = yield* Effect.flip(
      setApiKeyBindingStatus({
        authBindingId,
        expectedStatus: 'active',
        managed: true,
        newStatus: 'revoked',
        principalId,
        reason: '   ',
        tenantId,
      }).pipe(
        provideRepository(
          selectingBinding({
            bindingStatus: 'active',
            principalKind: 'service',
            principalStatus: 'active',
          }),
        ),
      ),
    );

    expect(Predicate.isTagged(conflictError, 'IdentityLifecycleConflictError')).toBe(true);
    expect(Predicate.isTagged(terminalError, 'IdentityLifecycleConflictError')).toBe(true);
    expect(Predicate.isTagged(reasonError, 'IdentityTargetInvalidError')).toBe(true);
  }),
);
it.effect('rejects managed binding transitions for human or inactive targets', () =>
  Effect.gen(function* rejectsIneligibleBindingTargets() {
    const records = [
      { bindingStatus: 'active', principalKind: 'human', principalStatus: 'active' },
      { bindingStatus: 'active', principalKind: 'service', principalStatus: 'disabled' },
    ] satisfies readonly ApiKeyBindingRecord[];
    yield* Effect.all(
      records.map((record) =>
        Effect.gen(function* rejectsIneligibleBindingTarget() {
          const error = yield* Effect.flip(
            setApiKeyBindingStatus({
              authBindingId,
              expectedStatus: 'active',
              managed: true,
              newStatus: 'disabled',
              principalId,
              tenantId,
            }).pipe(provideRepository(selectingBinding(record))),
          );
          expect(Predicate.isTagged(error, 'IdentityTargetInvalidError')).toBe(true);
        }),
      ),
    );
  }),
);
it.effect(
  'binds only eligible active self and managed principal kinds without secret material',
  () =>
    Effect.gen(function* bindsEligiblePrincipal() {
      let inserted:
        | Parameters<PrincipalManagementPersistence['insertApiKeyBinding']>[0]
        | undefined;
      const transaction = repository({
        insertApiKeyBinding: (value) =>
          Effect.sync(() => {
            inserted = value;
            return Option.some({ authBindingId });
          }),
        loadPrincipal: () => Effect.succeed(Option.some({ kind: 'service', status: 'active' })),
      });
      const result = yield* bindApiKey({
        managed: true,
        principalId,
        providerSubjectId: 'provider-key-id',
        tenantId,
      }).pipe(provideRepository(transaction));

      expect(result).toEqual({ authBindingId, status: 'active' });
      expect(inserted?.providerSubjectId).toBe('provider-key-id');
      expect('key' in (inserted ?? {})).toBe(false);
      expect('secret' in (inserted ?? {})).toBe(false);
      expect('hash' in (inserted ?? {})).toBe(false);
    }),
);
it.effect('maps an existing API key binding to a lifecycle conflict', () =>
  Effect.gen(function* mapsExistingBindingToConflict() {
    const transaction = repository({
      insertApiKeyBinding: () => Effect.succeed(Option.none()),
      loadPrincipal: () => Effect.succeed(Option.some({ kind: 'service', status: 'active' })),
    });

    const error = yield* Effect.flip(
      bindApiKey({
        managed: true,
        principalId,
        providerSubjectId: 'duplicate-provider-key-id',
        tenantId,
      }).pipe(provideRepository(transaction)),
    );

    expect(Predicate.isTagged(error, 'IdentityLifecycleConflictError')).toBe(true);
  }),
);
it.effect(
  'requires exactly one active tenant-local user binding for both impersonation participants',
  () =>
    Effect.gen(function* validatesSupportParticipants() {
      const original = [{ authBindingId }];
      const target = [{ authBindingId: '30000000-0000-4000-8000-000000000002' }];
      const input: Parameters<typeof validateSupportImpersonation>[0] = {
        checkpoint: 'requested',
        originalAuthBindingId: authBindingId,
        originalPrincipalId: principalId,
        targetPrincipalId: '20000000-0000-4000-8000-000000000002',
        tenantId,
      };

      yield* validateSupportImpersonation(input).pipe(
        provideRepository(repositoryForSupportParticipants([original, target])),
      );
      const error = yield* Effect.flip(
        validateSupportImpersonation(input).pipe(
          provideRepository(repositoryForSupportParticipants([original, []])),
        ),
      );

      expect(Predicate.isTagged(error, 'IdentityTargetInvalidError')).toBe(true);

      yield* validateSupportImpersonation({
        ...input,
        checkpoint: 'stopped',
      }).pipe(provideRepository(repositoryForSupportParticipants([original, target])));
    }),
);
