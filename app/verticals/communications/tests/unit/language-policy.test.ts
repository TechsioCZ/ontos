import {
  ActionAlreadyCommitted,
  ActionPayloadValidationError,
  ActionPermissionDenied,
  ActionRequestHashConflict,
  OperationContextInvalid,
  ReadPermissionDenied,
} from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { SetLanguagePolicyPayloadSchema } from '../../shared/language-policy.ts';
import { setLanguagePolicyAction } from '../../src/actions/set-language-policy.action.ts';
import { languagePolicyRead } from '../../src/api/language-policy.read.ts';
import {
  effectiveLanguagePolicy,
  readLanguagePolicySnapshot,
  setLanguageMode,
} from '../../src/services/language-policy-domain.service.ts';
import { clampBusinessTime } from '../../src/services/template-revision-domain.service.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { makeInMemoryLanguagePolicyPort } from '../support/language-fixtures.ts';

const actor = {
  actionInvocationId: '00000000-0000-4000-8000-0000000000a1',
  principalId: '00000000-0000-4000-8000-0000000000b1',
};
const tenantOne = '11111111-1111-4111-8111-111111111111';
const tenantTwo = '22222222-2222-4222-8222-222222222222';
const principalOf = (tenantId: string) => ({
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:communications-language-policy',
  authMethod: 'session' as const,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
});
const transport = (key: string) => ({ correlationId: key, idempotencyKey: key });

describe('The effective Tenant language mode (L-13)', () => {
  it.effect(
    '[AC-11] a Tenant with no own choice is on the platform default B, and the pin says it is the default',
    () =>
      Effect.gen(function* defaultMode() {
        const { port } = makeInMemoryLanguagePolicyPort();
        expect(yield* effectiveLanguagePolicy(port)).toEqual({
          mode: 'B',
          policy: { platformDefaultVersion: 1, source: 'platform-default' },
        });
      }),
  );

  it.effect('[S08 AC-11] B to A to B appends versions, each with a safe reference and no principal data', () =>
    Effect.gen(function* switching() {
      const { port } = makeInMemoryLanguagePolicyPort();
      const toA = yield* setLanguageMode(port, 'A', actor);
      const toB = yield* setLanguageMode(port, 'B', actor);
      expect([toA.changed, toA.effective.mode, toB.changed, toB.effective.mode]).toEqual([true, 'A', true, 'B']);
      expect(toA.effective.policy).toMatchObject({ source: 'tenant', versionNumber: 1 });
      expect(toB.effective.policy).toMatchObject({ source: 'tenant', versionNumber: 2 });
      expect(Object.keys(toB.effective.policy).toSorted()).toEqual(['policyVersionId', 'source', 'versionNumber']);
      expect(yield* effectiveLanguagePolicy(port)).toEqual(toB.effective);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[AC-11] choosing the mode that is already the own latest choice appends nothing', () =>
    Effect.gen(function* same() {
      const { port, state } = makeInMemoryLanguagePolicyPort();
      yield* setLanguageMode(port, 'A', actor);
      const again = yield* setLanguageMode(port, 'A', actor);
      expect(again.changed).toBe(false);
      expect(state.versions).toHaveLength(1);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[S08 S09 AC-11] two Tenants keep their own mode: one Tenant changing does not change the other', () =>
    Effect.gen(function* isolation() {
      const one = makeInMemoryLanguagePolicyPort();
      const two = makeInMemoryLanguagePolicyPort();
      yield* setLanguageMode(one.port, 'A', actor);
      expect((yield* effectiveLanguagePolicy(one.port)).mode).toBe('A');
      expect(yield* effectiveLanguagePolicy(two.port)).toMatchObject({
        mode: 'B',
        policy: { source: 'platform-default' },
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[AC-11] an unreadable setting is "unreadable" for a decision, never the platform default', () =>
    Effect.gen(function* unreadable() {
      const { port, state } = makeInMemoryLanguagePolicyPort();
      yield* setLanguageMode(port, 'A', actor);
      state.unreadable = true;
      expect(yield* readLanguagePolicySnapshot(port)).toEqual({ kind: 'unreadable' });
      expect(Option.isNone(yield* Effect.option(effectiveLanguagePolicy(port)))).toBe(true);
      state.unreadable = false;
      expect(yield* readLanguagePolicySnapshot(port)).toMatchObject({ kind: 'effective', mode: 'A' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

const makeHarness = (access: 'allowed' | 'denied' | 'needs_approval', port = makeInMemoryLanguagePolicyPort()) =>
  Effect.gen(function* harnessEffect() {
    const harness = yield* makeActionTestHarness({
      access,
      ownerRegistration: communicationsRegistration,
      services: [bindActionTestServices(setLanguagePolicyAction, port.port)],
    });
    return { harness, memory: port };
  });

describe('The set Action through the Core Action runtime', () => {
  it.effect('[S08 AC-11] a permitted actor changes the own Tenant mode B to A and back to B', () =>
    Effect.gen(function* permitted() {
      const { harness, memory } = yield* makeHarness('allowed');
      const run = (mode: 'A' | 'B', key: string) =>
        harness.runtime.runAction({
          payload: { mode },
          principal: principalOf(tenantOne),
          registration: setLanguagePolicyAction,
          transport: transport(key),
        });
      const toA = yield* run('A', 'set-a');
      const toB = yield* run('B', 'set-b');
      expect([toA.effective.mode, toB.effective.mode]).toEqual(['A', 'B']);
      expect(memory.state.versions.map((version) => version.mode)).toEqual(['A', 'B']);
      expect(
        memory.state.versions.every((version) => version.setByPrincipalId === principalOf(tenantOne).principalId),
      ).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[S09 AC-11] a value other than A or B is rejected and nothing changes, even for a permitted actor', () =>
    Effect.gen(function* invalid() {
      const { harness, memory } = yield* makeHarness('allowed');
      for (const [key, body] of [
        ['set-c', '{"mode":"C"}'],
        ['set-lower', '{"mode":"a"}'],
        ['set-empty', '{"mode":""}'],
        ['set-missing', '{}'],
        ['set-null', '{"mode":null}'],
      ] as const) {
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: JSON.parse(body),
            principal: principalOf(tenantOne),
            registration: setLanguagePolicyAction,
            transport: transport(key),
          }),
        );
        expect(Schema.is(ActionPayloadValidationError)(failure)).toBe(true);
      }
      expect(memory.state.versions).toEqual([]);
      expect(harness.snapshot().stages).not.toContain('handler_executed');
      expect(Schema.is(SetLanguagePolicyPayloadSchema)({ mode: 'C' })).toBe(false);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[S09 AC-11] an actor without the Current permission is denied and the mode stays', () =>
    Effect.gen(function* denied() {
      for (const access of ['denied', 'needs_approval'] as const) {
        const { harness, memory } = yield* makeHarness(access);
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: { mode: 'A' },
            principal: principalOf(tenantOne),
            registration: setLanguagePolicyAction,
            transport: transport(`set-${access}`),
          }),
        );
        expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
        expect(memory.state.versions).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[S09 AC-11] the payload has no Tenant field: a Tenant named in it is refused (isolation itself: PostgreSQL integration test)',
    () =>
      Effect.gen(function* noTenantInPayload() {
        const { harness, memory } = yield* makeHarness('allowed');
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: JSON.parse(`{"mode":"A","tenantId":"${tenantTwo}"}`),
            principal: principalOf(tenantOne),
            registration: setLanguagePolicyAction,
            transport: transport('set-with-foreign-tenant'),
          }),
        );
        expect(Schema.is(ActionPayloadValidationError)(failure)).toBe(true);
        expect(memory.state.versions).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
        expect(Object.keys(SetLanguagePolicyPayloadSchema.fields)).toEqual(['mode']);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[AC-11] a replay with the same idempotency key appends nothing and answers the saved result', () =>
    Effect.gen(function* replay() {
      const { harness, memory } = yield* makeHarness('allowed');
      const run = (mode: 'A' | 'B', key: string, savedReply?: 'answer') =>
        harness.runtime.runAction({
          payload: { mode },
          principal: principalOf(tenantOne),
          registration: setLanguagePolicyAction,
          savedReply,
          transport: transport(key),
        });
      const first = yield* run('A', 'set-once');
      // an in-process caller meets the stop signal; a transport that lost its reply is answered with the saved one
      const stopped = yield* Effect.flip(run('A', 'set-once'));
      expect(Schema.is(ActionAlreadyCommitted)(stopped)).toBe(true);
      const answered = yield* run('A', 'set-once', 'answer');
      expect(answered).toEqual(first);
      expect(memory.state.versions).toHaveLength(1);
      expect(harness.snapshot().committed).toHaveLength(1);
      // the same key for a different request is a conflict, not a second change
      const conflict = yield* Effect.flip(run('B', 'set-once'));
      expect(Schema.is(ActionRequestHashConflict)(conflict)).toBe(true);
      expect(memory.state.versions).toHaveLength(1);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[S09 AC-11] the mode is Tenant-wide: a caller that selects a Legal Entity is refused and nothing changes',
    () =>
      Effect.gen(function* legalEntityScoped() {
        const { harness, memory } = yield* makeHarness('allowed');
        const failure = yield* Effect.flip(
          harness.runtime.runAction({
            payload: { mode: 'A' },
            principal: { ...principalOf(tenantOne), legalEntityId: '33333333-3333-4333-8333-333333333333' },
            registration: setLanguagePolicyAction,
            transport: transport('set-from-company'),
          }),
        );
        expect(Schema.is(OperationContextInvalid)(failure)).toBe(true);
        expect(memory.state.versions).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
        expect(setLanguagePolicyAction.descriptor.legalEntityScope).toBe('forbidden');
        expect(languagePolicyRead.descriptor.legalEntityScope).toBe('forbidden');
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe('Business time of a version follows the Tenant lock, not the transaction start', () => {
  it('[clock] the clamp never lets a version time precede the version it follows', () => {
    const clock = at('2026-11-19T10:00:00Z');
    expect(clampBusinessTime(clock, Option.none())).toEqual(clock);
    expect(clampBusinessTime(clock, Option.some(at('2026-11-19T09:59:59Z')))).toEqual(clock);
    expect(clampBusinessTime(clock, Option.some(at('2026-11-19T10:00:01Z')))).toEqual(at('2026-11-19T10:00:01Z'));
  });

  it.effect('[clock] a lagging clock is clamped: set_at never decreases while the version number grows', () =>
    Effect.gen(function* lagging() {
      const { port, state } = makeInMemoryLanguagePolicyPort();
      state.clock = at('2026-11-19T10:00:00Z');
      yield* setLanguageMode(port, 'A', actor);
      // the next writer's clock reads earlier than the version already committed
      state.clock = at('2026-11-19T09:58:00Z');
      yield* setLanguageMode(port, 'B', actor);
      state.clock = at('2026-11-19T10:05:00Z');
      yield* setLanguageMode(port, 'A', actor);
      expect(state.versions.map((version) => [version.versionNumber, DateTime.formatIso(version.setAt)])).toEqual([
        [1, '2026-11-19T10:00:00.000Z'],
        [2, '2026-11-19T10:00:00.000Z'],
        [3, '2026-11-19T10:05:00.000Z'],
      ]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

const versionRow = (tenantId: string, mode: 'A' | 'B') => ({
  action_invocation_id: '00000000-0000-4000-8000-0000000000a1',
  mode,
  policy_version_id: '00000000-0000-4000-8000-0000000000f1',
  set_at: new Date('2026-11-19T11:00:00Z'),
  set_by_principal_id: '77777777-7777-4777-8777-777777777777',
  tenant_id: tenantId,
  version_number: 1,
});

describe('The language policy Read through the Core Read runtime', () => {
  const principal = principalOf(tenantOne);
  const scope = { ...principal, correlationId: 'language-policy-read' };
  const makeReadHarness = (access: 'allowed' | 'denied', rows: readonly object[]) =>
    makeReadTestHarness({
      access,
      executeOwnerQuery: (query) =>
        Effect.sync(() => {
          expect(query.sql).toContain('"communications"."tenant_language_mode_versions"');
          // only the principal's own Tenant is ever asked for
          expect(query.params).toContain(tenantOne);
          expect(query.params).not.toContain(tenantTwo);
          return rows;
        }),
      operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-19T12:00:00Z')),
      ownerAuthorizationDecision: 'allowed',
      ownerRegistration: communicationsRegistration,
      scope,
    });
  const readOnce = (access: 'allowed' | 'denied', rows: readonly object[]) =>
    Effect.gen(function* readPolicy() {
      const harness = yield* makeReadHarness(access, rows);
      const result = yield* harness.runtime.runRead({
        input: {},
        principal,
        registration: languagePolicyRead,
        transport: { correlationId: 'language-policy-read' },
      });
      return { harness, result };
    });

  it.effect('[AC-11] answers B from the platform default when the Tenant has no own choice', () =>
    Effect.scoped(
      Effect.gen(function* defaultRead() {
        const { result } = yield* readOnce('allowed', []);
        expect(result).toEqual({ mode: 'B', policy: { platformDefaultVersion: 1, source: 'platform-default' } });
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[AC-11] answers the own latest choice with its safe version reference', () =>
    Effect.scoped(
      Effect.gen(function* ownRead() {
        const { result } = yield* readOnce('allowed', [versionRow(tenantOne, 'A')]);
        expect(result).toEqual({
          mode: 'A',
          policy: { policyVersionId: '00000000-0000-4000-8000-0000000000f1', source: 'tenant', versionNumber: 1 },
        });
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[S09 AC-11] a caller that selects a Legal Entity is refused: the mode is read in the Tenant context', () =>
    Effect.scoped(
      Effect.gen(function* companyRead() {
        const harness = yield* makeReadHarness('allowed', [versionRow(tenantOne, 'A')]);
        const failure = yield* Effect.flip(
          harness.runtime.runRead({
            input: {},
            principal: { ...principal, legalEntityId: '33333333-3333-4333-8333-333333333333' },
            registration: languagePolicyRead,
            transport: { correlationId: 'language-policy-read-company' },
          }),
        );
        expect(Schema.is(OperationContextInvalid)(failure)).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[S09 AC-11] an unauthorized caller is denied before any Tenant data is read', () =>
    Effect.scoped(
      Effect.gen(function* deniedRead() {
        const harness = yield* makeReadHarness('denied', [versionRow(tenantOne, 'A')]);
        const failure = yield* Effect.flip(
          harness.runtime.runRead({
            input: {},
            principal,
            registration: languagePolicyRead,
            transport: { correlationId: 'language-policy-read-denied' },
          }),
        );
        expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
