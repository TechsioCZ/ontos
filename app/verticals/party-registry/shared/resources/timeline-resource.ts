import type { OntosResourceType } from '@app/core-runtime';
import { Schema } from 'effect';

import { PartyRegistryResourceIdJsonSchema, PartyRegistryTenantIdJsonSchema } from './resource-ref-identifiers.ts';

const PARTY_REGISTRY_MODULE_ID = 'party.registry' as const;

export const timelineResource = <const Slug extends string, const Label extends string>(slug: Slug, label: Label) => {
  const resourceType = `party.registry.${slug}` as const;
  const refSchema = Schema.Struct({
    moduleId: Schema.Literal(PARTY_REGISTRY_MODULE_ID),
    resourceId: PartyRegistryResourceIdJsonSchema,
    resourceType: Schema.Literal(resourceType),
    tenantId: PartyRegistryTenantIdJsonSchema,
  });
  const makeRef = (tenantId: string, resourceId: string): typeof refSchema.Type => ({
    moduleId: PARTY_REGISTRY_MODULE_ID,
    resourceId,
    resourceType,
    tenantId,
  });
  const descriptor = {
    capabilities: {
      graphVisible: false,
      linkable: false,
      mediaAttachable: false,
      searchable: false,
      timelineVisible: true,
    },
    description: `${label} resource.`,
    key: resourceType,
    label,
    owningModuleId: PARTY_REGISTRY_MODULE_ID,
  } as const satisfies OntosResourceType;
  return { descriptor, makeRef, refSchema };
};
