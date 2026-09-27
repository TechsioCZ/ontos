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
          <Footer.Section>
            <Footer.Title>{cs.footer.contacts}</Footer.Title>
            <Footer.Text>737 591 849</Footer.Text>
            <Footer.Link href="mailto:akros@akros.cz">akros@akros.cz</Footer.Link>
            <Footer.Text>Praha · Ostrava · Chomutov–Údlice</Footer.Text>
          </Footer.Section>
          <Footer.Section>
            <Footer.Title>{cs.header.terms}</Footer.Title>
            <Footer.Link as={NextLink} href="/obchodni-podminky">
              {cs.footer.withdrawal}
            </Footer.Link>
            <Footer.Link as={NextLink} href="/doprava-a-platba">
              {cs.footer.shipping}
            </Footer.Link>
            <Footer.Link as={NextLink} href="/gdpr">
              {cs.footer.privacy}
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
        <Footer.Divider />
        <Footer.Bottom className="akros-footer__bottom">
          <Footer.Text>{cs.footer.copyright}</Footer.Text>
          <div className="akros-footer__bottom-links">
            <Footer.Link as={NextLink} href="/kategorie/akroscz-vyroba">
              {cs.header.production}
            </Footer.Link>
            <Footer.Link as={NextLink} href="/kontakty">
              {cs.footer.productionContacts}
            </Footer.Link>
            <Footer.Link href="#">{cs.footer.author}</Footer.Link>
          </div>
        </Footer.Bottom>
      </div>
    </Footer>
  );
}
