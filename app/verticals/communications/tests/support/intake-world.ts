import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer } from 'effect';

import { fixtureType } from '../unit/support/catalog-fixtures.ts';
import { usable } from '../unit/support/recipient-fixtures.ts';
import { privacyAllowed } from '../unit/support/privacy-fixtures.ts';
import type { PrivacyAnswer } from '../unit/support/privacy-fixtures.ts';
import type { OwnerAnswer } from '../unit/support/recipient-fixtures.ts';
import { documentOwnerDouble } from './document-owner-double.ts';
import { baseIdentity, seedLanguages } from './language-fixtures.ts';
import { nextId } from './persistence.fixture.ts';
import type { RuntimeDatabase } from './intake-runner.ts';
import {
  catalogOf,
  communicationRequest,
  privacyOwnerDouble,
  recipientOwnerDouble,
  recipientLanguageDouble,
  scopeDeclarationDouble,
  sourceAuthorityDouble,
  originalRecipient,
} from './intake-fixtures.ts';
import { intakeRunnerOver } from './intake-runner.ts';

export const FIXTURE_MESSAGE_TYPE = 'fixture.single-message';
export const templateBase = { ...baseIdentity, messageType: FIXTURE_MESSAGE_TYPE };

export const ownerAnswers = (recipientIds: readonly string[], answer: OwnerAnswer = usable()) =>
  Object.fromEntries(recipientIds.map((id) => [`contact-${id}`, answer]));
export const privacyAnswers = (recipientIds: readonly string[], answer: PrivacyAnswer = privacyAllowed) =>
  Object.fromEntries(recipientIds.map((id) => [id, answer]));

/** One Tenant with approved Czech and English templates of the fixture type and fresh owner doubles. */
export const intakeWorld = Effect.fn('CommunicationIntakeTest.world')(function* worldOf(
  database: RuntimeDatabase,
  options: {
    readonly recipients?: readonly string[];
    /** An existing Tenant (e.g. of a live Core fixture); a fresh one by default. */
    readonly tenantId?: string;
    readonly types?: readonly ReturnType<typeof fixtureType>[];
    readonly withTemplates?: boolean;
  } = {},
) {
  const tenantId = options.tenantId ?? (yield* nextId);
  const recipients = options.recipients ?? ['customer-1'];
  if (options.withTemplates !== false) {
    yield* database.withPorts(tenantId, (templates) => seedLanguages(templates, ['cs', 'en'], templateBase));
  }
  const source = sourceAuthorityDouble();
  const scope = scopeDeclarationDouble();
  const language = recipientLanguageDouble();
  const recipientAuthority = recipientOwnerDouble(ownerAnswers(recipients));
  const privacy = privacyOwnerDouble(privacyAnswers(recipients));
  // the labelled double of Core Media V1 / the document owner (#1443, #1446): asked only for a request that names documents
  const documents = documentOwnerDouble();
  const portsFor = (types: readonly ReturnType<typeof fixtureType>[]) =>
    Layer.mergeAll(
      catalogOf(...types),
      language.layer,
      source.layer,
      scope.layer,
      recipientAuthority.layer,
      privacy.layer,
      documents.layer,
      NodeCrypto.layer,
    );
  const types = options.types ?? [fixtureType()];
  const runner = intakeRunnerOver(database, portsFor(types));
  const read = <Row>(
    select: (
      transaction: Parameters<Parameters<typeof database.inTenant>[1]>[0],
    ) => Effect.Effect<readonly Row[], unknown>,
  ) => database.inTenant(tenantId, select);
  return {
    database,
    documents,
    language,
    portsFor,
    privacy,
    read,
    recipientAuthority,
    runner,
    scope,
    source,
    tenantId,
    types,
  };
});

export const requestFor = (
  tenantId: string,
  recipients: readonly string[] = ['customer-1'],
  occurrenceId = 'fixture-occurrence-1',
) =>
  communicationRequest({
    bindings: recipients.map((id) => originalRecipient(id)),
    occurrenceId,
    tenantId,
  });

export const decided = (outcome: Effect.Success<ReturnType<ReturnType<typeof intakeRunnerOver>['submit']>>) => {
  if (outcome.result.outcome !== 'DECIDED') {
    throw new Error('expected a decided outcome');
  }
  return outcome.result;
};
