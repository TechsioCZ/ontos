import { Schema } from 'effect';

/**
 * Configure one Provider Account Binding of the trusted Selling Legal Entity (#1155).
 * Scaffold placeholder (C17 wave 0): the owning lane replaces the empty payload and result shapes.
 */
export const ConfigureProviderAccountBindingPayloadSchema = Schema.Struct({});
export type ConfigureProviderAccountBindingPayload = typeof ConfigureProviderAccountBindingPayloadSchema.Type;

export const ConfigureProviderAccountBindingResultSchema = Schema.Struct({});
export type ConfigureProviderAccountBindingResult = typeof ConfigureProviderAccountBindingResultSchema.Type;
