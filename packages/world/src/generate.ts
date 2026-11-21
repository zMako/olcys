import { foldDiacritics, signBitcoinMessage, signEthereumMessage } from '@olcys/core';
import {
  ADDRESS_DROPS, AD_TEMPLATES, BOARDS, CITIES, DEV_BIOS, FEMALE_NAMES, FILLER_POSTS, GIVEAWAY_BOARD, GIVEAWAY_POSTS,
  GIVEAWAY_TITLES, HANDLE_A, HANDLE_B, KNOWN_ENTITIES, MALE_NAMES, REPO_NAMES, SPLIT_DROPS, SURNAMES, THREAD_TITLES,
} from './data';
import type { Ad, Archetype, CodeUser, ExpectedBand, ForumPost, ForumThread, ForumUser, Persona, Placement, Site, World } from './model';
import { generateChain } from './chain';
import { Rng } from './rng';
import { makeWallet, type Wallet } from './wallet';

export const WORLD_NOW = '2026-11-01T12:00:00.000Z';

export interface WorldOptions {
  seed?: string;
  /** Number of procedurally generated background personas (the scripted ones are always present). */
  personas?: number;
}

const ARCHETYPES: Archetype[] = ['open_dev', 'p2p_trader', 'forum_talker', 'giveaway_hunter', 'careful', 'fp_poster', 'quoter'];

export const HERO_ID = 'hero';
export const NAMESAKE_ID = 'namesake';

export function generateWorld(opts: WorldOptions = {}): World {
  const seed = opts.seed ?? 'olcys';
  const rng = new Rng(seed);
  // A second stream for content added later, so earlier personas and posts keep their values.
  const rng2 = new Rng(`${seed}|proofs-photos-archive`);
  const now = Date.parse(WORLD_NOW);
  const ago = (minDays: number, maxDays: number) => new Date(now - rng.int(minDays * 24, maxDays * 24) * 3_600_000).toISOString();

  const world: World = {
    seed,
    now: WORLD_NOW,
    personas: [],
    forum: { users: [], threads: [] },
    code: { users: [], repos: [] },
    ads: { sellers: [], ads: [] },
    truth: [],
    chain: { entities: [], txs: [], codes: {}, expected: [], wallets: [], names: [] },
    proofs: [],
    matches: [],
    archive: {},
  };

  let nextThread = 100;
  let nextPost = 1000;
  let nextAd = 5000;
  const usedHandles = new Set<string>();

  const wallet = (p: Persona, kind: Wallet['kind'], label = 'main'): Wallet => {
    const existing = p.wallets.find((w) => w.kind === kind && w.label === label);
    if (existing) return existing;
    const w = makeWallet(`${seed}|${p.id}`, kind, label);
    p.wallets.push(w);
    return w;
  };

  const place = (p: Omit<Placement, 'obfuscated'> & { obfuscated?: boolean }) => world.truth.push({ obfuscated: false, ...p });

  // ---------- forum scaffolding ----------
  const newThread = (board: string, title: string): ForumThread => {
    const t: ForumThread = { id: nextThread++, board, title, posts: [] };
    world.forum.threads.push(t);
    return t;
  };
  const discussionThreads = THREAD_TITLES.map((title, i) => newThread(BOARDS[i % BOARDS.length], title));
  const giveawayThreads = GIVEAWAY_TITLES.map((title) => newThread(GIVEAWAY_BOARD, title));

  const post = (thread: ForumThread, author: string, text: string, quote?: ForumPost['quote'], at = ago(5, 900)): ForumPost => {
    const p: ForumPost = { id: nextPost++, author, at, text, quote };
    thread.posts.push(p);
    return p;
  };
  const postPath = (t: ForumThread, p: ForumPost) => `/watek/${t.id}#post-${p.id}`;

  const forumUser = (p: Persona, extra: Partial<ForumUser> = {}): ForumUser => {
    const u: ForumUser = {
      handle: p.handles.forum!,
      personaId: p.id,
      location: rng.chance(0.6) ? p.city : undefined,
      joinedAt: ago(400, 2200),
      signatureHistory: [],
      ...extra,
    };
    world.forum.users.push(u);
    return u;
  };

  let lastGiveaway: ForumThread | undefined;
  const split = (address: string) => address.match(/.{1,4}/g)!.join(' ');

  // ---------- reusable behaviours ----------
  const dropInDiscussion = (p: Persona, w: Wallet, obfuscate = false) => {
    const t = rng.pick(discussionThreads);
    const text = obfuscate
      ? rng.pick(SPLIT_DROPS).replace('{a}', split(w.address))
      : rng.pick(ADDRESS_DROPS).replace('{a}', w.address);
    const fp = post(t, p.handles.forum!, text);
    place({ address: w.address, chain: w.chain, site: 'forum', path: postPath(t, fp), resourceId: `post:${fp.id}`, where: 'discussion', postedBy: p.id, ownerPersonaId: p.id, obfuscated: obfuscate, expected: 'medium' });
    return fp;
  };

  const enterGiveaway = (p: Persona, w: Wallet) => {
    const t = rng.pick(giveawayThreads);
    lastGiveaway = t;
    const fp = post(t, p.handles.forum!, rng.pick(GIVEAWAY_POSTS).replace('{a}', w.address));
    place({ address: w.address, chain: w.chain, site: 'forum', path: postPath(t, fp), resourceId: `post:${fp.id}`, where: 'giveaway', postedBy: p.id, ownerPersonaId: p.id, expected: 'noise' });
  };

  const pasteEntity = (p: Persona, index: number) => {
    const e = KNOWN_ENTITIES[index % KNOWN_ENTITIES.length];
    const t = rng.pick(discussionThreads);
    const fp = post(t, p.handles.forum!, e.post.replace('{a}', e.address));
    place({ address: e.address, chain: e.chain, site: 'forum', path: postPath(t, fp), resourceId: `post:${fp.id}`, where: 'discussion', postedBy: p.id, ownerPersonaId: null, entity: { name: e.name, kind: e.kind }, expected: 'excluded' });
  };

  const setSignature = (u: ForumUser, p: Persona, w: Wallet, from = u.joinedAt) => {
    const label = w.chain === 'bitcoin' ? 'BTC' : w.chain === 'ethereum' ? 'ETH' : 'TRX';
    u.signatureHistory.push({ from, text: `${label}: ${w.address}` });
    // Only the current signature is visible on the live site.
    world.truth = world.truth.filter((x) => !(x.where === 'signature' && x.postedBy === p.id));
    place({ address: w.address, chain: w.chain, site: 'forum', path: `/uzytkownik/${u.handle}`, resourceId: `user:${u.handle}`, where: 'signature', postedBy: p.id, ownerPersonaId: p.id, expected: 'very_high' });
  };

  const codeUser = (p: Persona, withAddresses: boolean, opts: { name?: boolean; email?: boolean; forumLink?: boolean } = {}): CodeUser => {
    const handle = p.handles.code!;
    const u: CodeUser = {
      handle,
      personaId: p.id,
      name: opts.name ? p.fullName : undefined,
      bio: rng.pick(DEV_BIOS),
      location: p.city,
      email: opts.email ? p.email : undefined,
      links: opts.forumLink && p.handles.forum ? [{ label: 'Forum BitRozmowy', site: 'forum', path: `/uzytkownik/${p.handles.forum}` }] : [],
      readme: [{ text: `Cześć, tu ${handle}. ${rng.pick(DEV_BIOS)}` }],
    };
    if (withAddresses) {
      const btc = wallet(p, 'btc-segwit');
      const eth = wallet(p, 'eth');
      u.readme.push({ text: 'Jeśli moje narzędzia Ci pomogły, możesz postawić mi kawę:' });
      u.readme.push({ text: `BTC: ${btc.address}` });
      u.readme.push({ text: 'ETH: portfel w eksploratorze', href: `https://etherscan.io/address/${eth.address}` });
      for (const w of [btc, eth]) {
        place({ address: w.address, chain: w.chain, site: 'code', path: `/${handle}`, resourceId: `user:${handle}`, where: 'profile', postedBy: p.id, ownerPersonaId: p.id, expected: 'very_high' });
      }
    }
    world.code.users.push(u);
    return u;
  };

  const repo = (p: Persona, name: string, readme: string, placements: { w?: Wallet; entityIndex?: number }[] = []) => {
    const owner = p.handles.code!;
    world.code.repos.push({ owner, name, description: `Projekt ${name}`, readme, updatedAt: ago(10, 700) });
    for (const pl of placements) {
      if (pl.w) {
        place({ address: pl.w.address, chain: pl.w.chain, site: 'code', path: `/${owner}/${name}`, resourceId: `repo:${owner}/${name}`, where: 'repo', postedBy: p.id, ownerPersonaId: p.id, expected: 'very_high' });
      } else if (pl.entityIndex !== undefined) {
        const e = KNOWN_ENTITIES[pl.entityIndex];
        place({ address: e.address, chain: e.chain, site: 'code', path: `/${owner}/${name}`, resourceId: `repo:${owner}/${name}`, where: 'repo', postedBy: p.id, ownerPersonaId: null, entity: { name: e.name, kind: e.kind }, expected: 'excluded' });
      }
    }
  };

  const seller = (p: Persona, showEmail: boolean) => {
    world.ads.sellers.push({ handle: p.handles.ads!, personaId: p.id, phone: p.phone, email: showEmail ? p.email : undefined, city: p.city, since: ago(200, 1500) });
  };

  /** With `qr`, the address is nowhere in the text: it is only in a QR code on the item's photo. */
  const ad = (p: Persona, w: Wallet, template = rng.pick(AD_TEMPLATES), qr = false): Ad => {
    const a: Ad = {
      id: nextAd++,
      seller: p.handles.ads!,
      title: template.title,
      body: template.body.replace('{a}', qr ? 'w kodzie QR na zdjęciu' : w.address).replace('{phone}', p.phone).replace('{city}', p.city),
      price: template.price,
      city: p.city,
      at: ago(3, 400),
      qr: qr ? (w.chain === 'bitcoin' ? `bitcoin:${w.address}` : w.chain === 'ethereum' ? `ethereum:${w.address}` : w.address) : undefined,
    };
    world.ads.ads.push(a);
    place({ address: w.address, chain: w.chain, site: 'ads', path: `/oferta/${a.id}`, resourceId: `ad:${a.id}`, where: 'ad', postedBy: p.id, ownerPersonaId: p.id, viaImage: qr || undefined, expected: 'probable' });
    return a;
  };

  // A thread where people prove their addresses by posting a message signed with the address's key.
  const proofThread = newThread(BOARDS[1], 'Potwierdzanie adresów podpisem — wątek zbiorczy');
  const sign = (w: Wallet, message: string) => (w.chain === 'ethereum' ? signEthereumMessage(message, w.privateKeyHex) : signBitcoinMessage(message, w.privateKeyHex, w.kind === 'btc-legacy' ? 'p2pkh' : 'p2wpkh'));
  const postProof = (p: Persona, w: Wallet, message: string, opts: { armor?: boolean; forge?: boolean; at?: string } = {}) => {
    // A forged proof reuses a genuine signature under a different message.
    const signature = sign(w, opts.forge ? `${message} (inna treść)` : message);
    const text = opts.armor
      ? `Potwierdzam adres podpisem:\n-----BEGIN BITCOIN SIGNED MESSAGE-----\n${message}\n-----BEGIN SIGNATURE-----\n${w.address}\n${signature}\n-----END BITCOIN SIGNED MESSAGE-----`
      : `Wiadomość: ${message}\nAdres: ${w.address}\nPodpis: ${signature}`;
    const fp = post(proofThread, p.handles.forum!, text, undefined, opts.at);
    const namesAccount = message.toLowerCase().includes(p.handles.forum!.toLowerCase());
    world.proofs.push({ personaId: p.id, address: w.address, postId: fp.id, valid: !opts.forge, namesAccount });
    place({ address: w.address, chain: w.chain, site: 'forum', path: postPath(proofThread, fp), resourceId: `post:${fp.id}`, where: 'discussion', postedBy: p.id, ownerPersonaId: p.id, expected: opts.forge ? 'medium' : 'very_high' });
  };

  // ---------- personas ----------
  const emailOf = (fullName: string, n: number) =>
    `${foldDiacritics(fullName).toLowerCase().replace(/\s+/g, '.')}${n ? n : ''}@poczta.test`;
  const phoneOf = () => `+48 ${rng.int(500, 799)} ${rng.int(100, 999)} ${rng.int(100, 999)}`;

  const proceduralPersona = (i: number): Persona => {
    const female = rng.chance(0.4);
    const surname = rng.pick(SURNAMES);
    const fullName = `${rng.pick(female ? FEMALE_NAMES : MALE_NAMES)} ${surname[female ? 1 : 0]}`;
    let base: string;
    do {
      base = `${rng.pick(HANDLE_A)}${rng.chance(0.5) ? '_' : ''}${rng.pick(HANDLE_B)}${rng.chance(0.5) ? rng.int(1, 99) : ''}`;
    } while (usedHandles.has(base));
    usedHandles.add(base);
    const sameEverywhere = rng.chance(0.5);
    return {
      id: `p${String(i).padStart(3, '0')}`,
      fullName,
      city: rng.pick(CITIES),
      email: emailOf(fullName, i),
      phone: phoneOf(),
      archetype: ARCHETYPES[i % ARCHETYPES.length],
      handles: {
        forum: base,
        code: sameEverywhere ? base : base.replace(/_/g, '-'),
        ads: sameEverywhere ? base : base.replace(/_/g, '') + rng.int(80, 99),
      },
      wallets: [],
    };
  };

  // --- the scripted subject of the demo investigation ---
  const hero: Persona = {
    id: HERO_ID,
    fullName: 'Cezary Baryka',
    city: 'Warszawa',
    email: 'cezary.baryka@poczta.test',
    phone: '+48 600 100 200',
    archetype: 'hero',
    handles: { forum: 'szklane_domy', code: 'szklanedomy', ads: 'SzklaneDomy' },
    wallets: [],
  };
  // --- a different person with the same name: must never be merged with the hero ---
  const namesake: Persona = {
    id: NAMESAKE_ID,
    fullName: 'Cezary Baryka',
    city: 'Radom',
    email: 'c.baryka.radom@poczta.test',
    phone: '+48 511 222 333',
    archetype: 'namesake',
    handles: { forum: 'czarek_b' },
    wallets: [],
  };
  for (const h of [...Object.values(hero.handles), ...Object.values(namesake.handles)]) usedHandles.add(h!);

  const background = Array.from({ length: opts.personas ?? 40 }, (_, i) => proceduralPersona(i + 1));
  world.personas.push(hero, namesake, ...background);

  // ---------- background behaviour ----------
  const talkers: Persona[] = [];
  background.forEach((p, i) => {
    const fu = forumUser(p, { displayName: rng.chance(0.25) ? p.fullName : undefined });
    const fillers = rng.int(1, 4);
    for (let k = 0; k < fillers; k++) post(rng.pick(discussionThreads), fu.handle, rng.pick(FILLER_POSTS));

    switch (p.archetype) {
      case 'open_dev': {
        const cu = codeUser(p, true, { name: rng.chance(0.7), email: rng.chance(0.6), forumLink: rng.chance(0.6) });
        if (rng.chance(0.5)) fu.website = { site: 'code', path: `/${cu.handle}` };
        if (rng.chance(0.6)) setSignature(fu, p, wallet(p, 'btc-segwit'));
        const name = rng.pick(REPO_NAMES);
        if (rng.chance(0.5)) {
          repo(p, name, `# ${name}\n\nNarzędzie do pracy z kryptowalutami.\n\nDarowizny: ${wallet(p, 'btc-segwit').address}`, [{ w: wallet(p, 'btc-segwit') }]);
        } else {
          repo(p, name, `# ${name}\n\nIntegracja z routerem Uniswap V2 (${KNOWN_ENTITIES[5].address}) oraz tokenem USDT (${KNOWN_ENTITIES[3].address}).`, [{ entityIndex: 5 }, { entityIndex: 3 }]);
        }
        break;
      }
      case 'p2p_trader': {
        seller(p, rng.chance(0.4));
        const w = wallet(p, rng.chance(0.6) ? 'tron' : 'btc-segwit');
        const n = rng.int(1, 3);
        for (let k = 0; k < n; k++) ad(p, w, undefined, rng2.chance(0.35));
        if (rng.chance(0.5)) dropInDiscussion(p, w);
        break;
      }
      case 'forum_talker': {
        talkers.push(p);
        const w = wallet(p, rng.chance(0.5) ? 'btc-segwit' : 'eth');
        dropInDiscussion(p, w, rng.chance(0.3));
        if (rng.chance(0.4)) dropInDiscussion(p, w);
        break;
      }
      case 'giveaway_hunter': {
        const w = wallet(p, 'eth');
        enterGiveaway(p, w);
        if (rng.chance(0.5)) enterGiveaway(p, wallet(p, 'btc-segwit'));
        break;
      }
      case 'careful': {
        if (rng.chance(0.5)) codeUser(p, false, { name: rng.chance(0.5) });
        break;
      }
      case 'fp_poster': {
        pasteEntity(p, i);
        if (rng.chance(0.5)) pasteEntity(p, i + 4);
        if (rng.chance(0.5)) dropInDiscussion(p, wallet(p, 'eth'));
        break;
      }
      case 'quoter':
        break; // handled below, once all talkers exist
    }
  });

  const quoteSomeone = (p: Persona) => {
    const other = rng.pick(talkers);
    const w = other.wallets[0];
    const t = rng.pick(discussionThreads);
    const fp = post(t, p.handles.forum!, 'Sprawdziłem ten adres w eksploratorze, wygląda w porządku.', { author: other.handles.forum!, text: `mój adres: ${w.address}` });
    place({ address: w.address, chain: w.chain, site: 'forum', path: postPath(t, fp), resourceId: `post:${fp.id}`, where: 'quote', postedBy: p.id, ownerPersonaId: other.id, expected: 'not_attributable' });
  };
  if (talkers.length) for (const p of background.filter((x) => x.archetype === 'quoter')) quoteSomeone(p);

  // ---------- hero ----------
  {
    const btc = wallet(hero, 'btc-segwit');
    const btcOld = wallet(hero, 'btc-legacy', 'old');
    const eth = wallet(hero, 'eth');
    const tron = wallet(hero, 'tron', 'trading');

    const cu = codeUser(hero, true, { name: true, email: true, forumLink: true });
    cu.bio = 'Buduję szklane domy z kodu. Rozliczenia krypto, automatyzacja, Lightning.';
    cu.readme.push({ text: 'Można też po nazwie: szklanedomy.eth' });
    repo(hero, 'krypto-rozliczenia', `# krypto-rozliczenia\n\nSkrypty do liczenia zysków z kryptowalut.\n\nDarowizny: ${btc.address}`, [{ w: btc }]);

    const fu = forumUser(hero, { location: 'Warszawa', joinedAt: '2021-03-14T09:00:00.000Z', website: { site: 'code', path: `/${cu.handle}` } });
    // The signature used to show another wallet — material for the address-swap check.
    fu.signatureHistory.push({ from: '2021-03-14T09:00:00.000Z', text: `BTC: ${btcOld.address}` });
    setSignature(fu, hero, btc, '2025-03-02T18:30:00.000Z');

    post(discussionThreads[6], fu.handle, 'Handluję bezpośrednio od lat i nigdy nie miałem problemu. Giełda jest potrzebna tylko na samym końcu.', undefined, '2025-06-11T10:15:00.000Z');
    const t = discussionThreads[13];
    const splitPost = post(t, fu.handle, `Podaję adres w kawałkach, bo boty zbierają: ${split(tron.address)} (usuń spacje). USDT tylko po sieci Tron.`, undefined, '2025-09-03T20:41:00.000Z');
    place({ address: tron.address, chain: 'tron', site: 'forum', path: postPath(t, splitPost), resourceId: `post:${splitPost.id}`, where: 'discussion', postedBy: hero.id, ownerPersonaId: hero.id, obfuscated: true, expected: 'medium' });

    for (const idx of [0, 3, 5]) pasteEntity(hero, idx);
    enterGiveaway(hero, eth);
    // He later confirms the prize arrived: a stated amount and date that can be matched to a transfer.
    const thanks = post(lastGiveaway!, fu.handle, 'Dzięki, 0,01 ETH doszło wczoraj wieczorem!', undefined, '2025-02-15T08:30:00.000Z');
    world.matches.push({ personaId: hero.id, address: eth.address, path: postPath(lastGiveaway!, thanks), stated: '0,01 ETH' });
    if (talkers.length) quoteSomeone(hero);

    seller(hero, true);
    // This address exists nowhere as text: it is only in the QR code on the photo of the item.
    const sales = wallet(hero, 'btc-segwit', 'sales');
    const rig = ad(hero, sales, AD_TEMPLATES[0], true);
    rig.at = '2025-07-03T18:20:00.000Z';
    world.matches.push({ personaId: hero.id, address: sales.address, path: `/oferta/${rig.id}`, stated: rig.price });
    ad(hero, tron, AD_TEMPLATES[2]);
    // An ad that shows no address at all. A payment worth its price ties it to the same address.
    const card: Ad = {
      id: nextAd++, seller: hero.handles.ads!, title: 'Sprzedam kartę RTX 3080 po kopaniu', price: '1 900 zł', city: hero.city, at: '2025-07-28T09:05:00.000Z',
      body: `Karta w dobrym stanie, wymienione pasty. Wolę krypto niż przelew — adres podam w wiadomości.\nTel. ${hero.phone}`,
    };
    world.ads.ads.push(card);
    world.matches.push({ personaId: hero.id, address: sales.address, path: `/oferta/${card.id}`, stated: card.price });

    // A second forum account he never linked to anything. Only the blockchain ties it to him:
    // it advertises an address that belongs to the same wallet as the address on his profile.
    const altHandle = 'nocny_kantor';
    const hidden = wallet(hero, 'btc-segwit', 'recv3');
    const tronAlt = wallet(hero, 'tron', 'alt');
    const altJoined = '2024-01-22T21:10:00.000Z';
    world.forum.users.push({ handle: altHandle, personaId: hero.id, joinedAt: altJoined, signatureHistory: [{ from: altJoined, text: `Wymiana BTC/USDT od ręki, bez formalności. TRX: ${tronAlt.address}` }] });
    usedHandles.add(altHandle);
    place({ address: tronAlt.address, chain: 'tron', site: 'forum', path: `/uzytkownik/${altHandle}`, resourceId: `user:${altHandle}`, where: 'signature', postedBy: hero.id, ownerPersonaId: hero.id, viaWallet: true, expected: 'very_high' });
    // A third account, on the ad board, tied to him only by the exchange: the address it advertises paid into
    // the same personal deposit address at the exchange as the address on his profile.
    const cold = wallet(hero, 'eth', 'cold');
    const third = 'eth_od_reki';
    world.ads.sellers.push({ handle: third, personaId: hero.id, phone: '+48 730 555 010', city: 'Warszawa', since: '2024-06-02T12:00:00.000Z' });
    const ethAd: Ad = {
      id: nextAd++, seller: third, title: 'Sprzedam ETH za gotówkę, od ręki', price: 'kurs do uzgodnienia', city: 'Warszawa', at: '2025-01-09T19:30:00.000Z',
      body: `Sprzedam większą ilość ETH, spotkanie osobiste. Stan portfela do sprawdzenia: ${cold.address}\nTel. +48 730 555 010`,
    };
    world.ads.ads.push(ethAd);
    usedHandles.add(third);
    place({ address: cold.address, chain: 'ethereum', site: 'ads', path: `/oferta/${ethAd.id}`, resourceId: `ad:${ethAd.id}`, where: 'ad', postedBy: hero.id, ownerPersonaId: hero.id, viaWallet: true, expected: 'very_high' });

    post(discussionThreads[9], altHandle, 'Po co kantor z prowizją, skoro można się rozliczyć bezpośrednio. Pisać na priv.', undefined, '2025-02-03T23:02:00.000Z');
    const offer = post(discussionThreads[6], altHandle, `Skupuję i sprzedaję BTC bez prowizji, rozliczenie gotówką w Warszawie. Wpłaty przyjmuję na: ${hidden.address}`, undefined, '2025-05-10T22:14:00.000Z');
    place({ address: hidden.address, chain: 'bitcoin', site: 'forum', path: postPath(discussionThreads[6], offer), resourceId: `post:${offer.id}`, where: 'discussion', postedBy: hero.id, ownerPersonaId: hero.id, viaWallet: true, expected: 'very_high' });

    // In 2022 he proved his first address with a signed message that names his forum account.
    postProof(hero, btcOld, 'Ja, szklane_domy z forum BitRozmowy, potwierdzam, że to mój adres. 2022-06-01', { armor: true, at: '2022-06-01T19:40:00.000Z' });
    // The archive kept his profile from before and after he replaced the address in his signature.
    world.archive[`/uzytkownik/${fu.handle}`] = ['2022-08-10T10:15:00.000Z', '2023-11-05T08:30:00.000Z', '2024-09-20T10:15:00.000Z', '2025-06-01T12:00:00.000Z'];
    place({ address: btcOld.address, chain: 'bitcoin', site: 'forum', path: `/uzytkownik/${fu.handle}`, resourceId: `user:${fu.handle}`, where: 'signature', postedBy: hero.id, ownerPersonaId: hero.id, archivedOnly: true, expected: 'very_high' });
  }

  // Other signed messages: a genuine one that does not name the account, and a forged one.
  if (talkers[0]) postProof(talkers[0], talkers[0].wallets[0], 'To jest mój portfel, potwierdzam 2024.');
  if (talkers[1]) postProof(talkers[1], talkers[1].wallets[0], `Tu ${talkers[1].handles.forum}, to mój adres.`, { forge: true });

  // Ordinary profiles were captured by the archive too, without any change in them.
  for (const u of world.forum.users) {
    const path = `/uzytkownik/${u.handle}`;
    if (world.archive[path] || !u.signatureHistory.length || !rng2.chance(0.5)) continue;
    const joined = Date.parse(u.joinedAt);
    world.archive[path] = [0.35, 0.8].map((f) => new Date(joined + (now - joined) * f).toISOString());
  }

  // ---------- namesake ----------
  {
    const fu = forumUser(namesake, { displayName: namesake.fullName, location: 'Radom' });
    setSignature(fu, namesake, wallet(namesake, 'btc-segwit'));
    post(discussionThreads[3], fu.handle, 'Rozliczam wszystko co do złotówki, polecam prowadzić arkusz od pierwszej transakcji.');
  }

  for (const t of world.forum.threads) t.posts.sort((a, b) => a.at.localeCompare(b.at));
  world.chain = generateChain(world, HERO_ID);
  return world;
}

/** Which site a placement lives on, for callers that only know base URLs. */
export function placementUrl(p: Placement, bases: Record<Site, string>): string {
  return bases[p.site] + p.path;
}

export function expectedBands(world: World, personaId: string): Map<string, ExpectedBand[]> {
  const out = new Map<string, ExpectedBand[]>();
  for (const p of world.truth.filter((x) => x.postedBy === personaId)) {
    out.set(p.address, [...(out.get(p.address) ?? []), p.expected]);
  }
  return out;
}
