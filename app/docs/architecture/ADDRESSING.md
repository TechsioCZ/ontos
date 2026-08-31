# Adresy v MicroVerticalech

## Základní princip

Adresa je standardně **value object**. Nemá vlastní identitu ani samostatný životní cyklus a patří entitě, která ji používá. Zákazník proto vlastní svou adresu v Projects, sklad svou adresu ve skladovém modulu a dokument může uchovávat historickou kopii adresy.

Společná může být implementace adresy: datový model, validace, databázové stavební prvky a UI formulář. Samotné adresní hodnoty a jejich vazby však zůstávají v jednotlivých MicroVerticalech.

Adresa se stane samostatnou entitou, například `Location`, pouze pokud konkrétní místo potřebuje vlastní identitu, životní cyklus nebo má být sdílené více moduly. Taková entita má jednoho vlastníka a ostatní moduly se na ni odkazují přes `ResourceRef` a její veřejné kontrakty.

## Praktické rozhodovací pravidlo

| Situace                                                                | Řešení                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Potřebujeme pouze stejná pole, validaci a formulář.                    | Sdílená implementace, lokálně uložený value object.       |
| Adresy se mohou měnit nezávisle.                                       | Každý MicroVertical vlastní svou adresní hodnotu.         |
| Potřebujeme zachovat adresu platnou v okamžiku vytvoření dokumentu.    | Uložit lokální snapshot adresy.                           |
| Jedno místo má vlastní identitu, historii nebo je sdílené více moduly. | Zavést samostatnou entitu `Location` s jedním vlastníkem. |
