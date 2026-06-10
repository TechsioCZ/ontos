import type { VerticalRuntimeRegistration } from '@mvp/shared-contracts';

export { FederatedPublicComponent } from '@mvp/shared-contracts/federated-public-component';

export const findPublicComponentDescriptor = ({
  componentId,
  moduleId,
  registrations,
}: {
  readonly componentId: string;
  readonly moduleId: string;
  readonly registrations: readonly VerticalRuntimeRegistration[];
}) =>
  registrations
    .find((registration) => registration.manifest.id === moduleId)
    ?.manifest.components.find((component) => component.id === componentId);
