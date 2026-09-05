// Type queries and type-only timer imports do not schedule work or capture runtime timers.
import { type setTimeout as NodeTimeout } from 'node:timers';
export type Timer = typeof setTimeout;
export type HostTimer = typeof globalThis.setTimeout;
export type NodeTimer = typeof NodeTimeout;
export interface LocalTimer { setTimeout(): void }
