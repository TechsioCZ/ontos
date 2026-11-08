import { moduleReleaseFetch } from '@app/core-runtime/unit-service-fetch';
import { Context, Layer } from 'effect';

export class ApprovalOwnerModuleTransport extends Context.Service<
  ApprovalOwnerModuleTransport,
  { readonly send: typeof moduleReleaseFetch }
>()('@app/shell-super-app/api/access-admin/approval-owner-module-transport/ApprovalOwnerModuleTransport') {}

export const ApprovalOwnerModuleTransportLive = Layer.succeed(ApprovalOwnerModuleTransport, {
  send: moduleReleaseFetch,
});
