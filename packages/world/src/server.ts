import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { foldDiacritics, parseAddress } from '@olcys/core';
import { NBP, PRICES, priceUsd } from './fixtures';
import type { ForumUser, LedgerTx, Site, World } from './model';
import { adPhoto } from './photo';

export type AnySite = Site | 'explorer' | 'rates' | 'archive';
export type Bases = Record<AnySite, string>;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const multiline = (s: string) => esc(s).replace(/\n/g, '<br>\n');
const day = (iso: string) => iso.slice(0, 10);
const fold = (s: string) => foldDiacritics(s).toLowerCase();
const digits = (s: string) => s.replace(/\D/g, '');

const THEMES: Record<AnySite, { name: string; color: string; font: string }> = {
  explorer: { name: 'BlokSkan — eksplorator łańcuchów bloków', color: '#0b5d4b', font: 'ui-monospace, Menlo, monospace' },
  rates: { name: 'Kursy — kopia danych NBP i kursy rynkowe', color: '#5a2d6b', font: 'system-ui, sans-serif' },
  archive: { name: 'Archiwum Sieci — dawne wersje stron', color: '#6b4a1e', font: 'Georgia, serif' },
  forum: { name: 'BitRozmowy — forum kryptowalutowe', color: '#1f4e79', font: 'Verdana, sans-serif' },
  code: { name: 'Kodownia — repozytoria kodu', color: '#24292f', font: 'system-ui, sans-serif' },
  ads: { name: 'Bazarek P2P — ogłoszenia', color: '#b3541e', font: 'Georgia, serif' },
};

function page(site: AnySite, title: string, body: string): string {
  const t = THEMES[site];
  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><title>${esc(title)} — ${esc(t.name)}</title>
<style>
body{font-family:${t.font};margin:0;background:#f4f4f2;color:#222}
.synthetic{background:#fff3cd;border-bottom:1px solid #e0c060;padding:4px 16px;font-size:12px}
header.site{background:${t.color};color:#fff;padding:12px 16px}header.site a{color:#fff;text-decoration:none;font-weight:bold}
header.site form{display:inline;margin-left:24px}main{max-width:860px;margin:16px auto;padding:0 16px}
article,section,.card{background:#fff;border:1px solid #ddd;border-radius:4px;padding:12px;margin:10px 0}
blockquote{border-left:3px solid #999;margin:6px 0;padding:4px 10px;background:#f0f0f0}
.signature{border-top:1px dashed #bbb;margin-top:8px;padding-top:6px;font-size:12px;color:#555}
time,.meta{color:#666;font-size:12px}pre{white-space:pre-wrap}
</style></head><body>
<div class="synthetic">DANE SYNTETYCZNE — środowisko testowe OŁCyŚ. Osoby, konta i treści są fikcyjne.</div>
<header class="site"><a href="/">${esc(t.name)}</a><form action="/szukaj"><input name="q" placeholder="Szukaj"><button>Szukaj</button></form></header>
<main>${body}</main></body></html>`;
}

type Handler = (path: string, query: URLSearchParams) => string | { json: unknown; status?: number } | { binary: Buffer; type: string } | null;

/** With `asOf`, the forum is rendered as it stood at that moment — used by the web archive. */
function forumHandler(world: World, bases: Bases, asOf?: string): Handler {
  return (path, query) => {
    // Read on every request: the forum accepts new posts and signature changes while it runs.
    const users = world.forum.users.filter((u) => !asOf || u.joinedAt <= asOf);
    const threads = world.forum.threads.map((t) => ({ ...t, posts: t.posts.filter((p) => !asOf || p.at <= asOf) })).filter((t) => t.posts.length);
    const sigOf = (u?: ForumUser) => (asOf ? u?.signatureHistory.filter((h) => h.from <= asOf) : u?.signatureHistory)?.at(-1)?.text;
    const signature = (handle: string) => sigOf(users.find((u) => u.handle === handle));
    return forumPage(path, query, { users, threads, sigOf, signature, bases, live: !asOf });
  };
}

interface ForumView {
  users: ForumUser[];
  threads: World['forum']['threads'];
  sigOf(u?: ForumUser): string | undefined;
  signature(handle: string): string | undefined;
  bases: Bases;
  /** False for archived copies, which cannot be written to. */
  live: boolean;
}

function forumPage(path: string, query: URLSearchParams, { users, threads, sigOf, signature, bases, live }: ForumView): ReturnType<Handler> {
  {
    if (path === '/') {
      const items = threads
        .map((t) => `<li class="thread"><a href="/watek/${t.id}">${esc(t.title)}</a> <span class="meta">dział: <span class="board">${esc(t.board)}</span>, postów: ${t.posts.length}</span></li>`)
        .join('\n');
      return page('forum', 'Wątki', `<h1>Wątki</h1><ul class="threads">${items}</ul>`);
    }

    let m = path.match(/^\/watek\/(\d+)$/);
    if (m) {
      const t = threads.find((x) => x.id === Number(m![1]));
      if (!t) return null;
      const posts = t.posts
        .map((p) => {
          const sig = signature(p.author);
          return `<article class="post" id="post-${p.id}" data-post-id="${p.id}">
<header><a class="author" href="/uzytkownik/${esc(p.author)}">${esc(p.author)}</a> <time datetime="${p.at}">${day(p.at)}</time></header>
${p.quote ? `<blockquote data-author="${esc(p.quote.author)}"><cite>${esc(p.quote.author)} napisał(a):</cite><p>${multiline(p.quote.text)}</p></blockquote>` : ''}
<div class="post-body">${multiline(p.text)}</div>
${sig ? `<div class="signature">${esc(sig)}</div>` : ''}
</article>`;
        })
        .join('\n');
      return page('forum', t.title, `<h1 class="thread-title">${esc(t.title)}</h1><p class="meta">Dział: <span class="board-name">${esc(t.board)}</span></p>${posts}${live ? `
<section class="reply"><h2>Odpowiedz w wątku</h2>
<form method="post" action="/watek/${t.id}/odpowiedz">
<p><label>Nick<br><input name="nick" required maxlength="30" autocomplete="off"></label></p>
<p><label>Treść<br><textarea name="tresc" required maxlength="2000" rows="4" style="width:100%"></textarea></label></p>
<button>Wyślij odpowiedź</button> <span class="meta">Środowisko testowe: można pisać pod dowolnym nickiem.</span>
</form></section>` : ''}`);
    }

    m = path.match(/^\/uzytkownik\/([^/]+)$/);
    if (m) {
      const u = users.find((x) => x.handle === decodeURIComponent(m![1]));
      if (!u) return null;
      const sig = sigOf(u);
      const own = threads.flatMap((t) => t.posts.filter((p) => p.author === u.handle).map((p) => ({ t, p })));
      return page('forum', u.handle, `<section class="profile">
<h1 class="handle">${esc(u.handle)}</h1>
<dl>
${u.displayName ? `<dt>Imię i nazwisko</dt><dd class="display-name">${esc(u.displayName)}</dd>` : ''}
${u.location ? `<dt>Miejscowość</dt><dd class="location">${esc(u.location)}</dd>` : ''}
<dt>Na forum od</dt><dd><time class="joined" datetime="${u.joinedAt}">${day(u.joinedAt)}</time></dd>
${u.website ? `<dt>Strona</dt><dd><a class="website" href="${esc(bases[u.website.site] + u.website.path)}">${esc(bases[u.website.site] + u.website.path)}</a></dd>` : ''}
</dl>
${sig ? `<h2>Sygnatura</h2><div class="signature">${esc(sig)}</div>` : ''}
</section>
<section><h2>Posty użytkownika</h2><ul class="user-posts">
${own.map(({ t, p }) => `<li><a href="/watek/${t.id}#post-${p.id}">${esc(t.title)}</a> <time datetime="${p.at}">${day(p.at)}</time></li>`).join('\n')}
</ul></section>${live ? `
<section class="reply"><h2>Zmień sygnaturę</h2>
<form method="post" action="/uzytkownik/${esc(encodeURIComponent(u.handle))}/sygnatura">
<p><label>Nowa sygnatura<br><input name="tresc" required maxlength="300" style="width:100%" autocomplete="off"></label></p>
<button>Zapisz sygnaturę</button>
</form></section>` : ''}`);
    }

    if (path === '/szukaj') {
      const raw = (query.get('q') ?? '').trim();
      const q = fold(raw);
      if (!q) return page('forum', 'Szukaj', '<p>Podaj frazę.</p>');
      const hitUsers = users.filter((u) => fold(u.handle).includes(q) || (u.displayName && fold(u.displayName).includes(q)) || sigOf(u)?.toLowerCase().includes(q));
      const hitPosts = threads
        .flatMap((t) => t.posts.filter((p) => fold(p.text).includes(q) || (p.quote && fold(p.quote.text).includes(q))).map((p) => ({ t, p })))
        .slice(0, 50);
      return page('forum', `Szukaj: ${raw}`, `<h1>Wyniki dla „${esc(raw)}”</h1><ul class="results">
${hitUsers.map((u) => `<li class="result-user"><a href="/uzytkownik/${esc(u.handle)}">${esc(u.handle)}</a>${u.displayName ? ` <span class="display-name">${esc(u.displayName)}</span>` : ''}</li>`).join('\n')}
${hitPosts.map(({ t, p }) => `<li class="result-post"><a href="/watek/${t.id}#post-${p.id}">${esc(t.title)}</a> <span class="meta">autor: ${esc(p.author)}</span></li>`).join('\n')}
</ul>`);
    }
    return null;
  }
}

/** Writing to the forum: a reply in a thread, or a new signature. The test environment has no accounts, so anyone can post under any nick. */
function forumWrite(world: World): (path: string, form: URLSearchParams) => string | null {
  const clean = (v: string | null, max: number) => (v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
  return (path, form) => {
    const now = new Date().toISOString();
    let m = path.match(/^\/watek\/(\d+)\/odpowiedz$/);
    if (m) {
      const t = world.forum.threads.find((x) => x.id === Number(m![1]));
      const nick = clean(form.get('nick'), 30).replace(/[^\p{L}\p{N}_.-]/gu, '');
      const text = clean(form.get('tresc'), 2000);
      if (!t || !nick || !text) return null;
      if (!world.forum.users.some((u) => u.handle === nick)) world.forum.users.push({ handle: nick, personaId: 'visitor', joinedAt: now, signatureHistory: [] });
      const id = Math.max(0, ...world.forum.threads.flatMap((x) => x.posts.map((p) => p.id))) + 1;
      t.posts.push({ id, author: nick, at: now, text });
      return `/watek/${t.id}#post-${id}`;
    }
    m = path.match(/^\/uzytkownik\/([^/]+)\/sygnatura$/);
    if (m) {
      const u = world.forum.users.find((x) => x.handle === decodeURIComponent(m![1]));
      const text = clean(form.get('tresc'), 300);
      if (!u || !text) return null;
      u.signatureHistory.push({ from: now, text });
      return `/uzytkownik/${encodeURIComponent(u.handle)}`;
    }
    return null;
  };
}

function codeHandler(world: World, bases: Bases): Handler {
  const { users, repos } = world.code;
  const readmeText = (u: (typeof users)[number]) => u.readme.map((l) => `${l.text} ${l.href ?? ''}`).join('\n');

  return (path, query) => {
    if (path === '/') {
      return page('code', 'Użytkownicy', `<h1>Użytkownicy</h1><ul>${users.map((u) => `<li><a href="/${esc(u.handle)}">${esc(u.handle)}</a></li>`).join('')}</ul>`);
    }
    if (path === '/szukaj') {
      const raw = (query.get('q') ?? '').trim();
      const q = fold(raw);
      if (!q) return page('code', 'Szukaj', '<p>Podaj frazę.</p>');
      const hitUsers = users.filter((u) => fold(u.handle).includes(q) || (u.name && fold(u.name).includes(q)) || u.email?.toLowerCase() === q || fold(readmeText(u)).includes(q));
      const hitRepos = repos.filter((r) => fold(r.name).includes(q) || fold(r.readme).includes(q));
      return page('code', `Szukaj: ${raw}`, `<h1>Wyniki dla „${esc(raw)}”</h1><ul class="results">
${hitUsers.map((u) => `<li class="result-user"><a href="/${esc(u.handle)}">${esc(u.handle)}</a>${u.name ? ` <span class="name">${esc(u.name)}</span>` : ''}</li>`).join('\n')}
${hitRepos.map((r) => `<li class="result-repo"><a href="/${esc(r.owner)}/${esc(r.name)}">${esc(r.owner)}/${esc(r.name)}</a></li>`).join('\n')}
</ul>`);
    }
    let m = path.match(/^\/([^/]+)$/);
    if (m) {
      const u = users.find((x) => x.handle === decodeURIComponent(m![1]));
      if (!u) return null;
      const own = repos.filter((r) => r.owner === u.handle);
      return page('code', u.handle, `<section class="profile">
<h1 class="handle">${esc(u.handle)}</h1>
${u.name ? `<p class="name">${esc(u.name)}</p>` : ''}
<p class="bio">${esc(u.bio)}</p>
${u.location ? `<p class="location">${esc(u.location)}</p>` : ''}
${u.email ? `<p><a class="email" href="mailto:${esc(u.email)}">${esc(u.email)}</a></p>` : ''}
<ul class="links">${u.links.map((l) => `<li><a href="${esc(bases[l.site] + l.path)}">${esc(l.label)}</a></li>`).join('')}</ul>
</section>
<section class="readme"><h2>README</h2>
${u.readme.map((l) => (l.href ? `<p><a href="${esc(l.href)}">${esc(l.text)}</a></p>` : `<p>${esc(l.text)}</p>`)).join('\n')}
</section>
<section><h2>Repozytoria</h2><ul class="repos">${own.map((r) => `<li><a href="/${esc(r.owner)}/${esc(r.name)}">${esc(r.name)}</a></li>`).join('')}</ul></section>`);
    }
    m = path.match(/^\/([^/]+)\/([^/]+)$/);
    if (m) {
      const r = repos.find((x) => x.owner === decodeURIComponent(m![1]) && x.name === decodeURIComponent(m![2]));
      if (!r) return null;
      return page('code', `${r.owner}/${r.name}`, `<section class="repo">
<h1><a class="owner" href="/${esc(r.owner)}">${esc(r.owner)}</a> / <span class="repo-name">${esc(r.name)}</span></h1>
<p class="description">${esc(r.description)}</p>
<p class="meta">Ostatnia zmiana: <time class="updated" datetime="${r.updatedAt}">${day(r.updatedAt)}</time></p>
<pre class="readme">${esc(r.readme)}</pre></section>`);
    }
    return null;
  };
}

function adsHandler(world: World): Handler {
  const { sellers, ads } = world.ads;
  return (path, query) => {
    if (path === '/') {
      return page('ads', 'Ogłoszenia', `<h1>Najnowsze ogłoszenia</h1><ul class="ads">${ads.map((a) => `<li><a href="/oferta/${a.id}">${esc(a.title)}</a> <span class="meta">${esc(a.city)}</span></li>`).join('')}</ul>`);
    }
    if (path === '/szukaj') {
      const raw = (query.get('q') ?? '').trim();
      const q = fold(raw);
      if (!q) return page('ads', 'Szukaj', '<p>Podaj frazę.</p>');
      const qd = digits(raw);
      const phoneHit = (phone: string) => qd.length >= 9 && digits(phone).endsWith(qd.slice(-9));
      const hitSellers = sellers.filter((s) => fold(s.handle).includes(q) || s.email?.toLowerCase() === q || phoneHit(s.phone));
      const hitAds = ads.filter((a) => fold(a.title).includes(q) || fold(a.body).includes(q) || phoneHit(a.body)).slice(0, 50);
      return page('ads', `Szukaj: ${raw}`, `<h1>Wyniki dla „${esc(raw)}”</h1><ul class="results">
${hitSellers.map((s) => `<li class="result-seller"><a href="/sprzedawca/${esc(s.handle)}">${esc(s.handle)}</a></li>`).join('\n')}
${hitAds.map((a) => `<li class="result-ad"><a href="/oferta/${a.id}">${esc(a.title)}</a></li>`).join('\n')}
</ul>`);
    }
    let m = path.match(/^\/oferta\/(\d+)$/);
    if (m) {
      const a = ads.find((x) => x.id === Number(m![1]));
      if (!a) return null;
      return page('ads', a.title, `<article class="ad" data-ad-id="${a.id}">
<h1 class="ad-title">${esc(a.title)}</h1>
<p class="meta">Cena: <span class="price">${esc(a.price)}</span> · <span class="city">${esc(a.city)}</span> · <time datetime="${a.at}">${day(a.at)}</time></p>
<p><img class="ad-photo" src="/zdjecia/${a.id}.png" alt="Zdjęcie przedmiotu" width="480" height="360"></p>
<div class="ad-body">${multiline(a.body)}</div>
<p>Sprzedający: <a class="seller" href="/sprzedawca/${esc(a.seller)}">${esc(a.seller)}</a></p></article>`);
    }
    m = path.match(/^\/zdjecia\/(\d+)\.png$/);
    if (m) {
      const a = ads.find((x) => x.id === Number(m![1]));
      return a ? { binary: adPhoto(a.id, a.qr), type: 'image/png' } : null;
    }
    m = path.match(/^\/sprzedawca\/([^/]+)$/);
    if (m) {
      const s = sellers.find((x) => x.handle === decodeURIComponent(m![1]));
      if (!s) return null;
      const own = ads.filter((a) => a.seller === s.handle);
      return page('ads', s.handle, `<section class="profile">
<h1 class="handle">${esc(s.handle)}</h1>
<p>Telefon: <span class="phone">${esc(s.phone)}</span></p>
${s.email ? `<p><a class="email" href="mailto:${esc(s.email)}">${esc(s.email)}</a></p>` : ''}
<p>Miasto: <span class="city">${esc(s.city)}</span> · na Bazarku od <time class="since" datetime="${s.since}">${day(s.since)}</time></p>
</section>
<section><h2>Ogłoszenia sprzedającego</h2><ul class="seller-ads">${own.map((a) => `<li><a href="/oferta/${a.id}">${esc(a.title)}</a></li>`).join('')}</ul></section>`);
    }
    return null;
  };
}

function explorerHandler(world: World): Handler {
  const { entities, txs, codes } = world.chain;
  const labels = new Map(entities.map((e) => [e.address, e]));
  const index = new Map<string, LedgerTx[]>();
  for (const t of txs) {
    for (const a of new Set(t.legs.flatMap((l) => [l.from, l.to]))) {
      if (!index.has(a)) index.set(a, []);
      index.get(a)!.push(t);
    }
  }
  const account = (input: string) => {
    const parsed = parseAddress(input);
    if (!parsed) return null;
    const a = parsed.address;
    const list = index.get(a) ?? [];
    const balance = new Map<string, number>();
    for (const t of list) {
      for (const l of t.legs) {
        if (l.to === a) balance.set(l.asset, (balance.get(l.asset) ?? 0) + l.amount);
        if (l.from === a) balance.set(l.asset, (balance.get(l.asset) ?? 0) - l.amount);
      }
    }
    const e = labels.get(a);
    return {
      address: a,
      chain: parsed.chain,
      label: e ? { name: e.name, category: e.category } : null,
      code: codes[a] ?? '0x',
      txCount: list.length,
      firstSeen: list[0]?.at ?? null,
      lastSeen: list.at(-1)?.at ?? null,
      balances: [...balance].filter(([, v]) => v > 1e-9).map(([asset, amount]) => ({ asset, amount: Math.round(amount * 1e8) / 1e8 })),
    };
  };
  const transfers = (a: string) =>
    (index.get(a) ?? []).flatMap((t) => {
      // Bitcoin: a transaction can be funded by several addresses at once. Whoever signs for all of them controls all of them.
      const funders = t.chain === 'bitcoin' ? [...new Set(t.legs.map((l) => l.from))] : [];
      return t.legs
        .filter((l) => l.from === a || l.to === a)
        .map((l) => ({ txHash: t.hash, at: t.at, ...l, ...(l.from === a && funders.length > 1 ? { coInputs: funders.filter((f) => f !== a) } : {}) }));
    });
  const link = (a: string) => `<a href="/address/${esc(a)}">${esc(labels.get(a)?.name ?? a.slice(0, 10) + '…' + a.slice(-6))}</a>`;

  return (path, query) => {
    // On-chain names: the address a name points to, and the name an address has claimed.
    const byName = path.match(/^\/api\/v1\/name\/([^/]+)$/);
    const byAddress = path.match(/^\/api\/v1\/address\/([^/]+)\/name$/);
    if (byName || byAddress) {
      const key = decodeURIComponent((byName ?? byAddress)![1]);
      const n = world.chain.names.find((x) => (byName ? x.name === key.toLowerCase() : x.address === key));
      return n ? { json: { name: n.name, address: n.address, records: n.records } } : { json: { error: 'no_name' }, status: 404 };
    }
    let m = path.match(/^\/api\/v1\/address\/([^/]+)(\/transfers)?$/);
    if (m) {
      const acc = account(decodeURIComponent(m[1]));
      if (!acc) return { json: { error: 'invalid_address' }, status: 400 };
      return m[2] ? { json: { address: acc.address, chain: acc.chain, transfers: transfers(acc.address) } } : { json: acc };
    }
    if (path === '/szukaj') path = `/address/${(query.get('q') ?? '').trim()}`;
    m = path.match(/^\/address\/([^/]+)$/);
    if (m) {
      const acc = account(decodeURIComponent(m[1]));
      if (!acc) return null;
      const rows = transfers(acc.address)
        .map((t) => `<tr><td><time datetime="${t.at}">${t.at.slice(0, 16).replace('T', ' ')}</time></td><td>${t.from === acc.address ? 'wychodzący' : 'przychodzący'}</td><td>${link(t.from === acc.address ? t.to : t.from)}</td><td style="text-align:right">${t.amount} ${esc(t.asset)}</td><td class="meta">${esc(t.txHash.slice(0, 14))}…</td></tr>`)
        .join('\n');
      return page('explorer', acc.address, `<section><h1 style="font-size:15px;word-break:break-all">${esc(acc.address)}</h1>
<p>Sieć: ${esc(acc.chain)} · Etykieta: <strong class="label">${acc.label ? `${esc(acc.label.name)} [${esc(acc.label.category)}]` : 'brak'}</strong> · Kod: ${acc.code === '0x' ? 'brak (zwykły adres)' : esc(acc.code.slice(0, 24)) + '…'}</p>
<p>Transakcji: ${acc.txCount} · Saldo: ${acc.balances.map((b) => `${b.amount} ${esc(b.asset)}`).join(', ') || '0'}</p></section>
<section><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th align="left">Czas (UTC)</th><th align="left">Kierunek</th><th align="left">Kontrahent</th><th align="right">Kwota</th><th align="left">Tx</th></tr></thead><tbody>${rows}</tbody></table></section>`);
    }
    if (path === '/') {
      return page('explorer', 'Oznaczone adresy', `<h1>Oznaczone adresy</h1><ul>${entities.map((e) => `<li>${link(e.address)} <span class="meta">${esc(e.chain)} · ${esc(e.category)}</span></li>`).join('')}</ul>`);
    }
    return null;
  };
}

/**
 * Reference rates for the offline environment. The first route answers exactly like the public NBP API
 * (api.nbp.pl) and serves real NBP tables, so the same connector works against either.
 */
function ratesHandler(): Handler {
  return (path) => {
    let m = path.match(/^\/api\/exchangerates\/rates\/a\/usd\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/?$/i);
    if (m) {
      const rates = NBP.rates.filter((r) => r.d >= m![1] && r.d <= m![2]).map((r) => ({ no: r.no, effectiveDate: r.d, mid: r.mid }));
      if (!rates.length) return { json: { error: '404 NotFound - Not Found - Brak danych' }, status: 404 };
      return { json: { table: 'A', currency: 'dolar amerykański', code: 'USD', rates } };
    }
    m = path.match(/^\/prices\/v1\/([A-Za-z0-9]+)\/usd\/(\d{4}-\d{2}-\d{2})$/);
    if (m) {
      const usd = priceUsd(m[1].toUpperCase(), m[2]);
      if (usd === undefined) return { json: { error: 'no_price' }, status: 404 };
      return { json: { asset: m[1].toUpperCase(), date: m[2], usd, source: PRICES.source } };
    }
    if (path === '/') {
      return page('rates', 'Kursy', `<h1>Kursy referencyjne</h1>
<p>Kopia publicznych danych do pracy bez dostępu do Internetu.</p>
<ul><li>Kurs średni USD/PLN: ${esc(NBP.source)} — ${NBP.rates.length} tabel, ${NBP.rates[0].d} do ${NBP.rates[NBP.rates.length - 1].d}.</li>
<li>Kursy BTC i ETH w USD: ${esc(PRICES.source)}.</li></ul>`);
    }
    return null;
  };
}

/**
 * A web archive of the forum: which past versions of a profile exist, and the pages as they were.
 * Shaped like public web archives (a capture index plus /web/<timestamp>/<original address>).
 */
function archiveHandler(world: World, bases: Bases): Handler {
  const stamp = (iso: string) => iso.replace(/[-:T]/g, '').slice(0, 14);
  const pathOf = (url: string) => (url.startsWith(bases.forum) ? url.slice(bases.forum.length).replace(/[?#].*$/, '') : undefined);
  return (path, query) => {
    if (path === '/cdx') {
      const url = query.get('url') ?? '';
      const captures = (world.archive[pathOf(url) ?? ''] ?? []).map((at) => ({ timestamp: stamp(at), at, url: `${bases.archive}/web/${stamp(at)}/${url}` }));
      return { json: { url, captures } };
    }
    const m = path.match(/^\/web\/(\d{14})\/(.+)$/);
    if (m) {
      const original = pathOf(m[2]);
      const at = (world.archive[original ?? ''] ?? []).find((x) => stamp(x) === m[1]);
      if (!original || !at) return null;
      const html = forumHandler(world, bases, at)(original, new URLSearchParams());
      if (typeof html !== 'string') return null;
      return html.replace('<main>', `<div style="background:#f3e7cf;border-bottom:1px solid #c9a86a;padding:6px 16px;font:13px Georgia,serif">Archiwum Sieci: kopia strony ${esc(m[2])} zapisana ${at.slice(0, 10)} o ${at.slice(11, 16)} UTC.</div><main>`);
    }
    if (path === '/') {
      const rows = Object.entries(world.archive).map(([p, list]) => `<li>${esc(bases.forum + p)} — ${list.map((at) => `<a href="/web/${stamp(at)}/${esc(bases.forum + p)}">${at.slice(0, 10)}</a>`).join(', ')}</li>`);
      return page('archive', 'Zapisane strony', `<h1>Zapisane strony</h1><ul>${rows.join('')}</ul>`);
    }
    return null;
  };
}

export interface RunningWorld {
  bases: Bases;
  close(): Promise<void>;
}

/** Serves the three sites, each on its own port so that they are separate origins. */
export async function startWorld(
  world: World,
  ports: Partial<Record<AnySite, number>> = {},
  host = '127.0.0.1',
  /** Host name the sites use in links to each other; must match what the connectors are configured with. */
  publicHost = host,
): Promise<RunningWorld> {
  const bases = {} as Bases;
  const handlers: Record<AnySite, Handler> = {
    forum: forumHandler(world, bases),
    code: codeHandler(world, bases),
    ads: adsHandler(world),
    explorer: explorerHandler(world),
    rates: ratesHandler(),
    archive: archiveHandler(world, bases),
  };
  const write = forumWrite(world);
  const servers: Server[] = [];
  for (const site of ['forum', 'code', 'ads', 'explorer', 'rates', 'archive'] as AnySite[]) {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'POST' && site === 'forum') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          if (body.length < 16_384) body += chunk.toString('utf8');
        });
        req.on('end', () => {
          const to = write(url.pathname, new URLSearchParams(body));
          if (!to) res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Nie udało się zapisać.');
          else res.writeHead(303, { location: to }).end();
        });
        return;
      }
      let html: ReturnType<Handler> = null;
      try {
        html = req.method === 'GET' ? handlers[site](url.pathname, url.searchParams) : null;
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err));
        return;
      }
      if (html === null) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(page(site, 'Nie znaleziono', '<h1>404 — nie znaleziono</h1>'));
        return;
      }
      if (typeof html !== 'string' && 'binary' in html) {
        res.writeHead(200, { 'content-type': html.type }).end(html.binary);
        return;
      }
      if (typeof html !== 'string') {
        res.writeHead(html.status ?? 200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(html.json));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(ports[site] ?? 0, host, resolve);
    });
    const port = (server.address() as AddressInfo).port;
    bases[site] = `http://${publicHost}:${port}`;
    servers.push(server);
  }
  return {
    bases,
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
