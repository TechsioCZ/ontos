"use client";

import Image from "next/image";
import NextLink from "next/link";
import { Icon } from "@techsio/ui-kit/atoms/icon";
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

const paymentMethods = [
  { alt: cs.footer.paymentCard, height: 28, src: "/akros/footer/payment-card.png", width: 39 },
  { alt: "Google Pay", height: 28, src: "/akros/footer/google-pay.png", width: 39 },
  { alt: "Apple Pay", height: 28, src: "/akros/footer/apple-pay.png", width: 39 },
  { alt: cs.footer.cash, height: 28, src: "/akros/footer/cash.png", width: 39 },
  { alt: cs.footer.bankTransfer, height: 28, src: "/akros/footer/bank-transfer.png", width: 39 },
] satisfies FooterAsset[];

const carriers = [
  { alt: "Zásilkovna", height: 28, src: "/akros/footer/zasilkovna.png", width: 69 },
  { alt: "PPL", height: 28, src: "/akros/footer/ppl.png", width: 52 },
  { alt: "GLS", height: 28, src: "/akros/footer/gls.png", width: 52 },
  { alt: "DPD", height: 28, src: "/akros/footer/dpd.png", width: 52 },
  { alt: "Balíkovna", height: 28, src: "/akros/footer/balikovna.png", width: 69 },
] satisfies FooterAsset[];

const securityMethods = [
  {
    alt: "Verified by Visa",
    height: 26.56,
    intrinsicHeight: 41,
    intrinsicWidth: 71,
    src: "/akros/footer/visa.png",
    width: 46,
  },
  {
    alt: "Mastercard SecureCode",
    height: 26.53,
    intrinsicHeight: 41,
    intrinsicWidth: 85,
    src: "/akros/footer/mastercard-securecode.png",
    width: 55,
  },
] satisfies FooterAsset[];

const socialIcons = [
  "icon-[mdi--facebook]",
  "icon-[mdi--instagram]",
  "icon-[mdi--youtube]",
] as const;

export function SiteFooter() {
  return (
    <Footer className="akros-footer" direction="vertical" layout="row" sectionFlow="col" size="sm">
      <div className="akros-footer__inner" id="footer">
        <Footer.Container className="akros-footer__top">
          <Footer.Section className="akros-footer__section akros-footer__brand-column">
            <NextLink className="akros-footer__brand" href="/" aria-label={cs.footer.homeLinkLabel}>
              <Image
                alt="AKROS"
                className="akros-footer__logo"
                fill
                loading="lazy"
                sizes="161px"
                src="/akros/footer/logo.png"
              />
            </NextLink>
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
                      as={NextLink}
                      className="akros-footer__customer-link"
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

          <Footer.Section className="akros-footer__section">
            <Footer.Title>{cs.footer.followUs}</Footer.Title>
            <div className="akros-footer__socials">
              {socialIcons.map((icon) => (
                <span className="akros-footer__social-icon" key={icon}>
                  <Icon icon={icon} size="2xl" />
                </span>
              ))}
            </div>
          </Footer.Section>
        </Footer.Container>

        <Footer.Divider />

        <Footer.Container className="akros-footer__commerce">
          <Footer.Section>
            <Footer.Title>{cs.footer.paymentMethods}</Footer.Title>
            <div className="akros-footer__asset-row akros-footer__asset-row--payments">
              {paymentMethods.map((item) => (
                <FooterAssetImage asset={item} key={item.src} />
              ))}
            </div>
          </Footer.Section>

          <Footer.Section>
            <Footer.Title>{cs.footer.carriers}</Footer.Title>
            <div className="akros-footer__asset-row akros-footer__asset-row--carriers">
              {carriers.map((item) => (
                <FooterAssetImage asset={item} key={item.src} />
              ))}
            </div>
          </Footer.Section>

          <Footer.Section>
            <Footer.Title>{cs.footer.secureShopping}</Footer.Title>
            <div className="akros-footer__asset-row akros-footer__asset-row--security">
              {securityMethods.map((item) => (
                <FooterAssetImage asset={item} key={item.src} />
              ))}
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
            <Footer.Link as={NextLink} href="/gdpr#cookies">
              {cs.footer.cookies}
            </Footer.Link>
            <Footer.Link as={NextLink} href="/gdpr">
              {cs.footer.personalDataProtection}
            </Footer.Link>
          </div>
        </Footer.Bottom>
      </div>
    </Footer>
  );
}
