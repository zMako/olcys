import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { predict, type LinearModel } from './classifier';
import { sharedEmbedder, type Embedder } from './embed';
import { firstJson, type LlmClient } from './llm';
import { withSigns } from './lexical';
import { ownWords } from './templates';

/** What a post says about the author's own crypto. "inne" is everything that says nothing of the kind. */
export const KINDS = ['inne', 'zbycie', 'nabycie', 'przychod', 'stan', 'oferta'] as const;
export type StatementKind = (typeof KINDS)[number];

export const KIND_PL: Record<StatementKind, string> = {
  inne: 'bez związku',
  zbycie: 'zbycie: sprzedaż, wypłata, zapłata kryptowalutą',
  nabycie: 'nabycie',
  przychod: 'przychód: airdrop, nagroda, zapłata',
  stan: 'stan posiadania',
  oferta: 'oferta kupna lub sprzedaży',
};

export interface Post {
  id: string;
  text: string;
  at?: string;
  url?: string;
}

export interface Classified {
  id: string;
  /** Probability that the post is the author speaking about their own crypto (0–1). */
  relevance: number;
}

/** What the language model found when it read the post in full. */
export interface ReadDetail {
  concernsAuthor: boolean;
  kind: StatementKind;
  asset?: string;
  amount?: number;
  fiatAmount?: number;
  fiatCurrency?: string;
  when?: string;
  reason: string;
  /** Which model read it. */
  model: string;
}

export interface Statement extends Classified {
  text: string;
  at?: string;
  url?: string;
  /** Filled in when the language model has read the post. */
  detail?: ReadDetail;
}

/** What became of a person's posts on the way through the reader. */
export interface ReadingSummary {
  posts: number;
  /** Set aside as written by an app or copied word for word. */
  generated: number;
  /** Read by the classifier. */
  read: number;
  statements: Statement[];
}

export const DEFAULT_MODEL_PATH = fileURLToPath(new URL('../model/statements.json', import.meta.url));

/**
 * First reader: fast and cheap. Posts written by apps are set aside; every remaining post is turned into an
 * embedding and scored by the trained classifier; only the few that look like the author speaking about their
 * own transactions go on to the language model.
 */
export class StatementReader {
  private readonly templates: ReadonlySet<string>;

  constructor(readonly model: LinearModel, private readonly embedder: Embedder) {
    this.templates = new Set((model.meta?.templates as string[] | undefined) ?? []);
  }

  static async load(path = DEFAULT_MODEL_PATH, embedder?: Embedder): Promise<StatementReader | undefined> {
    if (!existsSync(path)) return undefined;
    return new StatementReader(JSON.parse(readFileSync(path, 'utf8')) as LinearModel, embedder ?? (await sharedEmbedder()));
  }

  async classify(posts: Post[]): Promise<Classified[]> {
    if (!posts.length) return [];
    const vectors = await this.embedder.embed(posts.map((p) => p.text));
    const none = this.model.labels.indexOf('inne');
    const lexical = this.model.dim > this.embedder.dim; // a model trained with the lexical signs expects them
    return posts.map((p, i) => ({ id: p.id, relevance: Math.round((1 - predict(this.model, lexical ? withSigns(vectors[i], p.text) : vectors[i])[none]) * 1000) / 1000 }));
  }

  /** The posts worth a closer look, most relevant first, with a count of what was set aside on the way. */
  async triage(posts: Post[], opts: { minRelevance?: number; limit?: number; author?: string } = {}): Promise<ReadingSummary> {
    const { own, generated } = ownWords(posts.map((p) => ({ ...p, author: opts.author ?? 'x' })), this.templates);
    const readable = own.filter((p) => p.text.trim().length >= 12);
    const byId = new Map(readable.map((p) => [p.id, p]));
    const statements = (await this.classify(readable))
      .filter((c) => c.relevance >= (opts.minRelevance ?? (this.model.meta?.threshold as number | undefined) ?? 0.5))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, opts.limit ?? 12)
      .map((c) => {
        const p = byId.get(c.id)!;
        return { ...c, text: p.text, at: p.at, url: p.url };
      });
    return { posts: posts.length, generated: generated.length, read: readable.length, statements };
  }
}

const SYSTEM = `Jesteś analitykiem. Czytasz jeden publiczny wpis z sieci społecznościowej (po polsku lub po angielsku) i ustalasz, co autor mówi o WŁASNYCH transakcjach kryptowalutowych.
Rodzaje:
- zbycie: autor sam sprzedał kryptowalutę lub NFT, wypłacił środki, zamienił na walutę tradycyjną lub stablecoina, zapłacił kryptowalutą;
- nabycie: autor sam kupił kryptowalutę lub NFT;
- przychod: autor sam otrzymał kryptowalutę bez kupowania (airdrop, kopanie, staking, zapłata, napiwek, nagroda, zrealizowany zysk);
- stan: autor stwierdza, że posiada konkretne aktywo lub kwotę;
- oferta: autor proponuje innym kupno, sprzedaż lub wymianę kryptowalut;
- inne: reklamy i zachęty, wiadomości, opinie, pytania, plany i przypuszczenia, cudze transakcje.
Sprzedaż sprzętu lub usług z płatnością w kryptowalucie to "oferta". Ogłoszenie o sprzedaży lub skupie kryptowalut to "oferta", nawet jeśli autor nie podaje kwoty.
W razie wątpliwości wybierz "inne". Odpowiedz WYŁĄCZNIE jednym obiektem JSON o polach:
- "dotyczy_autora": true, jeśli wpis mówi o kryptowalutach lub ofercie samego autora; false, jeśli o cudzych;
- "rodzaj": jedno z: zbycie, nabycie, przychod, stan, oferta, inne;
- "aktywo": symbol kryptowaluty wymienionej we wpisie (np. "BTC", "ETH", "USDT") albo null — nigdy adres ani nazwa przedmiotu;
- "ilosc": liczba jednostek kryptowaluty podana we wpisie albo null;
- "kwota": kwota w walucie tradycyjnej podana we wpisie albo null;
- "waluta": "PLN", "USD" lub "EUR" albo null;
- "kiedy": określenie czasu przepisane z wpisu (np. "wczoraj", "w marcu") albo null, jeśli wpis go nie podaje;
- "uzasadnienie": jedno krótkie zdanie po polsku.`;

/**
 * Second reader: the language model reads one post in full and either confirms what the classifier suspected,
 * with the asset, amount and date it found, or says the post is about something else.
 */
export async function readWithLlm(llm: LlmClient, post: Pick<Post, 'text' | 'at'>): Promise<ReadDetail | undefined> {
  const answer = await llm.complete(SYSTEM, `${post.at ? `Data wpisu: ${post.at.slice(0, 10)}\n` : ''}Wpis: ${post.text.slice(0, 1500)}`);
  const j = firstJson<Record<string, unknown>>(answer);
  if (!j) return undefined;
  const kind = (KINDS as readonly string[]).includes(String(j.rodzaj)) ? (j.rodzaj as StatementKind) : 'inne';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : undefined);
  // What the model returns is checked, not trusted: an asset must look like a ticker, a currency like a currency.
  const asset = str(j.aktywo)?.toUpperCase().replace(/^\$/, '');
  const currency = str(j.waluta)?.toUpperCase();
  return {
    // an offer is the author's by its nature, whatever the model says about "own transactions"
    concernsAuthor: kind !== 'inne' && (j.dotyczy_autora === true || kind === 'oferta'), kind,
    asset: asset && /^[A-Z0-9]{2,10}$/.test(asset) ? asset : undefined, amount: num(j.ilosc), fiatAmount: num(j.kwota),
    fiatCurrency: currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined, when: str(j.kiedy), reason: str(j.uzasadnienie) ?? '', model: llm.name,
  };
}

/** A short description of the case for the report, written by the model strictly from the facts it is given. */
export async function narrate(llm: LlmClient, facts: string): Promise<string> {
  return llm.complete(
    [
      'Jesteś analitykiem Krajowej Administracji Skarbowej. Piszesz zwięzłe podsumowanie sprawy: 5–7 zdań po polsku, ciągłym tekstem, bez wypunktowań.',
      'Zasady, których nie wolno złamać:',
      '1. Korzystasz WYŁĄCZNIE z podanych faktów. Niczego nie dodajesz i nie zgadujesz.',
      '2. Liczby, procenty, kwoty i prawdopodobieństwa przepisujesz dosłownie. Nie interpretujesz statystyk własnymi słowami.',
      '3. Nie wypowiadasz się o prawie ani o podatku: nie piszesz, czy coś podlega opodatkowaniu, ani ile wynosi podatek. O kwotach piszesz wyłącznie, że są „wartością do wyjaśnienia”.',
      '4. Wyraźnie odróżniasz to, co ustalono na podstawie źródeł, od tego, co jest wnioskiem do weryfikacji.',
      '5. Nie formułujesz zarzutów ani ocen osoby.',
    ].join('\n'),
    facts,
  );
}
