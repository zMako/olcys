import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNbpConnector, createWorldArchiveConnector, createWorldChainConnector, createWorldConnectors, createWorldNameService, createWorldPriceConnector } from '@olcys/connectors';
import { makeIdentifier } from '@olcys/core';
import { Store, migrate, openDatabase, type SqlExecutor } from '@olcys/db';
import { beginRun, type RunSummary, type StoredRunEvent } from '@olcys/engine';
import { HERO_ID, generateWorld, startWorld, type RunningWorld } from '@olcys/world';
import { GraphView } from '../src/graph/Graph';
import { addressId, buildGraph, layoutGraph } from '../src/graph/model';
import { Panel } from '../src/Panel';
import { describe as describeStep } from '../src/pl';

const world = generateWorld();
const hero = world.personas.find((p) => p.id === HERO_ID)!;
let running: RunningWorld;
let db: SqlExecutor;
let events: StoredRunEvent[];
let summary: RunSummary;
let midRunStatus: string;

beforeAll(async () => {
  running = await startWorld(world);
  db = await openDatabase('pglite://memory');
  await migrate(db);
  const store = new Store(db);
  const connectors = createWorldConnectors(running.bases);
  const chain = [createWorldChainConnector(running.bases.explorer)];
  const c = await store.createCase('hero', [makeIdentifier('username', 'szklane_domy')]);
  const rates = createNbpConnector(running.bases.rates, true);
  const prices = createWorldPriceConnector(running.bases.rates);
  const archive = createWorldArchiveConnector(running.bases.archive);
  const run = await beginRun({ store, connectors, chain, rates, prices, archive, names: createWorldNameService(running.bases.explorer), allowlist: [...connectors, ...chain, rates, prices, archive].flatMap((x) => x.descriptor.hosts) }, c.id);
  midRunStatus = (await store.getRun(run.runId))!.status;
  summary = JSON.parse(JSON.stringify(await run.done));
  events = await store.events<StoredRunEvent>(run.runId);
});
afterAll(async () => {
  await running.close();
  await db.close();
});

describe('run events', () => {
  it('are available while the run is still working and form one ordered record', () => {
    expect(midRunStatus).toBe('running');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0].type).toBe('run.started');
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'completed' });
    // every step can be told in a sentence
    for (const e of events) expect(describeStep(e).length).toBeGreaterThan(8);
  });
});

describe('evidence graph', () => {
  it('grows step by step and ends as the full picture of the case', () => {
    const sizes = [10, 40, 80, events.length].map((n) => buildGraph(events, n).nodes.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes[0]).toBeLessThan(sizes[3]);

    const g = buildGraph(events);
    const of = (type: string) => g.nodes.filter((n) => n.type === type);
    expect(of('seed').map((n) => n.title)).toEqual(['szklane_domy']);
    expect(of('account').filter((n) => n.clusterId === 'T1').map((n) => n.title).sort()).toEqual(['SzklaneDomy', 'eth_od_reki', 'nocny_kantor', 'szklane_domy', 'szklanedomy']);
    // the account found through the wallet is tied to the wallet's published address, not to any other account
    expect(g.nodes.find((n) => n.title === 'nocny_kantor')).toMatchObject({ viaWallet: true });
    expect(g.edges.filter((e) => e.kind === 'wallet').map((e) => [e.from, e.to]).sort((a, b) => b[0].localeCompare(a[0]))).toEqual([
      ['acc:bitrozmowy:nocny_kantor', addressId('bitcoin', hero.wallets.find((w) => w.kind === 'btc-segwit')!.address)],
      ['acc:bazarek:eth_od_reki', addressId('ethereum', hero.wallets.find((w) => w.kind === 'eth')!.address)],
    ]);
    expect(g.matches.filter((m) => m.unique)).toHaveLength(3);
    // a score announced early is replaced when later evidence changes it
    expect(g.nodes.find((n) => n.address === hero.wallets.find((w) => w.label === 'sales')!.address)!.link).toMatchObject({ score: 85 });
    expect(of('account').filter((n) => n.clusterLevel === 'name_ambiguous').map((n) => n.title)).toEqual(['czarek_b']);
    expect(of('account').filter((n) => n.thirdParty).length).toBeGreaterThan(2);
    expect(of('address')).toHaveLength(summary.addresses.length);
    expect(of('service').filter((n) => n.cashOut).length).toBe(6);
    // both the Bitcoin wallet and the Ethereum address lead to the same exchange: one node, two addresses
    const exchange = of('service').find((n) => n.title === 'BałtykEx')!;
    expect(exchange.addresses).toHaveLength(2);
    expect(g.edges.filter((e) => e.to === exchange.id).map((e) => e.from.split(':')[1]).sort()).toEqual(['bitcoin', 'ethereum']);
    // one published address turned out to be a wallet of six
    expect(g.nodes.find((n) => n.address === hero.wallets.find((w) => w.kind === 'btc-segwit')!.address)!.walletSize).toBe(6);
    // the address proven by a signed message carries a seal; the profile that swapped its address is marked
    expect(g.nodes.find((n) => n.address === hero.wallets.find((w) => w.kind === 'btc-legacy')!.address)).toMatchObject({ proven: true });
    expect(g.nodes.find((n) => n.id === 'acc:bitrozmowy:szklane_domy')).toMatchObject({ changed: true });
    expect(g.histories).toHaveLength(1);
    const sales = g.nodes.find((n) => n.address === hero.wallets.find((w) => w.label === 'sales')!.address)!;
    expect(g.edges.find((e) => e.to === sales.id)!.label).toBe('kod QR na zdjęciu');
    expect(g.edges.some((e) => e.kind === 'match' && e.label === 'podobny nick')).toBe(true);
    // the estimate closes the picture
    const estimate = g.nodes.find((n) => n.type === 'estimate')!;
    expect(estimate.years!.map((y) => y.year)).toEqual([2024, 2025]);
    expect(estimate.totalPln).toBe(summary.estimate!.totalPln);

    // leads between the subject's accounts, mutual links merged into one
    const leads = g.edges.filter((e) => e.kind === 'lead').map((e) => e.label).sort();
    expect(leads).toEqual(['e-mail', 'nazwisko', 'odnośniki']);
    // scores arrive on the address nodes
    const tron = g.nodes.find((n) => n.id === addressId('tron', hero.wallets.find((w) => w.kind === 'tron')!.address))!;
    expect(tron.link).toMatchObject({ status: 'attributed', score: 83, band: 'very_high' });
    expect(g.edges.filter((e) => e.kind === 'flow' && e.from === tron.id).map((e) => e.label.replace(/\s/g, ' ')).sort()).toEqual(['10 250 USDT', '9800 USDT']);
    expect(g.edges.some((e) => e.kind === 'published' && e.quoteOnly)).toBe(true);
  });

  it('lays out without overlaps and puts rejected addresses below attributed ones', () => {
    const g = buildGraph(events);
    const l = layoutGraph(g);
    for (const col of [0, 1, 2, 3]) {
      const boxes = g.nodes.filter((n) => n.col === col).map((n) => l.boxes.get(n.id)!).sort((a, b) => a.y - b.y);
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].h);
    }
    const y = (status: string) => g.nodes.filter((n) => n.type === 'address' && n.link?.status === status).map((n) => l.boxes.get(n.id)!.y);
    expect(Math.max(...y('attributed'))).toBeLessThan(Math.min(...y('excluded')));
  });

  it('renders the graph and the receipt panel', () => {
    const g = buildGraph(events);
    const svg = renderToStaticMarkup(<GraphView graph={g} layout={layoutGraph(g)} onSelect={() => {}} />);
    for (const text of ['Konta w sieci', 'Osoba, o którą pytano', 'Tylko zbieżność nazwiska, najwyżej 39%', 'Wykluczone: Binance: Hot Wallet 14', 'KartaKrypto']) expect(svg, text).toContain(text);

    const btc = g.nodes.find((n) => n.address === hero.wallets.find((w) => w.kind === 'btc-segwit')!.address)!;
    const panel = renderToStaticMarkup(<Panel node={btc} graph={g} summary={summary} events={events} cursor={events.length} onSelect={() => {}} />);
    for (const text of ['Wskaźnik Pewności', 'Synergia śladów', 'Razem', '100%', 'BitRozmowy', 'fakt źródłowy', 'wniosek do weryfikacji', 'Bramka płatnicza']) expect(panel, text).toContain(text);

    expect(panel).toContain('Adresy tej samej osoby: 6');
    expect(svg).toContain('Do wyjaśnienia');
    expect(svg).toContain('+5 adresów tej osoby');
    expect(svg).toContain('+1 adres tej osoby');

    const estimate = renderToStaticMarkup(<Panel node={g.nodes.find((n) => n.type === 'estimate')} graph={g} summary={summary} events={events} cursor={events.length} onSelect={() => {}} />);
    for (const text of ['Do wyjaśnienia', 'zbycie prawdopodobne', '/A/NBP', 'art. 17 ust. 1f', 'Pominięto']) expect(estimate, text).toContain(text);

    const exchange = renderToStaticMarkup(<Panel node={g.nodes.find((n) => n.title === 'BałtykEx')} graph={g} summary={summary} events={events} cursor={events.length} onSelect={() => {}} />);
    for (const text of ['Kto zna tożsamość klienta', 'Adresat: BałtykEx', 'Podstawa prawna: [do uzupełnienia]', 'Kopiuj projekt zapytania']) expect(exchange, text).toContain(text);

    const qr = renderToStaticMarkup(<Panel node={g.nodes.find((n) => n.address === hero.wallets.find((w) => w.label === 'sales')!.address)} graph={g} summary={summary} events={events} cursor={events.length} onSelect={() => {}} />);
    for (const text of ['Co może podważyć ten wynik', 'Odczytano go z kodu QR na tym zdjęciu', '/snapshots/', 'Adres odczytany z obrazu', 'Adres odczytany ze zdjęcia', 'Wpłata zgodna z ceną z ogłoszenia']) expect(qr, text).toContain(text);
    const overview = renderToStaticMarkup(<Panel graph={g} summary={summary} events={events} cursor={events.length} onSelect={() => {}} />);
    for (const text of ['Znalezione przez łańcuch bloków', 'nocny_kantor', 'Kwoty zgodne z przelewami', '3 200 zł']) expect(overview, text).toContain(text);
    expect(svg).toContain('ten sam portfel');
    expect(svg).toContain('ten sam klient giełdy');
    const profile = renderToStaticMarkup(<Panel node={g.nodes.find((n) => n.id === 'acc:bitrozmowy:szklane_domy')} graph={g} summary={summary} events={events} cursor={events.length} onSelect={() => {}} />);
    for (const text of ['Profil w czasie', 'został na profilu zastąpiony adresem', 'Wersja profilu w czasie']) expect(profile, text).toContain(text);
    expect(svg).toContain('Potwierdzone podpisem');
    expect(svg).toContain('podmienił adres');

    const binance = g.nodes.find((n) => n.label === 'Binance: Hot Wallet 14')!;
    const rejected = renderToStaticMarkup(<Panel node={binance} graph={g} summary={summary} events={events} cursor={events.length} onSelect={() => {}} />);
    expect(rejected).toContain('class="stamp"');
    expect(rejected).toContain('(giełda; źródło: lista wbudowana OŁCyŚ v1)');
  });
});
