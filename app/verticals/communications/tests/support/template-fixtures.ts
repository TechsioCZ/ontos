import { NodeCrypto } from '@effect/platform-node';
import { Effect } from 'effect';
import type { Crypto } from 'effect';
import { TemplateLegalEntityIdSchema, TemplateRevisionIdSchema } from '../../shared/template-revision.ts';
import type { TemplateIdentity, TemplatePin } from '../../shared/template-revision.ts';
import {
  activateRevision,
  deactivateRevision,
  describeTemplateUse,
  invalidateRevisionAsUnsafe,
  prepareRevision,
  resolveTemplatePin,
  verifyTemplatePinForHandoff,
} from '../../src/services/template-revision-domain.service.ts';
import type { PrepareRevisionInput, TemplateActor } from '../../src/services/template-revision-domain.service.ts';
import type { TemplateRevisionPortContract } from '../../src/services/template-revision-port.service.ts';

export const adminOne: TemplateActor = {
  actionInvocationId: '00000000-0000-4000-8000-0000000000a1',
  legalEntityId: null,
  principalId: '00000000-0000-4000-8000-0000000000b1',
};
export const adminTwo: TemplateActor = {
  actionInvocationId: '00000000-0000-4000-8000-0000000000a2',
  legalEntityId: null,
  principalId: '00000000-0000-4000-8000-0000000000b2',
};
export const companyA = TemplateLegalEntityIdSchema.make('00000000-0000-4000-8000-0000000000c1');
export const companyB = TemplateLegalEntityIdSchema.make('00000000-0000-4000-8000-0000000000c2');
export const companyScope = (legalEntityId: typeof companyA) => ({ kind: 'legal-entity', legalEntityId }) as const;
export const actorFor = (legalEntityId: string | null): TemplateActor => ({ ...adminOne, legalEntityId });
export const revisionIdOf = (revisionId: string) => TemplateRevisionIdSchema.make(revisionId);

export const identity = (overrides: Partial<TemplateIdentity> = {}): TemplateIdentity => ({
  channel: 'email',
  language: 'cs',
  messageType: 'fixture.transactional-notice',
  scope: { kind: 'tenant' },
  ...overrides,
});

/** Clearly labelled FICTIONAL copy: no production wording, no recipient, no secret. */
export const fictionalDraft = (overrides: Partial<PrepareRevisionInput> = {}): PrepareRevisionInput => ({
  ...identity(),
  body: '[FICTIONAL TEST COPY] Purpose: {{purpose}}. Reference: {{reference}}.',
  optionalPlaceholders: ['reference'],
  reason: 'Fictional draft for tests',
  requiredPlaceholders: ['purpose'],
  subject: '[FICTIONAL TEST COPY] {{purpose}}',
  ...overrides,
});

/** The store generates revision ids with the platform crypto service, as the governed Action runtime provides. */
export const withCrypto = <Value, Failure>(effect: Effect.Effect<Value, Failure, Crypto.Crypto>) =>
  effect.pipe(Effect.provide(NodeCrypto.layer));

/** The domain programs bound to one port, so a test reads as the business sequence it checks. */
export const domainFor = (port: TemplateRevisionPortContract) => ({
  approve: (revisionId: string, actor: TemplateActor = adminOne) =>
    activateRevision(port, { reason: 'Fictional approval for tests', revisionId }, actor),
  deactivate: (revisionId: string, reason = 'Fictional retirement', actor: TemplateActor = adminOne) =>
    deactivateRevision(port, { reason, revisionId }, actor),
  describe: (pin: TemplatePin) => describeTemplateUse(port, pin),
  invalidate: (revisionId: string, reason = 'Fictional unsafe wording', actor: TemplateActor = adminOne) =>
    invalidateRevisionAsUnsafe(port, { reason, revisionId }, actor),
  prepare: (input: PrepareRevisionInput, actor: TemplateActor = adminOne) => prepareRevision(port, input, actor),
  resolve: (target: TemplateIdentity) => resolveTemplatePin(port, target),
  verify: (pin: TemplatePin) => verifyTemplatePinForHandoff(port, pin),
});

/** The failure of an Effect expected to fail; a success is a test defect. */
export const failureOf = <Value, Failure>(effect: Effect.Effect<Value, Failure, Crypto.Crypto>) =>
  withCrypto(Effect.flip(effect));
