// `Cause` here is a project-local module, not `effect`.
import { Cause } from './cause-helpers.ts';

declare const value: unknown;

export const local = Cause.hasDies(value);
