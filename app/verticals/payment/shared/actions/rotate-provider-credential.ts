import { Schema } from 'effect';

/**
 * Rotate the Credential Revision of one Provider Account Binding (#1155).
 * Scaffold placeholder (C17 wave 0): the owning lane replaces the empty payload and result shapes.
 */
export const RotateProviderCredentialPayloadSchema = Schema.Struct({});
export type RotateProviderCredentialPayload = typeof RotateProviderCredentialPayloadSchema.Type;

export const RotateProviderCredentialResultSchema = Schema.Struct({});
export type RotateProviderCredentialResult = typeof RotateProviderCredentialResultSchema.Type;
