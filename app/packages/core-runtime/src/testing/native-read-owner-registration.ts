import { Context } from 'effect';

import type { VerticalRuntimeRegistration } from '../modules/runtime-registration.ts';

/** Optional in-process owner binding for the native Read test fixture. */
export class NativeReadTestOwnerRegistration extends Context.Service<
  NativeReadTestOwnerRegistration,
  VerticalRuntimeRegistration
>()('@app/core-runtime/testing/native-read-owner-registration/NativeReadTestOwnerRegistration') {}
