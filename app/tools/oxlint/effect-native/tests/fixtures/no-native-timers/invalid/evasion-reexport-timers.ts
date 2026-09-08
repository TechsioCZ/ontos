/** A re-export hands Node timers to every consumer without ever importing them locally. */
export { setTimeout as delay, setInterval } from 'node:timers/promises';
export * from 'node:timers';
