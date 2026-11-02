"use client";

import Image from "next/image";
import StoreLink from "@/components/store-link";
import { Footer } from "@techsio/ui-kit/organisms/footer";

import { useBrand } from "@/brand/brand-context";
import type { Dictionary } from "@/i18n";
import { useDictionary } from "@/ontos/market-context";

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

const customerLinks = (cs: Dictionary) =>
  [
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
  const cs = useDictionary();
  const brand = useBrand();
  return (
    <Footer className="sf-footer" direction="vertical" layout="col" sectionFlow="col" size="sm">
      <div className="sf-footer__inner" id="footer">
        <Footer.Container className="sf-footer__top">
          <Footer.Section className="sf-footer__section sf-footer__brand-column">
            <StoreLink
              className="sf-footer__brand"
              href="/"
              aria-label={cs.footer.homeLinkLabel(brand.name)}
            >
              {brand.logo ? (
                <Image
                  alt={brand.name}
                  className="sf-footer__logo"
                  fill
                  loading="lazy"
                  sizes="161px"
                  src={brand.logo.footer}
                />
              ) : (
                <span className="sf-footer__wordmark">{brand.name}</span>
              )}
            </StoreLink>
            <div className="sf-footer__contact">
              <Footer.Title>{cs.footer.contact}</Footer.Title>
              <div className="sf-footer__contact-links">
                {brand.contact.phone && (
                  <Footer.Link className="sf-footer__contact-link" href={brand.contact.phone.href}>
                    <FooterAssetImage
                      asset={{
                        alt: "",
                        height: 26,
                        src: "/storefront/footer/phone.png",
                        width: 26,
                      }}
                    />
                    <span>{brand.contact.phone.display}</span>
                  </Footer.Link>
                )}
                <Footer.Link
                  className="sf-footer__contact-link"
                  href={`mailto:${brand.contact.email}`}
                >
                  <FooterAssetImage
                    asset={{ alt: "", height: 25, src: "/storefront/footer/email.png", width: 25 }}
                  />
                  <span>{brand.contact.email}</span>
                </Footer.Link>
              </div>
            </div>
          </Footer.Section>

          <Footer.Section className="sf-footer__section">
            <Footer.Title>{cs.footer.customerInformation}</Footer.Title>
            <nav aria-label={cs.footer.customerInformation}>
              <Footer.List>
                {customerLinks(cs).map((item) => (
                  <li key={`${item.href}-${item.label}`}>
                    <Footer.Link
                      as={StoreLink}
                      className="sf-footer__customer-link underline"
                      href={item.href}
                    >
                      {item.label}
                    </Footer.Link>
                  </li>
                ))}
              </Footer.List>
            </nav>
          </Footer.Section>

          <Footer.Section className="sf-footer__section">
            <Footer.Title>{cs.footer.reliableShop}</Footer.Title>
            <div className="sf-footer__trust-badge">
              <FooterAssetImage
                asset={{
                  alt: cs.footer.heurekaBadge,
                  height: 45,
                  src: "/storefront/footer/heureka-overeno-zakazniky.png",
                  width: 45,
                }}
              />
            </div>
          </Footer.Section>
        </Footer.Container>

        <Footer.Divider />

        <Footer.Bottom className="sf-footer__bottom">
          <Footer.Text className="sf-footer__copyright">
            {brand.copyright} / {cs.footer.createdBy}{" "}
            <Footer.Link href="https://www.web-revolution.cz/internetovy-obchod-eshop">
              Web Revolution
            </Footer.Link>
          </Footer.Text>
          <div className="sf-footer__bottom-links">
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
