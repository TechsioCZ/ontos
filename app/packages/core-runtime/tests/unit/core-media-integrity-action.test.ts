import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { AccessPrincipalKind, AccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import type { AccessWorkloadBindings } from '../../src/access/enforcement/workload-port.ts';
import { coreActionCatalog, recordAssetIntegrityFailureAction } from '../../src/index.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { at, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';

/*
 * The one Action that may close a ready asset as failed: its identity, its single run-only declaration, the
 * workload carrier beside it, and what the real access seam does with each carrier. Proving the corruption
 * itself is the verified read's job; recording it is this Action's, and only for a bound machine or a granted person.
 */

const { descriptor } = recordAssetIntegrityFailureAction;
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

it('registers one protected, idempotent, Core Media write entrypoint that records no business event', () => {
  expect(descriptor.actionKey).toBe('core.media.record-asset-integrity-failure');
  expect(coreActionCatalog.filter(({ actionKey }) => actionKey === descriptor.actionKey)).toHaveLength(1);
  expect(descriptor.entrypoint).toMatchObject({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: descriptor.actionKey,
    moduleKey: 'core.media',
    role: 'action',
  });
  expect(descriptor.idempotency).toBe('required');
  expect(descriptor.domainEvents).toEqual({});
  expect(descriptor.policies).toEqual([]);
  expect(descriptor.accessEvidencePolicy.captureMode).toBe('metadata_only');
});

it('carries no proof in its payload, so no caller can state that an asset is corrupt', () => {
  expect(Object.keys(descriptor.payloadSchema.fields)).toEqual(['mediaAssetRef']);
});

it('declares its own run-only capability and a workload key that is not the ingest one', () => {
  expect(descriptor.accessDeclaration).toMatchObject({
    key: 'core.media.asset-integrity.fail',
    kind: 'action',
    modes: ['run'],
    selectors: [],
  });
  expect(descriptor.accessWorkload?.workloads).toEqual(['core.media.integrity']);
});

const scopeFor = (principalId: string, authMethod: 'api_key' | 'session'): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: uid(70),
    authContextRef: `core-media-integrity-${authMethod}`,
    authMethod,
    principalId,
    tenantId: tenant,
  }),
  correlationId: 'core-media-integrity',
});

const gateFor = (options: {
  readonly capability?: string;
  readonly kind: AccessPrincipalKind;
  readonly workloadKeys?: readonly string[];
}) => {
  const spec = { cells: options.capability === undefined ? [] : [cell({ capability: options.capability })] };
  const kinds: AccessPrincipalKinds = { readKind: () => Effect.succeed(Option.some(options.kind)) };
  const workloadBindings: AccessWorkloadBindings = {
    readWorkloadAuthority: () =>
      Effect.succeed({ activeCompanyIds: new Set(), workloadKeys: new Set(options.workloadKeys) }),
  };
  return makeAccessDecisionService({
    authorityFor: () => makeAuthority(spec).port,
    check: makeCheck({ authority: spec }).port,
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([]) },
    principalKinds: kinds,
    privacyDispatchLiveness: { read: () => Effect.succeed(false) },
    workloadBindings,
  });
};

const inputFor = (scope: OperationalScope): GateInput => ({
  carrier: descriptor,
  legalEntityScope: descriptor.legalEntityScope,
  now: at('2026-11-20T12:00:00Z'),
  scope,
});

it.effect('admits a machine only through the core.media.integrity binding, never the ingest binding or its kind', () =>
  Effect.gen(function* machines() {
    for (const kind of ['integration', 'service', 'system'] as const) {
      const scope = scopeFor(uid(80), 'api_key');
      const bound = yield* gateFor({ kind, workloadKeys: ['core.media.integrity'] }).decide(inputFor(scope));
      expect(bound.outcome).toBe('ALLOWED');
      for (const workloadKeys of [[], ['core.media.ingest']]) {
        const refused = yield* gateFor({ kind, workloadKeys }).decide(inputFor(scope));
        expect(refused.outcome).toBe('DENIED');
      }
    }
  }),
);

it.effect('admits a human only with the integrity capability, and not with the upload or confirm capability', () =>
  Effect.gen(function* human() {
    const scope = scopeFor(person, 'session');
    const granted = yield* gateFor({ capability: 'core.media.asset-integrity.fail', kind: 'human' }).decide(
      inputFor(scope),
    );
    expect(granted.outcome).toBe('ALLOWED');
    for (const capability of [undefined, 'core.media.asset.upload', 'core.media.asset.confirm']) {
      const refused = yield* gateFor(
        capability === undefined ? { kind: 'human' } : { capability, kind: 'human' },
      ).decide(inputFor(scope));
      expect(refused.outcome).toBe('DENIED');
    }
  }),
);
