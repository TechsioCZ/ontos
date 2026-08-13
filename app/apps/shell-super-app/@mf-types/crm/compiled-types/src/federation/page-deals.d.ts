import '../routes/index.css';
import type { ComponentProps } from 'react';
import { DealsPage } from '../routes/[lang]/deals/page.tsx';
declare const FederatedDealsPage: (props: ComponentProps<typeof DealsPage>) => import("react").JSX.Element;
export default FederatedDealsPage;
