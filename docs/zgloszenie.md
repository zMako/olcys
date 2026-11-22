# Zgłoszenie — OŁCyŚ (Osintowy Łapacz Cyfrowych Śladów)

Teksty do pól formularza, gotowe do wklejenia. Pliki: `docs/okladka.png` (obraz, 4:3), `docs/prezentacja.pdf` (10 slajdów, 2,7 MB).

## Problem

Część osób zamienia kryptowaluty na złote, euro czy dolary i nie wykazuje tego w PIT-38. Ślady istnieją: adresy portfeli są w profilach, ogłoszeniach i na forach, a historia każdego adresu jest publiczna. Analityk KAS łączy je dziś ręcznie: godzinami, bez możliwości powtórzenia i bez wiedzy, od kogo zacząć.

Skalę zmierzyliśmy sami, na danych publicznych: o 3 876 portfelach Coinbase publicznie poświadcza, że należą do klientów zweryfikowanych w Polsce. Spośród portfeli naszego rejestru 818 wysłało środki na giełdy: 5 327 wpłat, łącznie 1,83 mln w stablecoinach i 520 ETH.

## Rozwiązanie

OŁCyŚ to narzędzie dla analityka KAS. Z jednego identyfikatora (nick, imię i nazwisko, e-mail, komunikator, adres kryptowalutowy) samo przeszukuje publiczne źródła i prowadzi sprawę w kolejności scenariusza: wejście, ślady w sieci, adresy i pewność, łańcuch bloków, wniosek, źródła i raport.

- **Wskaźnik Pewności liczony jawnymi regułami.** Każdy wynik to „paragon”: reguła, punkty, źródło. Te same dane dają zawsze ten sam wynik; model AI nie ma na niego wpływu.
- **Odrzucanie błędnych przypisań.** Adres giełdy, kontraktu czy cytowany cudzy adres dostaje 0% z podanym powodem.
- **Rejestr 4 500 polskich portfeli** z danych publicznych, od największych wpłat na giełdy. Jeden klik zamienia wiersz w sprawę.
- **Wynik także bez KYC.** Portfel łączymy z kontem przez podpis sprawdzany matematycznie, a adresy depozytowe giełd rozpoznajemy po przepływie środków.
- **Pełna dokumentacja.** Każde źródło z adresem, czasem i skrótem treści; raport rozdziela fakty, obliczenia i wnioski.

Narzędzie wskazuje podmiot, który zna właściciela, przygotowuje projekt zapytania i podaje wartość do wyjaśnienia w złotych.

## Co zostało zrobione i cel projektu

Zrobione i działające:

- pełny scenariusz na danych syntetycznych (trzy fikcyjne serwisy i eksplorator łańcucha bloków) oraz na danych publicznych z internetu;
- Wskaźnik Pewności z paragonem, cztery reguły wykluczeń, limit tożsamości, strona reguł z możliwością zmiany;
- wykrywanie adresów w tekście, w adresach celowo ukrytych, w kodach QR na zdjęciach i w podpisanych wiadomościach; Bitcoin, Ethereum (także sieć Base), Tron;
- wskaźniki wyjścia do walut tradycyjnych, rozpoznawanie adresów depozytowych giełd, szacunek w złotych po kursach NBP;
- rejestr 4 500 portfeli z przeglądem wpłat na giełdy; lista spraw ze stanami; analizy cykliczne z porównaniem wyników; podmiana adresu na profilu w czasie;
- raport PDF, magazyn dowodów z łańcuchem skrótów, dziennik czynności;
- 220 testów automatycznych, w tym scenariusze akceptacyjne.

Cel: narzędzie gotowe do testów KAS na dodatkowym materiale. Dalsze kroki: logowanie i role, kolejne źródła i sieci (każde to jedna implementacja interfejsu), praca na własnym węźle i własnym indeksie w środowisku KAS.

## Film

Link: [do uzupełnienia po nagraniu]

## Strona

https://github.com/zMako/olcys

## Instrukcje, jak otworzyć projekt

Wymagany Node.js 20.19 lub nowszy.

```bash
git clone https://github.com/zMako/olcys && cd olcys
npm install
npm test          # 220 testów
npm run world     # terminal 1: środowisko syntetyczne
npm run api       # terminal 2: API na porcie 4000
npm run web       # terminal 3: interfejs na http://localhost:5173
```

W interfejsie: wpisać `szklane_domy` w polu „Nowa analiza” i kliknąć „Analizuj”. Analiza trwa kilka sekund i kończy się na podsumowaniu; dalej kroki 1–6.

Tryb „Internet, na żywo” działa bez kluczy dla większości źródeł. Opcjonalnie w pliku `.env`: `ALCHEMY_KEY` (historia sieci Base), `GITHUB_TOKEN` (wyższy limit zapytań). Model językowy: `ollama pull SpeakLeash/bielik-11b-v3.1-instruct:Q8_0`; bez niego narzędzie działa, niedostępne jest tylko opracowanie sprawy przez model.

Rejestr portfeli jest budowany lokalnie poleceniami `npm run corpus -- …` i nie jest częścią repozytorium (to dane prawdziwych osób).

---

# Scenariusz filmu (do 3 minut)

Przed nagraniem: włączyć „Zakryj dane osobowe” w lewym panelu; obie sprawy na danych publicznych mają być już przeanalizowane (otwierają się od razu na podsumowaniu).

| Czas | Ekran | Co powiedzieć |
|---|---|---|
| 0:00–0:20 | Rejestr | „KAS nie wie dziś, od kogo zacząć. Z samych danych publicznych zbudowaliśmy rejestr 4 500 polskich portfeli. 818 z nich wysłało środki na giełdy. Każdy wiersz to gotowa sprawa.” |
| 0:20–0:55 | Nowa analiza `szklane_domy` (środowisko testowe), graf i dziennik | „Wpisuję jeden nick. Narzędzie przeszukuje źródła, znajduje konta i adresy, a dziennik mówi wprost: adres przypisany i dlaczego, adres odrzucony i dlaczego.” |
| 0:55–1:35 | Krok 3, kliknięcie adresu, paragon; potem filtr „Odrzucone” | „To najważniejszy ekran: Wskaźnik Pewności. Własny profil 85, ten sam adres w drugim serwisie plus 15, razem 100%. Każda pozycja ma źródło. Wynik liczą wyłącznie reguły, nie model AI. Adres giełdy i smart kontrakt dostają 0% z powodem.” |
| 1:35–2:00 | Sprawa z poświadczeniem giełdy: podsumowanie | „Prawdziwe dane. Dwa portfele potwierdzone podpisem, Coinbase publicznie poświadcza klienta zweryfikowanego w Polsce, 21 wpłat na giełdy, 287 tysięcy złotych do wyjaśnienia.” |
| 2:00–2:35 | Sprawa bez KYC: podsumowanie, krok 3 (paragon z podpisem), krok 4 (giełdy) | „A teraz portfel, którego żadna giełda nie poświadcza. Portfel sam podpisał, że należy do tego konta; podpis sprawdzamy matematycznie, wynik 100%. Adresy depozytowe Bybit i MEXC rozpoznajemy po przepływie środków. 97 tysięcy złotych, a giełda wie, kto jest klientem.” |
| 2:35–3:00 | Krok 5 (projekt zapytania), krok 6 (magazyn dowodów), strona Reguły | „Na końcu projekt zapytania do giełdy, raport PDF i magazyn dowodów: każde źródło z adresem, czasem i skrótem treści. Reguły są jawne i można je zmienić. Całość działa lokalnie.” |

# Finał na żywo (5 minut)

1. Rejestr: lista, filtr „z wpłatą na giełdę”, „Analizuj” przy wierszu (pokazać tylko start).
2. `szklane_domy` od zera (usunąć sprawę wcześniej): graf, dziennik, podsumowanie.
3. Krok 3: paragon adresu z podpisem, potem odrzucony adres giełdy.
4. Sprawa bez KYC (zapisana): podsumowanie, paragon, giełdy w kroku 4.
5. Krok 5: projekt zapytania; krok 6: magazyn dowodów; strona Reguły: zmiana jednej wartości.

Analiza na danych publicznych trwa około dwóch minut, dlatego obie sprawy mają być uruchomione wcześniej.
