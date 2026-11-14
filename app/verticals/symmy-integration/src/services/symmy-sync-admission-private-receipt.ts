import { Context } from 'effect';
import type { Effect } from 'effect';
import type { AdmitSymmySyncResult } from '../../shared/actions/admit-symmy-sync.ts';

/** Request-local private data capture. It is never part of the public Read result or transport. */
export class SymmySyncAdmissionPrivateReceipt extends Context.Service<
  SymmySyncAdmissionPrivateReceipt,
  { readonly capture: (receipt: AdmitSymmySyncResult) => Effect.Effect<void> }
>()('@app/symmy-integration/services/symmy-sync-admission-private-receipt/SymmySyncAdmissionPrivateReceipt') {}
