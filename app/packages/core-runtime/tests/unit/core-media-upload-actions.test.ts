import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { AccessPrincipalKind, AccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import type { AccessDecisionLogEntry } from '../../src/access/enforcement/decision-log.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import type { AccessWorkloadBindings } from '../../src/access/enforcement/workload-port.ts';
import { collectAccessCatalog } from '../../src/authorization/access-declaration.ts';
import { confirmAssetAction, coreActionCatalog, uploadAssetAction } from '../../src/index.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { at, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';

/*
 * The two short Actions of the reserve, stream, confirm shape, as registered: their identity, their one access
 * declaration each, the machine-workload carrier beside it, and what the real access seam does with each carrier
 * for each principal kind. The SpiceDB-backed matrix is d20-08's; here the engine is the scripted decision port.
 */

const registrations = [uploadAssetAction, confirmAssetAction] as const;
const now = at('2026-11-19T12:00:00Z');
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

it('registers exactly the reserve and the confirm Action as protected, idempotent Core Media entrypoints', () => {
  expect(registrations.map(({ descriptor }) => descriptor.actionKey)).toEqual([
    'core.media.upload-asset',
    'core.media.confirm-asset',
  ]);
  for (const { descriptor } of registrations) {
    expect(descriptor.owningModuleKey).toBe('core.media');
    expect(descriptor.entrypoint).toMatchObject({
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey: 'core.media',
      role: 'action',
    });
    expect(descriptor.entrypoint.entrypointKey).toBe(descriptor.actionKey);
    expect(descriptor.idempotency).toBe('required');
    expect(descriptor.legalEntityScope).toBe('optional');
    expect(descriptor.policies).toEqual([]);
    // No business event, no outbox message: upload creates no link, assignment or downstream effect.
    expect(descriptor.domainEvents).toEqual({});
    // Evidence never captures bytes, a digest payload or a name.
    expect(descriptor.accessEvidencePolicy.captureMode).toBe('metadata_only');
    expect(Object.isFrozen(descriptor)).toBe(true);
  }
});

it('is in the Core Action catalog exactly once each', () => {
  for (const { descriptor } of registrations) {
    expect(coreActionCatalog.filter(({ actionKey }) => actionKey === descriptor.actionKey)).toHaveLength(1);
  }
});

it('declares one distinct, routine, run-only, scope-wide capability per Action', () => {
  const [upload, confirm] = registrations;
  expect(upload.descriptor.accessDeclaration).toMatchObject({
    key: 'core.media.asset.upload',
    kind: 'action',
    modes: ['run'],
    risk: 'routine',
    selectors: [],
  });
  expect(confirm.descriptor.accessDeclaration).toMatchObject({
    key: 'core.media.asset.confirm',
    kind: 'action',
    modes: ['run'],
    risk: 'routine',
    selectors: [],
  });
  const keys = registrations.map(({ descriptor }) => descriptor.accessDeclaration?.key);
  expect(new Set(keys).size).toBe(keys.length);
  // `propose` is excluded on purpose: a parked proposal keeps no request body stream to stream from.
  for (const { descriptor } of registrations) {
    expect(descriptor.accessDeclaration?.modes).not.toContain('propose');
  }
});

it('has no duplicate declaration key anywhere in the release catalog once Core Media is added', () => {
  const entries = registrations.flatMap(({ descriptor }) =>
    descriptor.accessDeclaration === undefined
      ? []
      : [{ accessDeclaration: descriptor.accessDeclaration, entrypoint: descriptor.entrypoint }],
  );
  const catalog = Result.getOrThrow(collectAccessCatalog([{ descriptors: entries, moduleId: 'core.media' }]));
  expect(catalog.entries.map(({ accessDeclaration }) => accessDeclaration.key)).toEqual([
    'core.media.asset.confirm',
    'core.media.asset.upload',
  ]);
});

it('pairs every declaration with a workload carrier naming one core.media workload key', () => {
  for (const { descriptor } of registrations) {
    expect(descriptor.accessWorkload).toBeDefined();
    expect(descriptor.accessWorkload?.workloads).toEqual(['core.media.ingest']);
    for (const workload of descriptor.accessWorkload?.workloads ?? []) {
      expect(workload.startsWith('core.media.')).toBe(true);
    }
  }
});

/** The scope of a principal of a given id; the principal kind is read from the identity rows, never from this. */
const scopeFor = (principalId: string, authMethod: 'api_key' | 'session'): OperationalScope => {
  const trusted = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: uid(70),
    authContextRef: `core-media-${authMethod}`,
    authMethod,
    principalId,
    tenantId: tenant,
  });
  return { ...trusted, correlationId: 'core-media-carriers' };
};

const harness = (options: {
  readonly capability?: string;
  readonly kind: AccessPrincipalKind;
  readonly workloadKeys?: readonly string[];
}) => {
  const authoritySpec = { cells: options.capability === undefined ? [] : [cell({ capability: options.capability })] };
  const authority = makeAuthority(authoritySpec);
  const check = makeCheck({ authority: authoritySpec });
  const entries: AccessDecisionLogEntry[] = [];
  const kinds: AccessPrincipalKinds = { readKind: () => Effect.succeed(Option.some(options.kind)) };
  const workloadBindings: AccessWorkloadBindings = {
    readActiveWorkloadKeys: () => Effect.succeed(new Set(options.workloadKeys)),
  };
  const gate = makeAccessDecisionService({
    authorityFor: () => authority.port,
    check: check.port,
    decisionLog: {
      record: (entry) => {
        entries.push(entry);
        return Effect.void;
      },
    },
    legalEntities: { listCandidateIds: () => Effect.succeed([]) },
    principalKinds: kinds,
    privacyDispatchLiveness: { read: () => Effect.succeed(false) },
    workloadBindings,
  });
  return { entries, gate };
};

/** The question the Action runtime asks: the registration's own decoded carriers, in the trusted scope. */
const gateInputOf = (registration: (typeof registrations)[number], scope: OperationalScope): GateInput => ({
  carrier: registration.descriptor,
  legalEntityScope: registration.descriptor.legalEntityScope,
  now,
  scope,
});

const reasonsOf = (decision: { readonly reasons: readonly { readonly code: string }[] }) =>
  decision.reasons.map(({ code }) => code);

it.effect('admits a human with the Action capability through the declaration and never without it', () =>
  Effect.gen(function* human() {
    for (const registration of registrations) {
      const key = registration.descriptor.accessDeclaration?.key ?? '';
      const granted = harness({ capability: key, kind: 'human' });
      const allowed = yield* granted.gate.decide(gateInputOf(registration, scopeFor(person, 'session')));
      expect(reasonsOf(allowed)).toEqual(['allow.granted']);
      expect(allowed.outcome).toBe('ALLOWED');
      const ungranted = harness({ kind: 'human' });
      const denied = yield* ungranted.gate.decide(gateInputOf(registration, scopeFor(person, 'session')));
      expect(denied.outcome).toBe('DENIED');
    }
  }),
);

it.effect('does not let the other Action capability stand in: upload alone never confirms, nor the reverse', () =>
  Effect.gen(function* distinct() {
    const [upload, confirm] = registrations;
    const uploadOnly = harness({ capability: 'core.media.asset.upload', kind: 'human' });
    const confirmDecision = yield* uploadOnly.gate.decide(gateInputOf(confirm, scopeFor(person, 'session')));
    expect(confirmDecision.outcome).toBe('DENIED');
    const confirmOnly = harness({ capability: 'core.media.asset.confirm', kind: 'human' });
    const uploadDecision = yield* confirmOnly.gate.decide(gateInputOf(upload, scopeFor(person, 'session')));
    expect(uploadDecision.outcome).toBe('DENIED');
  }),
);

it.effect('admits a machine principal only through its bound core.media workload and never from its kind alone', () =>
  Effect.gen(function* machines() {
    const machine = uid(80);
    for (const registration of registrations) {
      for (const kind of ['integration', 'service', 'system'] as const) {
        const bound = harness({ kind, workloadKeys: ['core.media.ingest'] });
        const admitted = yield* bound.gate.decide(gateInputOf(registration, scopeFor(machine, 'api_key')));
        expect(admitted.outcome).toBe('ALLOWED');
        expect(reasonsOf(admitted)).toEqual(['allow.workload']);
        // The same principal with no active binding: its kind and its origin label grant nothing.
        const unbound = harness({ kind });
        const refused = yield* unbound.gate.decide(gateInputOf(registration, scopeFor(machine, 'api_key')));
        expect(refused.outcome).toBe('DENIED');
        expect(reasonsOf(refused)).toEqual(['deny.workload_unbound']);
        // A binding for another workload is not this one.
        const foreign = harness({ kind, workloadKeys: ['core.media.other'] });
        const foreignDecision = yield* foreign.gate.decide(gateInputOf(registration, scopeFor(machine, 'api_key')));
        expect(reasonsOf(foreignDecision)).toEqual(['deny.workload_unbound']);
      }
    }
  }),
);

it.effect('decides by the principal kind in the identity rows, never by the authentication method', () =>
  Effect.gen(function* byKind() {
    // A human on an API-key method, and a machine on a session method, each follow their own kind.
    const [upload] = registrations;
    const humanOnApiKeyMethod = harness({ capability: 'core.media.asset.upload', kind: 'human' });
    expect((yield* humanOnApiKeyMethod.gate.decide(gateInputOf(upload, scopeFor(person, 'api_key')))).outcome).toBe(
      'ALLOWED',
    );
    const machineOnSessionMethod = harness({ kind: 'system', workloadKeys: ['core.media.ingest'] });
    expect((yield* machineOnSessionMethod.gate.decide(gateInputOf(upload, scopeFor(uid(81), 'session')))).outcome).toBe(
      'ALLOWED',
    );
    // A human never rides the workload carrier even when a binding for the key exists in its scope.
    const humanWithBinding = harness({ kind: 'human', workloadKeys: ['core.media.ingest'] });
    const humanDecision = yield* humanWithBinding.gate.decide(gateInputOf(upload, scopeFor(person, 'session')));
    expect(humanDecision.outcome).toBe('DENIED');
  }),
);

it.effect('is unavailable, not allowed, when the workload registry cannot be read', () =>
  Effect.gen(function* registryDown() {
    const [upload] = registrations;
    const authority = makeAuthority({ cells: [] });
    const gate = makeAccessDecisionService({
      authorityFor: () => authority.port,
      check: makeCheck({ authority: { cells: [] } }).port,
      decisionLog: { record: () => Effect.void },
      legalEntities: { listCandidateIds: () => Effect.succeed([]) },
      principalKinds: { readKind: () => Effect.succeed(Option.some('system' as const)) },
      privacyDispatchLiveness: { read: () => Effect.succeed(false) },
      workloadBindings: { readActiveWorkloadKeys: () => Effect.fail(accessDecisionUnavailable('registry down')) },
    });
    const decision = yield* gate.decide(gateInputOf(upload, scopeFor(uid(82), 'api_key')));
    expect(decision.outcome).toBe('UNAVAILABLE');
  }),
);
