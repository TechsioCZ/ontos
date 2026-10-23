import { defineScopedRoutine } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import {
  EnrollmentResourceIdSchema,
  RetailEnrollmentRegistrationSchema,
} from '../../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptId, RetailEnrollmentRegistration } from '../../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptScopedRoutineInvoker } from './attempt-persistence.ts';
import { attemptUnavailable } from './errors.ts';

const ownerModuleKey = 'commerce.customer-context';
const writeRegistrationRoutine = defineScopedRoutine({
  name: 'write_retail_enrollment_registration',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ written: Schema.Boolean }),
  routineKey: 'portal-enrollment.registration.write',
  schema: 'commerce_customer_context',
});
const readRegistrationRoutine = defineScopedRoutine({
  name: 'read_retail_enrollment_registration',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ registration: RetailEnrollmentRegistrationSchema }),
  routineKey: 'portal-enrollment.registration.read',
  schema: 'commerce_customer_context',
});
const readAccountPartyRoutine = defineScopedRoutine({
  name: 'read_retail_enrollment_account_party',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ party_id: EnrollmentResourceIdSchema.check(Schema.isUUID()) }),
  routineKey: 'portal-enrollment.account-party.read',
  schema: 'commerce_customer_context',
});

export const writeRetailEnrollmentRegistration = (
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  attemptId: EnrollmentAttemptId,
  registration: RetailEnrollmentRegistration,
) =>
  Schema.encodeEffect(Schema.fromJsonString(RetailEnrollmentRegistrationSchema))(registration).pipe(
    Effect.flatMap((encoded) => transaction.invoke(writeRegistrationRoutine, [attemptId, encoded])),
    Effect.mapError((cause) =>
      attemptUnavailable('The retail registration could not be durably recorded', attemptId, cause),
    ),
    Effect.flatMap((rows) =>
      rows[0]?.written === true
        ? Effect.void
        : Effect.fail(attemptUnavailable('The retail registration was not recorded', attemptId)),
    ),
  );

export const readRetailEnrollmentRegistration = (
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  attemptId: EnrollmentAttemptId,
) =>
  transaction.invoke(readRegistrationRoutine, [attemptId]).pipe(
    Effect.mapError((cause) => attemptUnavailable('The retail registration could not be read', attemptId, cause)),
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.registration)),
  );

/** Exact provider-subject mapping, never an email-based customer search. */
export const readRetailEnrollmentAccountParty = (
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  providerSubjectId: string,
) =>
  transaction.invoke(readAccountPartyRoutine, [providerSubjectId]).pipe(
    Effect.mapError((cause) =>
      attemptUnavailable('The admitted retail customer mapping could not be read', undefined, cause),
    ),
    Effect.flatMap((rows) =>
      rows.length > 1
        ? Effect.fail(attemptUnavailable('The admitted retail customer mapping is ambiguous'))
        : Effect.succeed(Option.fromNullishOr(rows[0]?.party_id)),
    ),
  );
