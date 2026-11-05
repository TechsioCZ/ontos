import { Context } from 'effect';

import type { AccessProjectionCompiler as AccessProjectionCompilerEngine } from '../compiler/spice-db-compiler.ts';

/**
 * L42's compiler as a composition binds it. The compiler owns the configuration and the lifetime of one
 * engine transport, which a composition root opens (CUTOVER-PLAN §3.1 step 7-8), so the writer asks for
 * the compiler instead of building one: a request path never opens a transport, and a suite hand in the
 * same shape over its own container.
 */
export class AccessProjectionCompiler extends Context.Service<
  AccessProjectionCompiler,
  AccessProjectionCompilerEngine
>()('@app/core-runtime/access/intent/projection-compiler/AccessProjectionCompiler') {}
