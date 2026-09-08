// Declaration files are in the default `ignore` list.
import type { Effect } from 'effect';

export declare const traced: typeof Effect.annotateLogs;
export declare const identity: { correlationId: string; tenantId: string; actionKey: string };
