import type { OutboxMessage } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import type { StorefrontApplicationCommandRejected } from '../../shared/action-contracts.ts';
import { StorefrontApplicationCommandRejected as CommandRejected } from '../../shared/action-contracts.ts';
import type { StorefrontApplicationRef } from '../../shared/resources/storefront-application.ts';

export const MODULE_KEY = 'commerce.storefront-registry' as const;

export const StorefrontAdministrationAuditEvidenceSchema = Schema.Struct({
  changed: Schema.Boolean,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  operation: Schema.Literals(['REGISTER', 'REVISE']),
  reason: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const storefrontRecordedAt = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const storefrontApplicationRef = (tenantId: string, resourceId: string): StorefrontApplicationRef => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: 'commerce.storefront-registry.storefront-application',
  tenantId,
});

export const rejectStorefrontCommand = (
  code: StorefrontApplicationCommandRejected['code'],
  reason: string,
): Effect.Effect<never, StorefrontApplicationCommandRejected> => Effect.fail(new CommandRejected({ code, reason }));

export const storefrontDataAccessEvidence = (operation: string, resourceId: string) => ({
  accessKind: 'read' as const,
  queryHash: `storefront-administration:${operation}:${resourceId}`,
  resultCount: 1,
  servingModuleKey: MODULE_KEY,
  targetModuleKey: MODULE_KEY,
  targetResourceId: resourceId,
  targetResourceType: 'commerce.storefront-registry.storefront-application',
});

export const storefrontOutboxMessage = (topic: string, payloadJson: OutboxMessage['payloadJson']): OutboxMessage => ({
  payloadJson,
  producerModuleKey: MODULE_KEY,
  topic,
});
