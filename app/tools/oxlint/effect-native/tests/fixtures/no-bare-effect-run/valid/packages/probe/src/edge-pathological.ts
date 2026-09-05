#!/usr/bin/env node
import { Effect } from 'effect';

declare const bag: Record<string, () => number>;
declare const tag: (strings: TemplateStringsArray, ...values: readonly unknown[]) => string;

/** Lookalike shapes on non-effect values, plus module/meta syntax the parser must survive. */
export const fromBag = bag['runSync']?.();

export const alsoFromBag = bag?.runPromise;

export const label = tag`${Effect.name}:${import.meta.url}`;

export const now = await Promise.resolve(1);
