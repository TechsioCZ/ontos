import { Context } from 'effect';
import type { Redacted } from 'effect';

import type { SymmyIngressAdmission } from './transport.ts';

/** The admission of the caller's verified API key, and that key, kept only to refuse a request that repeats it. */
export class SymmyAdmittedCaller extends Context.Service<
  SymmyAdmittedCaller,
  { readonly admission: SymmyIngressAdmission; readonly credential: Redacted.Redacted }
>()('@app/shell-super-app/api/symmy/admitted-caller/SymmyAdmittedCaller') {}
