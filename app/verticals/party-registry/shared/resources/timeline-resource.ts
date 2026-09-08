import type { OntosResourceType } from '@app/core-runtime';
import { Schema } from 'effect';
import {
  PartyRegistryResourceIdJsonSchema,
  PartyRegistryTenantIdJsonSchema,
} from './resource-ref-identifiers.ts';

export const timelineResource = <const Slug extends string, const Label extends string>(
  slug: Slug,
  label: Label,
) => {
  const resourceType = `party.registry.${slug}` as const;
  const refSchema = Schema.Struct({
    moduleId: Schema.Literal('party.registry'),
    resourceId: PartyRegistryResourceIdJsonSchema,
    resourceType: Schema.Literal(resourceType),
    tenantId: PartyRegistryTenantIdJsonSchema,
  });
  const makeRef = (tenantId: string, resourceId: string): typeof refSchema.Type => ({
    moduleId: 'party.registry',
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
    owningModuleId: 'party.registry',
  } as const satisfies OntosResourceType;
  return { descriptor, makeRef, refSchema };
};
