import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  activeTechnicalServicePrincipals,
  ServicePermissionComparisonError,
  compareNativeServicePermissions,
  serviceActionPermissionCases,
} from '../people-model-service-permissions.mts';
import type { SpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';

const tenantId = 'tenant';
const cases = serviceActionPermissionCases(
  [
    {
      actionKey: 'core.identity.reserve',
      legalEntityScope: 'forbidden',
      owningModuleKey: 'core.identity',
      provisioning: 'explicit',
    },
    {
      actionKey: 'party.registry.create',
      legalEntityScope: 'required',
      owningModuleKey: 'party.registry',
      provisioning: 'explicit',
    },
  ],
  tenantId,
  ['company-a', 'company-b', 'company-a'],
);
const at = (token: string) =>
  v1.Consistency.create({
    requirement: {
      atExactSnapshot: { token },
      oneofKind: 'atExactSnapshot',
    },
  });

it.effect('selects all six active SQL services, excluding human actors and inactive services', () =>
  Effect.gen(function* coverage() {
    const principals = Array.from({ length: 6 }, (_, index) => ({
      kind: 'service',
      principal_id: `service-${index}`,
      status: 'active',
      tenant_id: tenantId,
    }));
    const services = yield* activeTechnicalServicePrincipals({
      principals: [
        ...principals,
        { ...principals[0], kind: 'human', principal_id: 'human' },
        { ...principals[0], principal_id: 'inactive', status: 'inactive' },
      ],
    });
    expect(services.map((service) => service.principalId)).toEqual(
      principals.map((principal) => principal.principal_id),
    );
    expect(
      Schema.is(ServicePermissionComparisonError)(
        yield* activeTechnicalServicePrincipals({ principals: [principals[0], principals[0]] }).pipe(Effect.flip),
      ),
    ).toBe(true);
  }),
);

it('compares tenant Actions once and company Actions in every exact archived admission', () => {
  expect(cases).toHaveLength(3);
  expect(cases.map((item) => item.after.resource.objectId)).toHaveLength(
    new Set(cases.map((item) => item.after.resource.objectId)).size,
  );
  expect(cases[0]?.legalEntityId).toBeUndefined();
  expect(cases.slice(1).map((item) => item.legalEntityId)).toEqual(['company-a', 'company-b']);
  expect(cases[1]?.before).toEqual(cases[2]?.before);
  expect(cases[1]?.after).not.toEqual(cases[2]?.after);
});

it.effect('reports native losses and gains at the exact supplied revisions without any write port', () =>
  Effect.gen(function* compare() {
    const revisions: string[] = [];
    const rpc: Pick<SpiceDbRpc, 'checkBulkPermissions'> = {
      checkBulkPermissions: (request) =>
        Effect.sync(() => {
          const snapshot = request.consistency?.requirement;
          const before = snapshot?.oneofKind === 'atExactSnapshot' && snapshot.atExactSnapshot.token === 'before';
          revisions.push(before ? 'before' : 'after');
          return v1.CheckBulkPermissionsResponse.create({
            pairs: request.items.map((item, index) => ({
              request: item,
              response: {
                item: {
                  permissionship: (before ? index < 2 : index > 0)
                    ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                    : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
                },
                oneofKind: 'item',
              },
            })),
          });
        }),
    };
    const result = yield* compareNativeServicePermissions(rpc, cases, 'service', at('before'), at('after'));
    expect(revisions).toEqual(['before', 'after']);
    expect(result).toMatchObject({ checks: 6, newAllowed: 2, oldAllowed: 2 });
    expect(result.losses).toHaveLength(1);
    expect(result.gains).toHaveLength(1);
  }),
);

it.effect('refuses incomplete, mispaired, conditional and errored native responses rather than counting denials', () =>
  Effect.gen(function* invalid() {
    const invalidResponses = [
      v1.CheckBulkPermissionsResponse.create({}),
      v1.CheckBulkPermissionsResponse.create({
        pairs: [
          {
            request: {},
            response: {
              item: { permissionship: v1.CheckPermissionResponse_Permissionship.NO_PERMISSION },
              oneofKind: 'item',
            },
          },
        ],
      }),
      v1.CheckBulkPermissionsResponse.create({
        pairs: [
          {
            request: { ...cases[0]?.before, subject: { object: { objectId: 'service', objectType: 'principal' } } },
            response: {
              item: { permissionship: v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION },
              oneofKind: 'item',
            },
          },
        ],
      }),
      v1.CheckBulkPermissionsResponse.create({
        pairs: [
          {
            request: { ...cases[0]?.before, subject: { object: { objectId: 'service', objectType: 'principal' } } },
            response: { error: { code: 13, details: [], message: 'native failure' }, oneofKind: 'error' },
          },
        ],
      }),
    ];
    for (const response of invalidResponses) {
      const error = yield* compareNativeServicePermissions(
        { checkBulkPermissions: () => Effect.succeed(response) },
        cases.slice(0, 1),
        'service',
        at('before'),
        at('after'),
      ).pipe(Effect.flip);
      expect(Schema.is(ServicePermissionComparisonError)(error)).toBe(true);
    }
  }),
);

it.effect('requires pinned revisions and a nonempty comparison before calling the native port', () =>
  Effect.gen(function* pinned() {
    let calls = 0;
    const rpc: Pick<SpiceDbRpc, 'checkBulkPermissions'> = {
      checkBulkPermissions: () =>
        Effect.sync(() => {
          calls += 1;
          return v1.CheckBulkPermissionsResponse.create({});
        }),
    };
    for (const input of [
      {
        cases,
        consistency: v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } }),
      },
      { cases: [], consistency: at('before') },
    ]) {
      expect(
        Schema.is(ServicePermissionComparisonError)(
          yield* compareNativeServicePermissions(rpc, input.cases, 'service', input.consistency, at('after')).pipe(
            Effect.flip,
          ),
        ),
      ).toBe(true);
    }
    expect(calls).toBe(0);
  }),
);

it.effect('checks every case in bounded native batches on both revisions', () =>
  Effect.gen(function* batches() {
    const lengths: number[] = [];
    const rpc: Pick<SpiceDbRpc, 'checkBulkPermissions'> = {
      checkBulkPermissions: (request) =>
        Effect.sync(() => {
          lengths.push(request.items.length);
          return v1.CheckBulkPermissionsResponse.create({
            pairs: request.items.map((item) => ({
              request: item,
              response: {
                item: { permissionship: v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION },
                oneofKind: 'item',
              },
            })),
          });
        }),
    };
    const result = yield* compareNativeServicePermissions(
      rpc,
      Array.from({ length: 401 }, () => cases[0]),
      'service',
      at('before'),
      at('after'),
    );
    expect(lengths).toEqual([200, 200, 1, 200, 200, 1]);
    expect(result).toMatchObject({ checks: 802, gains: [], losses: [], newAllowed: 401, oldAllowed: 401 });
  }),
);
