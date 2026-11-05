import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { managedPrincipalsRead, selfApiKeyBindingsRead } from '../../src/auth/principal-administration-reads.ts';
import { projectReadResultFields } from '../../src/reads/definition.ts';

/**
 * O58/A1: the Core identity administration reads carry sensitive field groups. A caller that lacks a
 * group receives the projection without those fields; the parent admin read still decides the list.
 * The declared paths are proven against the exact result shapes (Option/DateTime payloads), which the
 * projection must keep intact for the fields it does not redact (C25, O17, O74).
 */

const managedSchema = Schema.toType(managedPrincipalsRead.descriptor.resultSchema);
const selfSchema = Schema.toType(selfApiKeyBindingsRead.descriptor.resultSchema);
/** The wire codec: a handler returns the decoded (Option/DateTime-typed) shape from JSON input. */
const managedJson = Schema.toCodecJson(managedPrincipalsRead.descriptor.resultSchema);
const selfJson = Schema.toCodecJson(selfApiKeyBindingsRead.descriptor.resultSchema);

const managedList = () =>
  Schema.decodeUnknownSync(managedJson)({
    items: [
      {
        authBindingId: '00000000-0000-4000-8000-0000000000a1',
        bindingCreatedAt: '2026-11-03T09:00:00.000Z',
        bindingRevokedAt: null,
        bindingStatus: 'active',
        displayName: 'Ada Lovelace',
        kind: 'service',
        principalId: '00000000-0000-4000-8000-0000000000a2',
        principalStatus: 'active',
      },
    ],
    nextOffset: null,
  });

const selfList = () =>
  Schema.decodeUnknownSync(selfJson)({
    items: [
      {
        authBindingId: '00000000-0000-4000-8000-0000000000b1',
        createdAt: '2026-11-03T09:00:00.000Z',
        revokedAt: null,
        status: 'active',
      },
    ],
    nextOffset: null,
  });

const deniedPathsOf = (groups: readonly { readonly fields: readonly string[] }[]): readonly (readonly string[])[] =>
  groups.flatMap((group) => group.fields.map((field) => field.split('.')));

it('declares the personal-data and authentication-metadata field groups on the identity reads (O58)', () => {
  expect(
    managedPrincipalsRead.descriptor.accessFieldGroups?.map((group) => [
      group.key,
      group.kind,
      group.fieldClass,
      group.fields,
    ]),
  ).toEqual([
    ['core.identity.principal.read-personal-data', 'field_read', 'personal_data', ['items.displayName']],
    [
      'core.identity.principal.read-authentication-metadata',
      'field_read',
      'authentication_metadata',
      ['items.authBindingId', 'items.bindingCreatedAt', 'items.bindingRevokedAt', 'items.bindingStatus'],
    ],
  ]);
  expect(
    selfApiKeyBindingsRead.descriptor.accessFieldGroups?.map((group) => [group.key, group.fieldClass, group.fields]),
  ).toEqual([
    [
      'core.identity.self-api-key.read-authentication-metadata',
      'authentication_metadata',
      ['items.authBindingId', 'items.createdAt', 'items.revokedAt', 'items.status'],
    ],
  ]);
  expect(Object.isFrozen(managedPrincipalsRead.descriptor.accessFieldGroups)).toBe(true);
});

it('omits every declared managed-principal field when its groups are denied and keeps the rest (O17, O58)', () => {
  const groups = managedPrincipalsRead.descriptor.accessFieldGroups ?? [];
  const projected = projectReadResultFields(managedList(), deniedPathsOf(groups), managedSchema);
  const [item] = Option.getOrThrow(projected).items;
  // Only the identity and status remain; the personal name and the credential metadata are gone.
  expect(item).toEqual({
    kind: 'service',
    principalId: '00000000-0000-4000-8000-0000000000a2',
    principalStatus: 'active',
  });
});

it('returns the whole managed-principal list when the caller holds every field group (negative control)', () => {
  const complete = managedList();
  expect(Option.getOrThrow(projectReadResultFields(complete, [], managedSchema))).toEqual(complete);
});

it('omits every declared self API-key field when its group is denied, keeping the row (O17, O58)', () => {
  const groups = selfApiKeyBindingsRead.descriptor.accessFieldGroups ?? [];
  const projected = Option.getOrThrow(projectReadResultFields(selfList(), deniedPathsOf(groups), selfSchema));
  // The row is still present (the list is not emptied), only its declared fields are redacted.
  expect(projected.items).toHaveLength(1);
  expect(projected.items[0]).toEqual({});
});
