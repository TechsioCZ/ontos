import { headers } from "next/headers";
import { PasswordRecoveryView } from "@/features/password-recovery-view";
import { getDictionary } from "@/i18n";
import { hasPasswordRecoveryToken } from "@/ontos/password-recovery-server";

export const dynamic = "force-dynamic";
export const metadata = { robots: { follow: false, index: false } };

const PasswordResetPage = async ({ params }: { params: Promise<{ locale: string }> }) => {
  const { locale } = await params;
  const incoming = await headers();
  return (
    <PasswordRecoveryView
      dictionary={getDictionary(locale)}
      locale={locale}
      mode="reset"
      tokenPresent={hasPasswordRecoveryToken(incoming.get("cookie") ?? undefined)}
    />
  );
};
export default PasswordResetPage;
