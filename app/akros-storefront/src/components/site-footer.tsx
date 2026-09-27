"use client";

import Image from "next/image";
import NextLink from "next/link";
import { Footer } from "@techsio/ui-kit/organisms/footer";

import { cs } from "@/i18n/cs";

export function SiteFooter() {
  return (
    <Footer className="akros-footer" direction="vertical" layout="row" sectionFlow="col" size="sm">
      <div className="akros-footer__inner" id="footer">
        <Footer.Container className="akros-footer__top">
          <Footer.Section className="akros-footer__section">
            <Footer.Title className="leading-tight">{cs.footer.contacts}</Footer.Title>
            <Footer.Text className="leading-tight">737 591 849</Footer.Text>
            <Footer.Link className="leading-tight" href="mailto:akros@akros.cz">
              akros@akros.cz
            </Footer.Link>
            <Footer.Text className="leading-tight">Praha · Ostrava · Chomutov–Údlice</Footer.Text>
          </Footer.Section>
          <Footer.Section className="akros-footer__section">
            <Footer.Title className="leading-tight">{cs.header.terms}</Footer.Title>
            <Footer.Link as={NextLink} className="leading-tight" href="/obchodni-podminky">
              {cs.footer.withdrawal}
            </Footer.Link>
            <Footer.Link as={NextLink} className="leading-tight" href="/doprava-a-platba">
              {cs.footer.shipping}
            </Footer.Link>
            <Footer.Link as={NextLink} className="leading-tight" href="/gdpr">
              {cs.footer.privacy}
            </Footer.Link>
            <Footer.Link as={NextLink} className="leading-tight" href="/obchodni-podminky">
              {cs.header.terms}
            </Footer.Link>
          </Footer.Section>
          <div className="akros-footer__banner">
            <Image
              alt="Partnerský program AKROS"
              fill
              loading="lazy"
              sizes="(max-width: 760px) 100vw, 50vw"
              src="/akros/home/partner-program.png"
            />
          </div>
        </Footer.Container>
        <Footer.Bottom className="akros-footer__bottom border-footer-border">
          <Footer.Text className="leading-tight">{cs.footer.copyright}</Footer.Text>
          <div className="akros-footer__bottom-links">
            <Footer.Link as={NextLink} className="leading-tight" href="/kategorie/akroscz-vyroba">
              {cs.header.production}
            </Footer.Link>
            <Footer.Link as={NextLink} className="leading-tight" href="/kontakty">
              {cs.footer.productionContacts}
            </Footer.Link>
            <Footer.Link className="leading-tight" href="#">
              {cs.footer.author}
            </Footer.Link>
          </div>
        </Footer.Bottom>
      </div>
    </Footer>
  );
}
