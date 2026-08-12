interface CustomerPageTarget {
    readonly writable: boolean;
}
interface CustomersPageProps {
    readonly target?: CustomerPageTarget;
}
export declare const CustomersPage: ({ target }: CustomersPageProps) => import("react").JSX.Element;
export default CustomersPage;
