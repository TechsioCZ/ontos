import { Schema } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';
import { CreatePartyPayloadSchema } from './create-party.ts';

export { CreatePartyResultSchema as CreateCrmClientPartyResultSchema } from './create-party.ts';

/** A CRM-owned client snapshot, attested only by its admitted module acting for the intake workload. */
export const CreateCrmClientPartyPayloadSchema = Schema.Struct({
  candidate: CreatePartyPayloadSchema.fields.candidate,
  sourceScope: Schema.Struct({
    tenantId: Schema.String.check(Schema.isUUID()),
    legalEntityId: Schema.String.check(Schema.isUUID()),
  }),
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

/** Length-prefixed UTF-16 code units preserve every string without ambiguous tuple boundaries. */
const encodeClientIdentity = (identity: readonly [string, string, string]) =>
  identity
    .map(
      (value) =>
        `${value.length}:${value
          .split('')
          .map((unit) => unit.codePointAt(0)?.toString(16).padStart(4, '0'))
          .join('')}`,
    )
    .join('');

/** Company-qualified, bounded evidence identity; local client ids never collide across scopes. */
export const crmClientEvidenceReference = (
  scope: { readonly tenantId: string; readonly legalEntityId: string },
  clientId: string,
) =>
  `crm-client:${Hex.encode(sha256(utf8ToBytes(encodeClientIdentity([scope.tenantId, scope.legalEntityId, clientId]))))}`;
