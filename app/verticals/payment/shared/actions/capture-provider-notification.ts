import { Schema } from 'effect';

/**
 * Capture one provider notification delivered by the PSP notification relay workload (#1157).
 * Scaffold placeholder (C17 wave 0): the owning lane replaces the empty payload and result shapes.
 */
export const CaptureProviderNotificationPayloadSchema = Schema.Struct({});
export type CaptureProviderNotificationPayload = typeof CaptureProviderNotificationPayloadSchema.Type;

export const CaptureProviderNotificationResultSchema = Schema.Struct({});
export type CaptureProviderNotificationResult = typeof CaptureProviderNotificationResultSchema.Type;
