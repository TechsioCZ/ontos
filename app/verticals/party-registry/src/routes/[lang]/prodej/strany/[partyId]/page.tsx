import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Option, Result, Schema } from 'effect';

import { UltramodernRouteHead } from '../../../../ultramodern-route-head';
import '../../../../index.css';
import { PartyIdentityPageView } from './party-identity-view.tsx';
import { PARTY_IDENTITY_KEY, partyIdentityInput } from './party-identity-data.ts';
import { partyIdentityI18nResources } from './party-identity-i18n.ts';
import { usePartyIdentityRead } from './party-identity-read.ts';

export const PartyIdentityPageRouteParams = Schema.Struct({
  partyId: Schema.String.pipe(Schema.brand('PartyIdentityPagePartyIdRouteParameter')),
});
export type PartyIdentityPageRouteParameters = typeof PartyIdentityPageRouteParams.Type;
export const PartyIdentityPageRouteParamsStandardSchema = Schema.toStandardSchemaV1(PartyIdentityPageRouteParams);

const emptyRouteParams = Result.getOrThrow(Schema.decodeResult(PartyIdentityPageRouteParams)({ partyId: '' }));

export interface PartyIdentityPageProps {
  readonly context?: ModulePageContext | undefined;
  readonly routeParams: PartyIdentityPageRouteParameters;
}

const PartyIdentityPageContent = ({ context, routeParams }: PartyIdentityPageProps) => {
  const { language } = useModernI18n();
  const navigate = useNavigate();
  const input = partyIdentityInput(context, routeParams);
  const read = usePartyIdentityRead(input);
  const handleBack = () => {
    void navigate({ to: `/${language ?? 'cs'}/search` });
  };
  const handleReload = read.retry;

  return (
    <>
      <UltramodernRouteHead titleKey={`${PARTY_IDENTITY_KEY}.title`} />
      <section className="partyregistry:mx-auto partyregistry:flex partyregistry:w-full partyregistry:max-w-4xl partyregistry:flex-col partyregistry:gap-5 partyregistry:px-4 partyregistry:py-8 partyregistry:sm:px-8">
        <PartyIdentityPageView input={input} onBack={handleBack} onReload={handleReload} read={read.view} />
      </section>
    </>
  );
};

export const PartyIdentityPage = ({ context, routeParams }: PartyIdentityPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="party-registry"
    fallbackLanguage="en"
    resources={partyIdentityI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <PartyIdentityPageContent context={context} routeParams={routeParams} />
  </FederatedI18nBoundary>
);

const PartyIdentityRoute = ({ context, routeParams: suppliedParams }: Partial<PartyIdentityPageProps>) => {
  const params: unknown = useParams({ from: '/$lang/prodej/strany/$partyId', shouldThrow: false });
  const routeParams = Schema.decodeUnknownOption(PartyIdentityPageRouteParams)(params);
  return (
    <PartyIdentityPage
      context={context}
      routeParams={suppliedParams ?? Option.getOrElse(routeParams, () => emptyRouteParams)}
    />
  );
};

export default PartyIdentityRoute;
