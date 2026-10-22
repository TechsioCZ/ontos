/**
 * Per module, the company-wide (Legal Entity) relations an agent with write access receives. Each module declares
 * them in its MCP contribution (`legalEntityWriteRelations`); the Shell reads them from the active composition and
 * never names a module itself.
 */
import type { ApplicationComposition } from '@app/core-runtime';
import { Option, Schema } from 'effect';

type ComposedModule = Pick<ApplicationComposition['modules'][number], 'contractDocument' | 'moduleId'>;

const ContractWriteRelationsSchema = Schema.fromJsonString(
  Schema.Struct({
    manifest: Schema.Struct({
      publicSurface: Schema.Struct({
        mcp: Schema.optionalKey(
          Schema.Struct({ legalEntityWriteRelations: Schema.optionalKey(Schema.Array(Schema.String)) }),
        ),
      }),
    }),
  }),
);
const decodeContractWriteRelations = Schema.decodeUnknownOption(ContractWriteRelationsSchema);

export const legalEntityWriteRelationsOf = (composition: {
  readonly modules: readonly ComposedModule[];
}): ReadonlyMap<string, readonly string[]> =>
  new Map(
    composition.modules.flatMap((module) => {
      const relations = Option.flatMapNullishOr(
        decodeContractWriteRelations(module.contractDocument),
        (contract) => contract.manifest.publicSurface.mcp?.legalEntityWriteRelations,
      );
      return Option.isSome(relations) && relations.value.length > 0
        ? [[module.moduleId, relations.value] as const]
        : [];
    }),
  );
