import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  LegalEntityDetailRequestSchema,
  LegalEntityDetailResponseSchema,
  classifyLegalEntityDetail,
  legalEntityDetailRead,
} from '../../src/generated-reads/legal-entity-detail.ts';
import { ReadHandlerNotFound, ReadHandlerUnavailable } from '../../src/reads/errors.ts';

const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: '00000000-0000-4000-8000-000000000002',
  resourceType: 'core.identity.legal-entity',
  tenantId: '00000000-0000-4000-8000-000000000001',
};

it('publishes one tenant-qualified Legal Entity target with explicit lifecycle states', () => {
  const request = Schema.decodeUnknownSync(LegalEntityDetailRequestSchema)({ legalEntityRef });
  expect(request.legalEntityRef).toEqual(legalEntityRef);
  for (const status of ['active', 'suspended', 'archived']) {
    expect(
      Schema.decodeUnknownSync(LegalEntityDetailResponseSchema)({
        legalEntityRef,
        legalName: 'Example Manufacturing',
        status,
      }).status,
    ).toBe(status);
  }
  expect(() =>
    Schema.decodeUnknownSync(LegalEntityDetailRequestSchema)({
      legalEntityRef: { ...legalEntityRef, resourceType: 'party.registry.party' },
    }),
  ).toThrow();
  expect(legalEntityDetailRead.descriptor.permissionTarget).toBe('legal_entity');
  expect(legalEntityDetailRead.descriptor.legalEntityScope).toBe('optional');
});

it.effect(
  'distinguishes an authorized absent target, tenant mismatch, retired identity, and corrupt lifecycle',
  Effect.fn(function* classifyLegalEntityDetailCases() {
    const request = yield* Schema.decodeUnknownEffect(LegalEntityDetailRequestSchema)({ legalEntityRef });
    const absent = yield* Effect.flip(classifyLegalEntityDetail(request, legalEntityRef.tenantId, []));
    expect(Schema.is(ReadHandlerNotFound)(absent)).toBe(true);
    const crossTenant = yield* Effect.flip(
      classifyLegalEntityDetail(request, '00000000-0000-4000-8000-000000000099', [
        { legalName: 'Other', status: 'active' },
      ]),
    );
    expect(Schema.is(ReadHandlerNotFound)(crossTenant)).toBe(true);
    const retired = yield* classifyLegalEntityDetail(request, legalEntityRef.tenantId, [
      { legalName: 'Former Manufacturer', status: 'archived' },
    ]);
    expect(retired.status).toBe('archived');
    const corrupt = yield* Effect.flip(
      classifyLegalEntityDetail(request, legalEntityRef.tenantId, [{ legalName: 'Bad', status: 'unknown' }]),
    );
    expect(Schema.is(ReadHandlerUnavailable)(corrupt)).toBe(true);
  }),
);
