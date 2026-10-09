import { Schema } from 'effect';
import { AssortmentCommitmentConfirmationExpired as Expired } from './expired.ts';
import { AssortmentCommitmentConfirmationInvalid as Invalid } from './invalid.ts';
import { AssortmentCommitmentConfirmationScopeMismatch as ScopeMismatch } from './scope-mismatch.ts';
import { AssortmentCommitmentConfirmationUnavailable as Unavailable } from './unavailable.ts';

export { AssortmentCommitmentConfirmationExpired } from './expired.ts';
export { AssortmentCommitmentConfirmationInvalid } from './invalid.ts';
export { AssortmentCommitmentConfirmationScopeMismatch } from './scope-mismatch.ts';
export { AssortmentCommitmentConfirmationUnavailable } from './unavailable.ts';

export const AssortmentCommitmentConfirmationErrorSchema = Schema.Union([Expired, Invalid, ScopeMismatch, Unavailable]);

export type AssortmentCommitmentConfirmationError = typeof AssortmentCommitmentConfirmationErrorSchema.Type;
