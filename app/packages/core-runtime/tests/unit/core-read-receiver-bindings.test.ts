import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { decodeAccessActor } from '../../src/authorization/access-declaration.ts';
import { assetCurrentRead } from '../../src/generated-reads/asset-current.ts';
import { assetMetadataRead } from '../../src/generated-reads/asset-metadata.ts';
import { defineRead, isReadRegistration } from '../../src/reads/definition.ts';
import {
  captureCoreReadReceiverBindings,
  makeCoreReadReceiverBindings,
  resolveCoreReadReceiverActor,
} from '../../src/reads/receiver-bindings.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import {
  preserveSystemPrincipalContextTrust,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { at, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';

const hostedActor = {
  callerBinding: 'receiving-host',
  callers: [],
  reason: 'The receiving host binds modules relaying the requester',
  subject: 'rights',
} as const;

it('decodes a distinct host-bound rights actor without accepting ordinary empty callers', () => {
  const owner = assetCurrentRead.descriptor.entrypoint;
  const decoded = Result.getOrThrow(decodeAccessActor(hostedActor, owner));
  expect(decoded).toEqual(hostedActor);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.callers)).toBe(true);
  const { callerBinding: _binding, ...ordinary } = hostedActor;
  expect(Result.isFailure(decodeAccessActor(ordinary, owner))).toBe(true);
  for (const invalid of [
    { ...hostedActor, callers: ['catalog'] },
    { ...hostedActor, subject: 'identity' },
    { ...hostedActor, subjectWorkloads: ['demo.import'] },
  ]) {
    expect(Result.isFailure(decodeAccessActor(invalid, owner))).toBe(true);
  }
});

it('rejects duplicate bindings, non-hosted reads, forged registrations and malformed caller sets', () => {
  const binding = { callers: ['catalog'], registration: assetCurrentRead } as const;
  expect(() => makeCoreReadReceiverBindings([binding, binding])).toThrow('unique');
  expect(() => makeCoreReadReceiverBindings([{ ...binding, registration: assetMetadataRead }])).toThrow('host-bound');
  expect(() => makeCoreReadReceiverBindings([{ ...binding, registration: new Proxy(assetCurrentRead, {}) }])).toThrow(
    'original Core read',
  );
  const clone = defineRead(
    assetCurrentRead.descriptor,
    () => Effect.succeed({ evidence: { resultCount: 0 }, result: { entries: [] } }),
    () => Effect.succeed({}),
  );
  expect(isReadRegistration(clone)).toBe(true);
  expect(() => makeCoreReadReceiverBindings([{ ...binding, registration: clone }])).toThrow('original Core read');
  for (const callers of [['Catalog'], ['catalog', 'catalog']] as const) {
    expect(() => makeCoreReadReceiverBindings([{ ...binding, callers }])).toThrow();
  }
  const bindings = makeCoreReadReceiverBindings([binding]);
  expect(captureCoreReadReceiverBindings(bindings)).toBe(bindings);
  expect(() => captureCoreReadReceiverBindings(new Proxy(bindings, {}))).toThrow('genuine');
  expect(() => Reflect.construct(bindings.constructor, [new Map(), Symbol('forged')])).toThrow('host API');
});

it('captures callers without mutating registrations or allowing a lookalike registration', () => {
  const original = assetCurrentRead.descriptor.accessActor;
  const callers: [string, ...string[]] = ['catalog'];
  const bindings = makeCoreReadReceiverBindings([{ callers, registration: assetCurrentRead }]);
  callers[0] = 'pricing';
  const resolved = resolveCoreReadReceiverActor(assetCurrentRead, bindings);
  expect(resolved?.callers).toEqual(['catalog']);
  expect(resolved?.subject).toBe('rights');
  expect(Object.isFrozen(resolved)).toBe(true);
  expect(assetCurrentRead.descriptor.accessActor).toBe(original);
  expect(original?.callers).toEqual([]);
  expect(resolveCoreReadReceiverActor(new Proxy(assetCurrentRead, {}), bindings)).toBe(original);
  expect(resolveCoreReadReceiverActor(assetMetadataRead, bindings)).toBeUndefined();
});

it.effect('hard-denies unbound or non-Catalog delegated calls and still requires the requester Current right', () =>
  Effect.gen(function* receiverAuthority() {
    const bindings = makeCoreReadReceiverBindings([{ callers: ['catalog'], registration: assetCurrentRead }]);
    const { key: capability } = Option.getOrThrow(
      Option.fromUndefinedOr(assetCurrentRead.descriptor.accessDeclaration),
    );
    const allowed = { cells: [cell({ capability })] };
    const authority = makeAuthority(allowed);
    const check = makeCheck({ authority: allowed });
    const deniedAuthority = makeAuthority({ cells: [] });
    const decision = (appId: string, bound: boolean, holdsRight: boolean) => {
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
      const scope = preserveSystemPrincipalContextTrust(principal, { ...principal, correlationId: 'receiver-test' });
      const gate = makeAccessDecisionService({
        authorityFor: () => (holdsRight ? authority.port : deniedAuthority.port),
        check: check.port,
        decisionLog: { record: () => Effect.void },
        legalEntities: { listCandidateIds: () => Effect.succeed([]) },
        principalKinds: { readKind: () => Effect.succeed(Option.some('human')) },
      });
      return gate.decide({
        carrier: {
          ...assetCurrentRead.descriptor,
          accessActor: resolveCoreReadReceiverActor(assetCurrentRead, bound ? bindings : undefined),
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
  }),
);
