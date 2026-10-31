"use client";

import Image from "next/image";
import StoreLink from "@/components/store-link";
import { Footer } from "@techsio/ui-kit/organisms/footer";

import { cs } from "@/i18n/cs";

type FooterAsset = {
  alt: string;
  height: number;
  intrinsicHeight?: number;
  intrinsicWidth?: number;
  src: string;
  width: number;
};

function FooterAssetImage({ asset }: { asset: FooterAsset }) {
  return (
    <Image
      alt={asset.alt}
      height={asset.intrinsicHeight ?? asset.height}
      loading="lazy"
      src={asset.src}
      style={{ height: asset.height, width: asset.width }}
      width={asset.intrinsicWidth ?? asset.width}
    />
  );
}

const customerLinks = [
  { href: "/doprava-a-platba", label: cs.footer.delivery },
  { href: "/kontakty", label: cs.footer.pickup },
  { href: "/doprava-a-platba", label: cs.footer.paymentOptions },
  { href: "/o-nas", label: cs.footer.shoppingBenefits },
  { href: "/obchodni-podminky", label: cs.header.terms },
  { href: "/reklamace", label: cs.footer.claims },
  { href: "/gdpr", label: cs.footer.privacy },
  { href: "/faq", label: cs.footer.downloads },
  { href: "/kontakty", label: cs.footer.substitutePerformance },
] as const;

export function SiteFooter() {
  return (
    <Footer className="akros-footer" direction="vertical" layout="col" sectionFlow="col" size="sm">
      <div className="akros-footer__inner" id="footer">
        <Footer.Container className="akros-footer__top">
          <Footer.Section className="akros-footer__section akros-footer__brand-column">
            <StoreLink
              className="akros-footer__brand"
              href="/"
              aria-label={cs.footer.homeLinkLabel}
            >
              <Image
                alt="AKROS"
                className="akros-footer__logo"
                fill
                loading="lazy"
                sizes="161px"
                src="/akros/footer/logo.png"
              />
            </StoreLink>
            <div className="akros-footer__contact">
              <Footer.Title>{cs.footer.contact}</Footer.Title>
              <div className="akros-footer__contact-links">
                <Footer.Link className="akros-footer__contact-link" href="tel:+420737591849">
                  <FooterAssetImage
                    asset={{ alt: "", height: 26, src: "/akros/footer/phone.png", width: 26 }}
                  />
                  <span>737 591 849</span>
                </Footer.Link>
                <Footer.Link className="akros-footer__contact-link" href="mailto:akros@akros.cz">
                  <FooterAssetImage
                    asset={{ alt: "", height: 25, src: "/akros/footer/email.png", width: 25 }}
                  />
                  <span>akros@akros.cz</span>
                </Footer.Link>
              </div>
            </div>
          </Footer.Section>

          <Footer.Section className="akros-footer__section">
            <Footer.Title>{cs.footer.customerInformation}</Footer.Title>
            <nav aria-label={cs.footer.customerInformation}>
              <Footer.List>
                {customerLinks.map((item) => (
                  <li key={`${item.href}-${item.label}`}>
                    <Footer.Link
                      as={StoreLink}
                      className="akros-footer__customer-link underline"
                      href={item.href}
                    >
                      {item.label}
                    </Footer.Link>
                  </li>
                ))}
              </Footer.List>
            </nav>
          </Footer.Section>

          <Footer.Section className="akros-footer__section">
            <Footer.Title>{cs.footer.reliableShop}</Footer.Title>
            <div className="akros-footer__trust-badge">
              <FooterAssetImage
                asset={{
                  alt: cs.footer.heurekaBadge,
                  height: 45,
                  src: "/akros/footer/heureka-overeno-zakazniky.png",
                  width: 45,
                }}
              />
            </div>
          </Footer.Section>
        </Footer.Container>

        <Footer.Divider />

        <Footer.Bottom className="akros-footer__bottom">
          <Footer.Text className="akros-footer__copyright">
            {cs.footer.copyright} / {cs.footer.createdBy}{" "}
            <Footer.Link href="https://www.web-revolution.cz/internetovy-obchod-eshop">
              Web Revolution
            </Footer.Link>
          </Footer.Text>
          <div className="akros-footer__bottom-links">
            <Footer.Link as={StoreLink} href="/gdpr#cookies">
              {cs.footer.cookies}
            </Footer.Link>
            <Footer.Link as={StoreLink} href="/gdpr">
              {cs.footer.personalDataProtection}
            </Footer.Link>
          </div>
        </Footer.Bottom>
      </div>
    </Footer>
  );
}
