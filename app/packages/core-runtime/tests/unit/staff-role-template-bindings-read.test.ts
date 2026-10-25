import { Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  StaffRoleTemplateBindingsInputSchema,
  StaffRoleTemplateBindingsResultSchema,
  staffRoleTemplateBindingsRead,
} from '../../src/auth/staff-role-template-bindings-read.ts';
import { getReadPermissionTargetResolver } from '../../src/reads/definition.ts';

const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:staff-role-template',
    authMethod: 'session',
    legalEntityId: '00000000-0000-4000-8000-000000000002',
    principalId: '00000000-0000-4000-8000-000000000003',
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'staff-role-template-test',
};

it('requires the exact company and existing manage_identity OR manage_people, not invented role rights', () => {
  const resolve = getReadPermissionTargetResolver(staffRoleTemplateBindingsRead);
  if (!Predicate.isFunction(resolve)) {
    throw new TypeError('Expected an exact role-template permission resolver');
  }
  expect(resolve({ emails: ['person@example.invalid'] }, scope)).toEqual({
    kind: 'any_of',
    targets: [
      { kind: 'tenant', permission: 'manage_identity' },
      { kind: 'legal_entity', permission: 'manage_people' },
    ],
  });
  expect(staffRoleTemplateBindingsRead.descriptor.legalEntityScope).toBe('required');
  expect(staffRoleTemplateBindingsRead.descriptor.entrypoint.authorization).toEqual({
    kind: 'authenticated_principal',
  });
  expect(staffRoleTemplateBindingsRead.descriptor.evidencePolicy.captureMode).toBe('metadata_only');
});

it('bounds all six role-template emails and never exports provider subjects as principals', () => {
  expect(
    Schema.is(StaffRoleTemplateBindingsInputSchema)({
      emails: Array.from({ length: 6 }, () => 'person@example.invalid'),
    }),
  ).toBe(true);
  expect(
    Schema.is(StaffRoleTemplateBindingsInputSchema)({
      emails: Array.from({ length: 7 }, () => 'person@example.invalid'),
    }),
  ).toBe(false);
  expect(Schema.is(StaffRoleTemplateBindingsInputSchema)({ emails: [''] })).toBe(false);
  expect(
    Option.isNone(
      Schema.decodeOption(StaffRoleTemplateBindingsResultSchema)({
        bindings: [{ email: 'a', principalId: 'provider-user' }],
      }),
    ),
  ).toBe(true);
  expect(Object.keys(StaffRoleTemplateBindingsResultSchema.fields)).toEqual(['bindings']);
});
