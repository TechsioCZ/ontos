// expect-count: 7
import { Effect } from 'effect';
import type { Device as ImportedDevice } from '../../../../valid/packages/probe/src/imported-device-owner.ts';
import type { ContextDto, CallableDto, OpaqueDto, UnknownDto } from '../../../../valid/packages/probe/src/imported-dependency-owner.ts';
import type { ShadowedDto } from '../../../../valid/packages/probe/src/imported-shadowed-owner.ts';
import type { CircularDto } from '../../../../valid/packages/probe/src/imported-cycle-a.ts';

export const createImportedDataTask = (label: string, input: ImportedDevice, index: number) => Effect.succeed({ label, input, index });
export const createContextTask = (label: string, input: ContextDto, index: number) => Effect.succeed({ label, input, index });
export const buildCallableTask = (label: string, input: CallableDto, index: number) => Effect.succeed({ label, input, index });
export const createOpaqueTask = (label: string, input: OpaqueDto, index: number) => Effect.succeed({ label, input, index });
export const buildUnknownTask = (label: string, input: UnknownDto, index: number) => Effect.succeed({ label, input, index });
export const createShadowedTask = (label: string, input: ShadowedDto, index: number) => Effect.succeed({ label, input, index });
export const buildCircularTask = (label: string, input: CircularDto, index: number) => Effect.succeed({ label, input, index });

{
  type ImportedDevice = { readonly read: () => string };
  const createShadowedImportTask = (label: string, input: ImportedDevice, index: number) => Effect.succeed({ label, input, index });
  void createShadowedImportTask;
}
