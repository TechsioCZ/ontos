import { Schema } from 'effect';

const uuid = Schema.String.check(Schema.isUUID());
export const EnrollmentAttemptIdSchema = uuid.pipe(Schema.brand('EnrollmentAttemptId'));
export const EnrollmentOwnerOperationIdSchema = uuid.pipe(Schema.brand('EnrollmentOwnerOperationId'));
export const EnrollmentLegalEntityIdSchema = uuid.pipe(Schema.brand('EnrollmentLegalEntityId'));
