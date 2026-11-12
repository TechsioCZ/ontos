import { Schema } from 'effect';

/**
 * Configure Gateway Enablement of one Provider Account Binding (#1155).
 * Scaffold placeholder (C17 wave 0): the owning lane replaces the empty payload and result shapes.
 */
export const ConfigureGatewayEnablementPayloadSchema = Schema.Struct({});
export type ConfigureGatewayEnablementPayload = typeof ConfigureGatewayEnablementPayloadSchema.Type;

export const ConfigureGatewayEnablementResultSchema = Schema.Struct({});
export type ConfigureGatewayEnablementResult = typeof ConfigureGatewayEnablementResultSchema.Type;
