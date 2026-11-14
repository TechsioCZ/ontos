import { makeAiApprovalSchemas } from '@app/shared-contracts/ai-approvals';
import { MerchandiseAiOperationSchema } from '../actions/apply-command.ts';

/** AI level C proposals, decisions, reverts and their log (see `@app/shared-contracts/ai-approvals`). */
const MerchandiseAiSchemas = makeAiApprovalSchemas(MerchandiseAiOperationSchema);
export const MerchandiseAiSliceSchema = MerchandiseAiSchemas.slice;
export type MerchandiseAiSlice = typeof MerchandiseAiSliceSchema.Type;
