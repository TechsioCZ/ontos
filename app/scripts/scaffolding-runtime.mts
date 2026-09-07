import { NodeServices } from '@effect/platform-node';
import { ManagedRuntime } from 'effect';

export const scaffoldingRuntime = ManagedRuntime.make(NodeServices.layer);
