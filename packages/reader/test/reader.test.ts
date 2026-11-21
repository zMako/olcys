import { describe, expect, it } from 'vitest';
import { StatementReader, crossValidate, findTemplates, firstJson, lexicalSigns, looksAppGenerated, metricsOf, narrate, ownWords, predict, readWithLlm, softmax, templateSignature, trainSoftmax, type Embedder, type LlmClient } from '../src';

/** Three well-separated clouds of points: any sane classifier must tell them apart. */
function clouds(perClass = 40) {
  const centres = [[2, 0, 0], [0, 2, 0], [0, 0, 2]];
  const X: number[][] = [];
  const y: number[] = [];
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.8;
  centres.forEach((c, k) => {
    for (let i = 0; i < perClass; i++) {
      X.push(c.map((v) => v + noise()));
      y.push(k);
    }
  });
  return { X, y };
}

describe('classifier', () => {
  it('softmax sums to one and survives large numbers', () => {
    const p = softmax([1000, 1001, 999]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(p[1]).toBeGreaterThan(p[0]);
  });

  it('learns separable data and predicts unseen points', () => {
    const { X, y } = clouds();
    const model = trainSoftmax(X, y, ['a', 'b', 'c']);
    expect(predict(model, [2.1, 0.1, -0.1]).indexOf(Math.max(...predict(model, [2.1, 0.1, -0.1])))).toBe(0);
    expect(predict(model, [0, 0.2, 1.9])[2]).toBeGreaterThan(0.8);
    const cv = crossValidate(X, y, ['a', 'b', 'c'], 5);
    expect(metricsOf(y, cv.predicted, ['a', 'b', 'c']).every((m) => m.f1 > 0.95)).toBe(true);
  });

  it('does not let a rare label drown: class weights keep its recall', () => {
    const { X, y } = clouds(60);
    // keep only 6 examples of the last class
    const keep = y.map((c, i) => (c !== 2 || i % 10 === 0 ? i : -1)).filter((i) => i >= 0);
    const [Xs, ys] = [keep.map((i) => X[i]), keep.map((i) => y[i])];
    const cv = crossValidate(Xs, ys, ['a', 'b', 'rare'], 3);
    expect(metricsOf(ys, cv.predicted, ['a', 'b', 'rare'])[2].recall).toBeGreaterThanOrEqual(0.8);
  });

  it('measures precision and recall', () => {
    expect(metricsOf([0, 0, 1, 1], [0, 1, 1, 1], ['x', 'y'])).toEqual([
      { label: 'x', examples: 2, precision: 1, recall: 0.5, f1: 0.667 },
      { label: 'y', examples: 2, precision: 0.667, recall: 1, f1: 0.8 },
    ]);
  });
});

describe('reading posts', () => {
  // A stand-in embedder: three numbers that say whether the text speaks of selling, of buying, or of neither.
  const embedder: Embedder = {
    name: 'test', dim: 3,
    embed: async (texts) => texts.map((t) => Float32Array.from([/sprzeda|sold/i.test(t) ? 2 : 0, /kupi|bought/i.test(t) ? 2 : 0, /sprzeda|sold|kupi|bought/i.test(t) ? 0 : 2])),
  };
  const model = trainSoftmax(clouds().X, clouds().y, ['własne', 'własne2', 'inne']);

  it('lets through only posts about the author\'s own transactions, strongest first', async () => {
    const reader = new StatementReader(model, embedder);
    const posts = [
      { id: '1', text: 'gm wszystkim, miłego dnia' },
      { id: '2', text: 'Sprzedałem wczoraj 2 ETH po 14 tysięcy', at: '2025-03-02T10:00:00.000Z', url: 'https://example.test/2' },
      { id: '3', text: 'Kupiłem trochę BTC na dołku' },
      { id: '4', text: 'sold' }, // too short to mean anything
    ];
    const r = await reader.triage([...posts, { id: '5', text: 'I just minted a Quackers NFT! Mint yours 👇' }]);
    expect(r).toMatchObject({ posts: 5, generated: 1, read: 3 }); // the app-written post is set aside, the too-short one is not read
    expect(r.statements.map((s) => s.id).sort()).toEqual(['2', '3']);
    expect(r.statements[0].relevance).toBeGreaterThan(0.8);
    expect(r.statements.find((s) => s.id === '2')).toMatchObject({ text: posts[1].text, at: posts[1].at, url: posts[1].url });
    expect(await reader.classify([])).toEqual([]);
  });

  it('second reading: takes the model\'s JSON out of whatever it wraps it in, and distrusts anything else', async () => {
    const llm = (answer: string): LlmClient => ({ name: 'test-model', complete: async () => answer });
    const good = await readWithLlm(llm('Oto odpowiedź:\n```json\n{"dotyczy_autora": true, "rodzaj": "zbycie", "aktywo": "eth", "ilosc": "2", "kwota": 28000, "waluta": "pln", "kiedy": "wczoraj", "uzasadnienie": "Autor pisze, że sprzedał 2 ETH."}\n```'), { text: 'Sprzedałem wczoraj 2 ETH' });
    expect(good).toEqual({ concernsAuthor: true, kind: 'zbycie', asset: 'ETH', amount: 2, fiatAmount: 28000, fiatCurrency: 'PLN', when: 'wczoraj', reason: 'Autor pisze, że sprzedał 2 ETH.', model: 'test-model' });
    // the model says it is someone else's transaction: not the author's, whatever kind it names
    expect(await readWithLlm(llm('{"dotyczy_autora": false, "rodzaj": "zbycie", "aktywo": null, "ilosc": null, "kwota": null, "waluta": "null", "kiedy": null, "uzasadnienie": "Mowa o koledze."}'), { text: 'x' })).toMatchObject({ concernsAuthor: false, asset: undefined, fiatCurrency: undefined });
    expect(await readWithLlm(llm('{"dotyczy_autora": true, "rodzaj": "cokolwiek"}'), { text: 'x' })).toMatchObject({ concernsAuthor: false, kind: 'inne' });
    // an offer is the author's own even if the model says otherwise; an address or an object is not an asset
    expect(await readWithLlm(llm('{"dotyczy_autora": false, "rodzaj": "oferta", "aktywo": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", "waluta": "złote"}'), { text: 'x' })).toMatchObject({ concernsAuthor: true, kind: 'oferta', asset: undefined, fiatCurrency: undefined });
    expect(await readWithLlm(llm('Nie wiem.'), { text: 'x' })).toBeUndefined();
    expect(firstJson('tekst {"a": {"b": "} w napisie"}} dalej')).toEqual({ a: { b: '} w napisie' } });
    expect(firstJson('{zepsute')).toBeUndefined();
  });

  it('the narrative is asked for from the facts alone', async () => {
    let seen = { system: '', user: '' };
    const llm: LlmClient = { name: 't', complete: async (system, user) => ((seen = { system, user }), 'Podsumowanie.') };
    expect(await narrate(llm, 'Fakty: adres X, wynik 100%.')).toBe('Podsumowanie.');
    expect(seen.system).toContain('WYŁĄCZNIE z podanych faktów');
    expect(seen.system).toContain('Nie wypowiadasz się o prawie ani o podatku');
    expect(seen.user).toBe('Fakty: adres X, wynik 100%.');
  });
});

describe('posts written by apps', () => {
  it('recognises share messages by their wording', () => {
    for (const t of ['I just minted a Quackers NFT on Legend of Base!', '🎉 Just claimed 100 $TYSM on Day 1 🔥', 'Minted Genesis Origin', 'Claiming my airdrop and crediting @x', 'I won 5 $DEGEN. Claim yours 👇', 'Check out my Base Punkz #298!']) {
      expect(looksAppGenerated(t), t).toBe(true);
    }
    for (const t of ['Sprzedałem wczoraj 2 ETH po 14 tysięcy', 'bought some eth yesterday, feeling good', 'u mnie połowa dropa poszła z dymem', 'Minted. Not sure why I keep doing this to myself.']) {
      expect(looksAppGenerated(t), t).toBe(false);
    }
  });

  it('learns templates from repetition: across authors, or by one author', () => {
    expect(templateSignature('Got 4 $degen Check your scores → https://x.test')).toBe('got # $t check');
    const posts = [
      ...['a', 'b', 'c'].map((author) => ({ author, text: `Super result today ${author.length}00 $DEGEN wow` })),
      ...[1, 2, 3].map((n) => ({ author: 'd', text: `gm from the farm number ${n}` })),
      { author: 'e', text: 'Kupiłem dziś trochę ETH na dołku' },
    ];
    expect([...findTemplates(posts)].sort()).toEqual(['gm from the farm', 'super result today #']);
    const { own, generated } = ownWords(posts);
    expect(own.map((p) => p.author)).toEqual(['e']);
    expect(generated).toHaveLength(6);
    // an opening learned from a larger corpus is recognised in a single account's posts too
    expect(ownWords([{ author: 'z', text: 'Super result today 500 $DEGEN' }], new Set(['super result today #'])).generated).toHaveLength(1);
  });
});

describe('lexical signs', () => {
  it('finds an asset, the first person and a transaction verb in Polish and English', () => {
    expect(lexicalSigns('Sprzedałem wczoraj 2 ETH po 14 tysięcy')).toEqual({ asset: true, firstPerson: true, verb: true });
    expect(lexicalSigns('I bought some $DEGEN and gonna DCA')).toEqual({ asset: true, firstPerson: true, verb: true });
    expect(lexicalSigns('Miałeś rację, mam ~7k za 300 tokenów')).toEqual({ asset: true, firstPerson: true, verb: true });
    expect(lexicalSigns('Bitcoin rośnie, rynek się budzi')).toEqual({ asset: true, firstPerson: false, verb: false });
    expect(lexicalSigns('Dzień dobry wszystkim')).toEqual({ asset: false, firstPerson: false, verb: false });
  });
});
