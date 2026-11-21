import { BUNDLED_LABELS, type Chain, type LabelCategory } from '@olcys/core';

export const MALE_NAMES = ['Adam', 'Bartosz', 'Cezary', 'Dawid', 'Filip', 'Grzegorz', 'Hubert', 'Igor', 'Jakub', 'Kamil', 'Łukasz', 'Marek', 'Norbert', 'Oskar', 'Paweł', 'Rafał', 'Szymon', 'Tomasz', 'Wojciech', 'Zbigniew'];
export const FEMALE_NAMES = ['Agata', 'Barbara', 'Celina', 'Dorota', 'Ewa', 'Helena', 'Izabela', 'Joanna', 'Karolina', 'Lena', 'Magdalena', 'Natalia', 'Olga', 'Patrycja', 'Renata', 'Sylwia', 'Teresa', 'Urszula', 'Weronika', 'Zofia'];

/**
 * Surnames of characters from classic Polish literature ([male form, female form]),
 * chosen so that every persona reads as obviously fictional.
 */
export const SURNAMES: [string, string][] = [
  ['Wokulski', 'Wokulska'], ['Rzecki', 'Rzecka'], ['Łęcki', 'Łęcka'], ['Kmicic', 'Kmicic'], ['Wołodyjowski', 'Wołodyjowska'],
  ['Skrzetuski', 'Skrzetuska'], ['Zagłoba', 'Zagłoba'], ['Soplica', 'Soplica'], ['Horeszko', 'Horeszko'], ['Borowiecki', 'Borowiecka'],
  ['Judym', 'Judym'], ['Ziembiewicz', 'Ziembiewicz'], ['Połaniecki', 'Połaniecka'], ['Boryna', 'Boryna'], ['Dulski', 'Dulska'],
  ['Ochocki', 'Ochocka'], ['Szuman', 'Szuman'], ['Mincel', 'Mincel'], ['Stawski', 'Stawska'], ['Podbipięta', 'Podbipięta'],
  ['Kurcewicz', 'Kurcewicz'], ['Billewicz', 'Billewicz'], ['Niechcic', 'Niechcic'], ['Korczyński', 'Korczyńska'], ['Bohatyrowicz', 'Bohatyrowicz'],
  ['Raptusiewicz', 'Raptusiewicz'], ['Milczek', 'Milczek'], ['Papkin', 'Papkin'], ['Dyndalski', 'Dyndalska'], ['Rębajło', 'Rębajło'],
  ['Dobrzyński', 'Dobrzyńska'], ['Karusek', 'Karusek'], ['Tolibowski', 'Tolibowska'], ['Ostrzeński', 'Ostrzeńska'], ['Krzeszowski', 'Krzeszowska'],
];

export const CITIES = ['Warszawa', 'Kraków', 'Bydgoszcz', 'Gdańsk', 'Wrocław', 'Poznań', 'Łódź', 'Radom', 'Lublin', 'Katowice', 'Toruń', 'Szczecin'];

export const HANDLE_A = ['krypto', 'hodl', 'satoshi', 'blok', 'moon', 'lambo', 'byk', 'wilk', 'kopacz', 'defi', 'btc', 'eth', 'node', 'hash', 'zimny', 'szybki', 'cichy', 'stary'];
export const HANDLE_B = ['wilk', 'lis', 'mistrz', 'janusz', 'trader', 'gornik', 'whale', 'pl', 'max', 'dev', 'ninja', 'kowal', 'orzel', 'zubr', 'rekin', 'portfel'];

export const BOARDS = ['Giełdy i handel', 'Portfele i bezpieczeństwo', 'Kopanie', 'Podatki i prawo', 'Hyde Park'];
export const GIVEAWAY_BOARD = 'Konkursy i rozdawnictwa';

export const THREAD_TITLES = [
  'Jaki portfel sprzętowy na początek?', 'Opłaty transakcyjne znowu w kosmos', 'Giełda zablokowała mi wypłatę — co robić?',
  'Rozliczenie PIT-38 za kryptowaluty', 'Kopanie w 2026 — czy to się jeszcze opłaca?', 'Stablecoiny: USDT czy USDC?',
  'P2P bez giełdy — wasze doświadczenia', 'Lightning Network w praktyce', 'Halving a cena — dyskusja',
  'Najlepszy kantor krypto w Polsce?', 'Zimny portfel z odzysku', 'Staking ETH — pytania początkującego',
  'Karta krypto do płatności w sklepie', 'Jak bezpiecznie sprzedać większą ilość BTC?', 'Bot tradingowy — ktoś testował?',
];

export const GIVEAWAY_TITLES = [
  'KONKURS: rozdajemy 0.01 BTC — wpisz swój adres!',
  'Rozdawnictwo USDT na urodziny forum — zostaw adres w komentarzu',
];

export const FILLER_POSTS = [
  'Zgadzam się z przedmówcą, też miałem podobny problem i pomogła dopiero zmiana portfela.',
  'Moim zdaniem nie warto się spieszyć. Rynek i tak zrobi swoje.',
  'Ktoś ma sprawdzone źródło na ten temat? Wolę nie wierzyć plotkom.',
  'U mnie wypłata szła trzy dni, ale w końcu doszła. Cierpliwości.',
  'Pamiętajcie o kopii zapasowej seeda, najlepiej na papierze i w dwóch miejscach.',
  'Opłaty są teraz śmieszne w porównaniu z tym, co było rok temu.',
  'Księgowa mówi, że liczy się moment wymiany na złotówki, ale lepiej dopytać w urzędzie.',
  'Sprzedałem trochę w zeszłym miesiącu i poszło bez problemu.',
  'Trzymam od 2020 i nie zamierzam ruszać. HODL.',
  'Polecam najpierw zrobić przelew testowy na małą kwotę.',
  'Ten kantor ma dobry kurs, ale trzeba się umawiać dzień wcześniej.',
  'Nie rozumiem, czemu ludzie trzymają wszystko na giełdzie. Nie twoje klucze, nie twoje monety.',
  'Dzięki za poradnik, bardzo pomocny dla początkujących.',
  'Ja bym poczekał do następnego kwartału i zobaczył, co się stanie.',
  'Blokady kont to ostatnio plaga, dlatego wolę handel bezpośredni.',
];

export const ADDRESS_DROPS = [
  'Jak ktoś chce się odwdzięczyć za poradnik, to mój adres: {a}',
  'Wyślij na {a}, odeślę złotówki po pierwszym potwierdzeniu.',
  'Rozliczmy się bezpośrednio, mój portfel to {a} — daj znać, jak pójdzie.',
  'Przyjmuję wpłaty tutaj: {a}. Kwotę ustalimy na priv.',
];

export const SPLIT_DROPS = [
  'Podaję adres w kawałkach, bo boty zbierają: {a} (usuń spacje).',
  'Mój portfel, tylko sklej sobie: {a}',
];

export const GIVEAWAY_POSTS = ['Biorę udział! {a}', 'Zgłaszam się: {a}', '{a} — powodzenia wszystkim!', 'Może tym razem się uda. {a}'];

export const AD_TEMPLATES: { title: string; body: string; price: string }[] = [
  { title: 'Sprzedam koparkę Antminer S19', body: 'Sprawna, po przeglądzie. Możliwa płatność w krypto.\nAdres do wpłaty: {a}\nKontakt tel. {phone}.', price: '3 200 zł' },
  { title: 'Sprzedam kartę RTX 3080 po kopaniu', body: 'Karta w dobrym stanie, wymienione pasty. Wolę krypto niż przelew.\nPortfel: {a}\nTel. {phone}', price: '1 900 zł' },
  { title: 'Sprzedam USDT za PLN — BLIK / gotówka', body: 'Sprzedaję USDT od ręki, rozliczenie BLIK-iem albo gotówką w mieście {city}.\nPrzy zakupie ode mnie zwrot nadwyżki na adres: {a}\nDzwoń: {phone}', price: 'kurs do uzgodnienia' },
  { title: 'Kupię BTC za gotówkę', body: 'Kupię większą ilość BTC, spotkanie osobiste w mieście {city}.\nMój adres do odbioru: {a}\nTelefon {phone}', price: 'do uzgodnienia' },
  { title: 'Ledger Nano X — nowy, zafoliowany', body: 'Nieużywany, z paragonem. Przyjmę zapłatę w kryptowalucie.\nAdres: {a}\nKontakt: {phone}', price: '450 zł' },
  { title: 'Laptop gamingowy, przyjmę krypto', body: 'Stan bardzo dobry. Płatność przelewem lub krypto na adres {a}.\nTel. {phone}', price: '4 100 zł' },
];

export const DEV_BIOS = [
  'Programista backend, po godzinach węzeł Lightning.',
  'Piszę narzędzia do rozliczeń i analizy łańcucha bloków.',
  'Open source, Rust i kryptografia stosowana.',
  'Automatyzuję nudne rzeczy. Czasem kopię.',
];

export const REPO_NAMES = ['krypto-rozliczenia', 'portfel-cli', 'bot-cenowy', 'analiza-lancucha', 'skrypty-kopacza', 'lightning-narzedzia'];

export type EntityKind = LabelCategory;

export interface KnownEntity {
  address: string;
  chain: Chain;
  name: string;
  kind: EntityKind;
  /** Sentence a user might write when pasting this address. */
  post: string;
}

const POSTS = [
  'Wypłacam zawsze przez Binance, ich hot wallet to {a} — widać go w każdym explorerze.',
  'Zobaczcie, ile BTC leży na zimnym portfelu Binance: {a}',
  'Depozyt poszedł na portfel Krakena {a} i czekam na zaksięgowanie.',
  'Uwaga, prawdziwy kontrakt USDT to {a}, nie dajcie się nabrać na podróbki.',
  'Kontrakt USDC dla pewności: {a}',
  'Wymieniam przez router Uniswapa {a}, bez żadnej rejestracji.',
  'USDT na Tronie ma kontrakt {a} — sprawdzajcie przed wysyłką.',
  'Oficjalna zbiórka dla Ukrainy: {a} — warto wesprzeć.',
  'Dla prywatności ludzie przepuszczają środki przez {a}, ale to ryzykowne.',
];

/**
 * Real, publicly labelled mainnet addresses of institutions and contracts. Synthetic users
 * paste them into posts so the false-positive filter has realistic material to reject.
 */
export const KNOWN_ENTITIES: KnownEntity[] = BUNDLED_LABELS.map((l, i) => ({
  address: l.address,
  chain: l.chain,
  name: l.name,
  kind: l.category,
  post: POSTS[i],
}));
