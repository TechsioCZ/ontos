import '../routes/index.css';
import type { ComponentProps } from 'react';
import { CustomersPage } from '../routes/[lang]/customers/page.tsx';
declare const FederatedCustomersPage: (props: ComponentProps<typeof CustomersPage>) => import("react").JSX.Element;
export default FederatedCustomersPage;
