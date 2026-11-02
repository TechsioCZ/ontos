import { Option, Schema } from 'effect';
import { PersonRefSchema } from '../resources/person.ts';

const uuid = Schema.is(Schema.String.check(Schema.isUUID()));
/** One person has an independent directory resource in each company. */
export const personResourceId = (legalEntityId: string, principalId: string) => `${legalEntityId}.${principalId}`;
export const personIdentity = (resourceId: string) => {
  const parts = resourceId.split('.');
  const [legalEntityId, principalId] = parts;
  return parts.length === 2 &&
    legalEntityId !== undefined &&
    principalId !== undefined &&
    uuid(legalEntityId) &&
    uuid(principalId)
    ? Option.some({ legalEntityId, principalId })
    : Option.none();
};
export const personRef = (tenantId: string, legalEntityId: string, principalId: string) =>
  Schema.decodeUnknownEffect(PersonRefSchema)({
    moduleId: 'core.identity',
    resourceId: personResourceId(legalEntityId, principalId),
    resourceType: 'core.identity.person',
    tenantId,
  });
