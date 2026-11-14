import { PasswordRecoveryView } from "@/features/password-recovery-view";
import { getDictionary } from "@/i18n";

export const metadata = { robots: { follow: false, index: false } };

const PasswordRecoveryPage = async ({ params }: { params: Promise<{ locale: string }> }) => {
  const { locale } = await params;
  return <PasswordRecoveryView dictionary={getDictionary(locale)} locale={locale} mode="request" />;
};
export default PasswordRecoveryPage;
