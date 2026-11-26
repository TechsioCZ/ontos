import { NodeServices } from '@effect/platform-node';
import { Context, Effect, FileSystem, Layer, Option, Path, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { makeAccessDecisionService as makeAccessDecisionServiceType } from '../../src/access/enforcement/service.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type {
  preserveSystemPrincipalContextTrust as preserveSystemPrincipalContextTrustType,
  trustVerifiedGatewayPrincipalContext as trustVerifiedGatewayPrincipalContextType,
} from '../../src/auth/system-principal-context-provenance.ts';
import { decodeAccessActor } from '../../src/authorization/access-declaration.ts';
import type { isGenuineCoreOperation as isGenuineCoreOperationType } from '../../src/modules/module-operation-execution.ts';
import type { assetCurrentRead as assetCurrentReadType } from '../../src/generated-reads/asset-current.ts';
import type { assetMetadataRead as assetMetadataReadType } from '../../src/generated-reads/asset-metadata.ts';
import type {
  materializeAccessQuestions as materializeAccessQuestionsType,
  readFieldGroupActor as readFieldGroupActorType,
} from '../../src/reads/access-questions.ts';
import type {
  defineRead as defineReadType,
  isReadRegistration as isReadRegistrationType,
} from '../../src/reads/definition.ts';
import type {
  captureCoreReadReceiverBindings as captureCoreReadReceiverBindingsType,
  makeCoreReadReceiverBindings as makeCoreReadReceiverBindingsType,
  resolveCoreReadAccessQuestions as resolveCoreReadAccessQuestionsType,
  resolveCoreReadReceiverActor as resolveCoreReadReceiverActorType,
} from '../../src/reads/receiver-bindings.ts';
import { canRun, canSeeFields } from '../../src/sdk/read.ts';
import { at, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';

const hostedActor = {
  callerBinding: 'receiving-host',
  callers: [],
  reason: 'The receiving host binds modules relaying the requester',
  subject: 'rights',
} as const;
const FIELD_KEY = 'core.media.asset-current.details';
// Build an independent source tree with a test registration in the real Core registry's import slot.
// Everything that recognizes, binds, or runs access checks against the registration is production code.
const fixtureExports = `
  export { assetCurrentRead as hostedRead } from './src/generated-reads/asset-current.ts';
  export { assetMetadataRead } from './src/generated-reads/asset-metadata.ts';
  export { makeAccessDecisionService } from './src/access/enforcement/service.ts';
  export { preserveSystemPrincipalContextTrust, trustVerifiedGatewayPrincipalContext }
    from './src/auth/system-principal-context-provenance.ts';
  export { isGenuineCoreOperation } from './src/modules/module-operation-execution.ts';
  export { materializeAccessQuestions, readFieldGroupActor } from './src/reads/access-questions.ts';
  export { defineRead, isReadRegistration } from './src/reads/definition.ts';
  export { captureCoreReadReceiverBindings, makeCoreReadReceiverBindings, resolveCoreReadAccessQuestions,
    resolveCoreReadReceiverActor } from './src/reads/receiver-bindings.ts';
`;
const fixtureRegistration = `
  import { Effect, Schema } from 'effect';
  import { defineRead } from '../reads/definition.ts';
  import { assetCurrentRead as original } from './original-asset-current.ts';
  export { AssetCurrentRequestSchema, AssetCurrentResponseSchema } from './original-asset-current.ts';

  export const assetCurrentRead = defineRead({
    ...original.descriptor,
    accessActor: ${JSON.stringify(hostedActor)},
    accessFieldGroups: [{
      fieldClass: 'authority_metadata',
      fields: ['details'],
      key: ${JSON.stringify(FIELD_KEY)},
      kind: 'field_read',
      modes: ['run'],
      placement: { group: 'media', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    }],
    resultSchema: Schema.Struct({ ...original.descriptor.resultSchema.fields, details: Schema.optionalKey(Schema.String) }),
  }, () => Effect.succeed({ evidence: { resultCount: 0 }, result: { entries: [] } }), () => Effect.succeed({}));
`;
interface FixtureCore {
  readonly assetMetadataRead: typeof assetMetadataReadType;
  readonly captureCoreReadReceiverBindings: typeof captureCoreReadReceiverBindingsType;
  readonly defineRead: typeof defineReadType;
  readonly hostedRead: typeof assetCurrentReadType;
  readonly isGenuineCoreOperation: typeof isGenuineCoreOperationType;
  readonly isReadRegistration: typeof isReadRegistrationType;
  readonly makeAccessDecisionService: typeof makeAccessDecisionServiceType;
  readonly makeCoreReadReceiverBindings: typeof makeCoreReadReceiverBindingsType;
  readonly materializeAccessQuestions: typeof materializeAccessQuestionsType;
  readonly preserveSystemPrincipalContextTrust: typeof preserveSystemPrincipalContextTrustType;
  readonly readFieldGroupActor: typeof readFieldGroupActorType;
  readonly resolveCoreReadAccessQuestions: typeof resolveCoreReadAccessQuestionsType;
  readonly resolveCoreReadReceiverActor: typeof resolveCoreReadReceiverActorType;
  readonly trustVerifiedGatewayPrincipalContext: typeof trustVerifiedGatewayPrincipalContextType;
}
class ReceiverFixtureCore extends Context.Service<ReceiverFixtureCore, FixtureCore>()(
  '@app/core-runtime/tests/unit/core-read-receiver-bindings.test/ReceiverFixtureCore',
) {}

const receiverFixtureLive = Layer.effect(
  ReceiverFixtureCore,
  Effect.gen(function* setUpReceiverFixture() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageRoot = yield* path.fromFileUrl(new URL('../../', import.meta.url));
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-receiver-binding-' });
    const entrypoint = path.join(root, 'core.mts');
    yield* Effect.all([
      fs.copy(path.join(packageRoot, 'src'), path.join(root, 'src')),
      fs.copyFile(path.join(packageRoot, 'package.json'), path.join(root, 'package.json')),
      fs.symlink(path.join(packageRoot, 'node_modules'), path.join(root, 'node_modules')),
      fs.writeFileString(entrypoint, fixtureExports),
    ]);
    const reads = path.join(root, 'src', 'generated-reads');
    yield* fs.rename(path.join(reads, 'asset-current.ts'), path.join(reads, 'original-asset-current.ts'));
    yield* fs.writeFileString(path.join(reads, 'asset-current.ts'), fixtureRegistration);
    const url = yield* path.toFileUrl(entrypoint);
    // The entry point re-exports unmodified production modules, with the test read as the sole substitution.
    return yield* Effect.promise((): Promise<FixtureCore> => import(url.href));
  }),
).pipe(Layer.provide(NodeServices.layer));

const runFixture = () => Effect.succeed({ evidence: { resultCount: 0 }, result: { entries: [] } });
const prepareFixture = () => Effect.succeed({});
const makeStaticRead = ({ defineRead: read, hostedRead }: FixtureCore) =>
  read(
    { ...hostedRead.descriptor, accessActor: { callers: ['catalog'], reason: hostedActor.reason, subject: 'rights' } },
    runFixture,
    prepareFixture,
  );

const bindHostedRead = (fixture: FixtureCore, callers: readonly [string, ...string[]]) => {
  const { captureCoreReadReceiverBindings: capture, hostedRead, makeCoreReadReceiverBindings: make } = fixture;
  return capture(make([{ callers, registration: hostedRead }]));
};

const delegatedScope = (fixture: FixtureCore, appId: string) => {
  const { preserveSystemPrincipalContextTrust, trustVerifiedGatewayPrincipalContext } = fixture;
  const principal = trustVerifiedGatewayPrincipalContext(
    Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: person,
      authContextRef: 'receiver-binding-test',
      authMethod: 'session',
      principalId: person,
      tenantId: tenant,
    }),
    'a'.repeat(64),
    undefined,
    { appId, buildMarker: 'approved-build', principalId: person },
  );
  return preserveSystemPrincipalContextTrust(principal, { ...principal, correlationId: 'receiver-test' });
};

it.layer(receiverFixtureLive)('Core Read receiver bindings', (suite) => {
  suite.effect(
    'decodes a distinct host-bound rights actor without accepting ordinary empty callers or workload subjects',
    () =>
      Effect.gen(function* decodeActor() {
        const fixture = yield* ReceiverFixtureCore;
        const { hostedRead } = fixture;
        const owner = hostedRead.descriptor.entrypoint;
        const decoded = Result.getOrThrow(decodeAccessActor(hostedActor, owner));
        expect(decoded).toEqual(hostedActor);
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.callers)).toBe(true);
        const { callerBinding: _binding, ...ordinary } = hostedActor;
        expect(Result.isFailure(decodeAccessActor(ordinary, owner))).toBe(true);
        for (const invalid of [
          { ...hostedActor, callers: ['catalog'] },
          { ...hostedActor, subject: 'identity' },
          { ...hostedActor, subject: 'workload' },
          { ...hostedActor, subjectWorkloads: ['demo.import'] },
          { ...hostedActor, subjectWorkloadCallers: ['catalog'] },
        ]) {
          expect(Result.isFailure(decodeAccessActor(invalid, owner))).toBe(true);
        }
        expect(Result.isFailure(decodeAccessActor(hostedActor, { ...owner, role: 'action' }))).toBe(true);
      }),
  );

  suite.effect('rejects foreign, static and forged registrations and captures only a minted registry', () =>
    Effect.gen(function* rejectForgedRead() {
      const fixture = yield* ReceiverFixtureCore;
      const {
        assetMetadataRead,
        captureCoreReadReceiverBindings,
        defineRead,
        hostedRead,
        isGenuineCoreOperation,
        isReadRegistration,
        makeCoreReadReceiverBindings,
        resolveCoreReadReceiverActor,
      } = fixture;
      const binding = { callers: ['catalog'], registration: hostedRead } as const;
      expect(isReadRegistration(hostedRead)).toBe(true);
      expect(isGenuineCoreOperation(hostedRead)).toBe(true);
      const foreignRead = defineRead(hostedRead.descriptor, runFixture, prepareFixture);
      expect(() => makeCoreReadReceiverBindings([{ ...binding, registration: foreignRead }])).toThrow(
        'original Core read',
      );
      const staticBinding = { ...binding, registration: assetMetadataRead };
      const otherVersion = defineRead({ ...hostedRead.descriptor, schemaVersion: '2' }, runFixture, prepareFixture);
      expect(() => makeCoreReadReceiverBindings([{ ...binding, registration: otherVersion }])).toThrow(
        'original Core read',
      );
      expect(resolveCoreReadReceiverActor(otherVersion, bindHostedRead(fixture, ['catalog']))?.callers).toEqual([]);
      expect(() => makeCoreReadReceiverBindings([staticBinding])).toThrow('host-bound');
      expect(() => makeCoreReadReceiverBindings([{ ...binding, registration: new Proxy(hostedRead, {}) }])).toThrow(
        'original Core read',
      );
      for (const callers of [['Catalog'], ['catalog', 'catalog']] as const) {
        expect(() => makeCoreReadReceiverBindings([{ ...binding, callers }])).toThrow('accessActor');
      }
      const bindings = makeCoreReadReceiverBindings([]);
      expect(captureCoreReadReceiverBindings(bindings)).toBe(bindings);
      expect(bindings.actorFor(hostedRead)).toBeUndefined();
      expect(() => captureCoreReadReceiverBindings({ actorFor: () => {} })).toThrow('genuine');
      expect(() => captureCoreReadReceiverBindings(new Proxy(bindings, {}))).toThrow('genuine');
      expect(() => captureCoreReadReceiverBindings(Object.create(Object.getPrototypeOf(bindings)))).toThrow('genuine');
      expect(() => Reflect.construct(bindings.constructor, [new Map(), Symbol('forged')])).toThrow('host API');
    }),
  );

  suite.effect('reads each binding registration once and rejects duplicate hosted bindings', () =>
    Effect.gen(function* captureRegistrationOnce() {
      const fixture = yield* ReceiverFixtureCore;
      const { hostedRead, makeCoreReadReceiverBindings } = fixture;
      let registrationReads = 0;
      const first = {
        callers: ['catalog'],
        get registration() {
          registrationReads += 1;
          return hostedRead;
        },
      } as const;
      const bindings = makeCoreReadReceiverBindings([first]);
      expect(bindings.actorFor(hostedRead)?.callers).toEqual(['catalog']);
      expect(registrationReads).toBe(1);
      expect(() => makeCoreReadReceiverBindings([first, { callers: ['pricing'], registration: hostedRead }])).toThrow(
        'only one receiver binding',
      );
    }),
  );

  suite.effect(
    'resolves the exact host-bound registration without changing static actors or retaining mutable callers',
    () =>
      Effect.gen(function* resolveExactRead() {
        const fixture = yield* ReceiverFixtureCore;
        const { assetMetadataRead, hostedRead, readFieldGroupActor, resolveCoreReadReceiverActor } = fixture;
        const staticRead = makeStaticRead(fixture);
        const original = hostedRead.descriptor.accessActor;
        const callers: [string, ...string[]] = ['catalog'];
        const bindings = bindHostedRead(fixture, callers);
        callers[0] = 'pricing';
        const resolved = resolveCoreReadReceiverActor(hostedRead, bindings);
        expect(resolved?.callers).toEqual(['catalog']);
        expect(resolved?.subject).toBe('rights');
        expect(Object.isFrozen(resolved)).toBe(true);
        expect(hostedRead.descriptor.accessActor).toBe(original);
        expect(original?.callers).toEqual([]);
        expect(resolveCoreReadReceiverActor(new Proxy(hostedRead, {}), bindings)).toBe(original);
        expect(resolveCoreReadReceiverActor(staticRead, bindings)).toBe(staticRead.descriptor.accessActor);
        expect(resolveCoreReadReceiverActor(assetMetadataRead, bindings)).toBeUndefined();
        expect(readFieldGroupActor(original)).toBe(original);
        expect(readFieldGroupActor(resolved)).toEqual(resolved);
      }),
  );

  suite.effect('hard-denies unbound and foreign callers and still requires the requester Current right', () =>
    Effect.gen(function* receiverAuthority() {
      const fixture = yield* ReceiverFixtureCore;
      const { hostedRead, makeAccessDecisionService, resolveCoreReadReceiverActor } = fixture;
      const bindings = bindHostedRead(fixture, ['catalog']);
      const { key: capability } = Option.getOrThrow(Option.fromUndefinedOr(hostedRead.descriptor.accessDeclaration));
      const allowed = { cells: [cell({ capability })] };
      const authority = makeAuthority(allowed);
      const check = makeCheck({ authority: allowed });
      const deniedAuthority = makeAuthority({ cells: [] });
      const decision = (appId: string, bound: boolean, holdsRight: boolean, kind: 'human' | 'system' = 'human') => {
        const scope = delegatedScope(fixture, appId);
        const gate = makeAccessDecisionService({
          authorityFor: () => (holdsRight ? authority.port : deniedAuthority.port),
          check: check.port,
          decisionLog: { record: () => Effect.void },
          legalEntities: { listCandidateIds: () => Effect.succeed([]) },
          principalKinds: { readKind: () => Effect.succeed(Option.some(kind)) },
        });
        return gate.decide({
          carrier: {
            ...hostedRead.descriptor,
            accessActor: resolveCoreReadReceiverActor(hostedRead, bound ? bindings : undefined),
          },
          legalEntityScope: 'optional',
          now: at('2026-11-25T10:00:00Z'),
          scope,
        });
      };
      for (const [appId, bound] of [
        ['catalog', false],
        ['pricing', true],
      ] as const) {
        const refused = yield* decision(appId, bound, true);
        expect(refused.outcome).toBe('DENIED');
        expect(refused.reasons.map(({ code }) => code)).toContain('deny.actor_unbound');
      }
      expect(check.calls.checkBulk).toBe(0);
      expect((yield* decision('catalog', true, false)).outcome).toBe('DENIED');
      expect((yield* decision('catalog', true, true)).outcome).toBe('ALLOWED');
      const workload = yield* decision('catalog', true, true, 'system');
      expect(workload.outcome).toBe('DENIED');
      expect(workload.reasons.map(({ code }) => code)).toContain('deny.actor_subject_invalid');
    }),
  );

  suite.effect(
    'binds run and field questions by exact identity, preserving separate capabilities and denying lookalikes',
    () =>
      Effect.gen(function* bindAccessQuestions() {
        const fixture = yield* ReceiverFixtureCore;
        const { hostedRead, makeCoreReadReceiverBindings, materializeAccessQuestions, resolveCoreReadAccessQuestions } =
          fixture;
        const staticRead = makeStaticRead(fixture);
        const bindings = bindHostedRead(fixture, ['catalog']);
        const { descriptor } = hostedRead;
        const asking = {
          accessKind: descriptor.accessKind,
          carrier: descriptor,
          legalEntityScope: descriptor.legalEntityScope,
          moduleKey: descriptor.entrypoint.moduleKey,
        };
        const questions = materializeAccessQuestions(asking, {
          fields: canSeeFields(hostedRead, FIELD_KEY),
          forged: canRun(new Proxy(hostedRead, {})),
          lookalike: canRun({ descriptor }),
          run: canRun(hostedRead),
          staticLookalike: canRun(staticRead),
        });
        const first = Option.getOrThrow(Option.fromUndefinedOr(questions[0]));
        const copied = { ...first };
        expect(resolveCoreReadAccessQuestions([copied], bindings)[0]).toBe(copied);
        expect(() => Reflect.construct(first.constructor, [first, hostedRead, Symbol('forged')])).toThrow(
          'materialized by Core',
        );
        const unbound = resolveCoreReadAccessQuestions(questions, makeCoreReadReceiverBindings([]));
        expect(unbound).toEqual(questions);
        const resolved = resolveCoreReadAccessQuestions(questions, bindings);
        expect(Object.fromEntries(resolved.map(({ carrier, name }) => [name, carrier.accessActor?.callers]))).toEqual({
          fields: ['catalog'],
          forged: [],
          lookalike: [],
          run: ['catalog'],
          staticLookalike: ['catalog'],
        });
        expect(resolved.every(({ sameAsOwnDecision }) => !sameAsOwnDecision)).toBe(true);
        expect(resolved[0]).toMatchObject({
          carrier: { accessActor: { subject: 'rights' }, accessDeclaration: { key: FIELD_KEY } },
          kind: 'field',
          parentRead: { capability: { capabilityKey: 'core.media.asset-current.read' } },
        });
        expect(descriptor.accessActor?.callers).toEqual([]);
      }),
  );

  suite.effect('keeps an accessor-backed question on its first target registration', () =>
    Effect.gen(function* captureQuestionTargetOnce() {
      const fixture = yield* ReceiverFixtureCore;
      const { assetMetadataRead, hostedRead, materializeAccessQuestions, resolveCoreReadAccessQuestions } = fixture;
      const { descriptor } = hostedRead;
      const asking = {
        accessKind: descriptor.accessKind,
        carrier: descriptor,
        legalEntityScope: descriptor.legalEntityScope,
        moduleKey: descriptor.entrypoint.moduleKey,
      };
      let fieldTargetReads = 0;
      let runTargetReads = 0;
      const questions = materializeAccessQuestions(asking, {
        fields: {
          groupKey: FIELD_KEY,
          kind: 'can_see_fields',
          get target() {
            fieldTargetReads += 1;
            return fieldTargetReads === 1 ? hostedRead : assetMetadataRead;
          },
        },
        run: {
          kind: 'can_run',
          get target() {
            runTargetReads += 1;
            return runTargetReads === 1 ? hostedRead : assetMetadataRead;
          },
        },
      });
      const [field, run] = resolveCoreReadAccessQuestions(questions, bindHostedRead(fixture, ['catalog']));
      expect(fieldTargetReads).toBe(1);
      expect(runTargetReads).toBe(1);
      expect(field).toMatchObject({
        carrier: {
          accessActor: { callers: ['catalog'] },
          accessDeclaration: { key: FIELD_KEY },
          entrypoint: { entrypointKey: descriptor.entrypoint.entrypointKey },
        },
        parentRead: { capability: { capabilityKey: 'core.media.asset-current.read' } },
      });
      expect(run).toMatchObject({
        carrier: {
          accessActor: { callers: ['catalog'] },
          accessDeclaration: { key: 'core.media.asset-current.read' },
          entrypoint: { entrypointKey: descriptor.entrypoint.entrypointKey },
        },
      });
    }),
  );

  suite.effect('requires both the parent read and field right for a bound field question', () =>
    Effect.gen(function* receiverFieldRights() {
      const fixture = yield* ReceiverFixtureCore;
      const { hostedRead, makeAccessDecisionService, materializeAccessQuestions, resolveCoreReadAccessQuestions } =
        fixture;
      const { descriptor } = hostedRead;
      const questions = materializeAccessQuestions(
        {
          accessKind: descriptor.accessKind,
          carrier: descriptor,
          legalEntityScope: descriptor.legalEntityScope,
          moduleKey: descriptor.entrypoint.moduleKey,
        },
        { fields: canSeeFields(hostedRead, FIELD_KEY) },
      );
      const bound = resolveCoreReadAccessQuestions(questions, bindHostedRead(fixture, ['catalog']));
      const field = Option.getOrThrow(Option.fromUndefinedOr(bound[0]));
      const parentRead = Option.getOrThrow(Option.fromUndefinedOr(field.parentRead));
      const parentKey = Option.getOrThrow(Option.fromUndefinedOr(descriptor.accessDeclaration)).key;
      for (const [capabilities, expected] of [
        [[parentKey], 'DENIED'],
        [[FIELD_KEY], 'DENIED'],
        [[parentKey, FIELD_KEY], 'ALLOWED'],
      ] as const) {
        const granted = { cells: capabilities.map((capability) => cell({ capability })) };
        const gate = makeAccessDecisionService({
          authorityFor: () => makeAuthority(granted).port,
          check: makeCheck({ authority: granted }).port,
          decisionLog: { record: () => Effect.void },
          legalEntities: { listCandidateIds: () => Effect.succeed([]) },
          principalKinds: { readKind: () => Effect.succeed(Option.some('human')) },
        });
        const input = {
          carrier: field.carrier,
          legalEntityScope: field.legalEntityScope,
          now: at('2026-11-25T10:00:00Z'),
          scope: delegatedScope(fixture, 'catalog'),
        };
        expect((yield* gate.decide({ ...input, parentRead })).outcome).toBe(expected);
        expect(
          (yield* gate.decide({
            ...input,
            carrier: Option.getOrThrow(Option.fromUndefinedOr(questions[0])).carrier,
            parentRead,
          })).outcome,
        ).toBe('DENIED');
      }
    }),
  );
});
