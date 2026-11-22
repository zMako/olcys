import { useEffect, useState } from 'react';
import type { RegisterRow, RegisterStats } from '@olcys/corpus';

const n = (x: number) => x.toLocaleString('pl-PL');
const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');

/** Personal data stays covered until the analyst asks to see it: the first characters are enough to recognise a row. */
const coverAddress = (a: string, show: boolean) => (show ? `${a.slice(0, 10)}…${a.slice(-6)}` : `${a.slice(0, 6)}…••••`);
const coverHandle = (h: string, show: boolean) => (show ? h : `${h.slice(0, 2)}${'•'.repeat(Math.min(6, Math.max(3, h.length - 2)))}`);

interface Page {
  rows: RegisterRow[];
  total: number;
  page: number;
  pages: number;
  size: number;
}
const FILTERS: [string, string][] = [['all', 'wszystkie portfele'], ['cashout', 'z wpłatą na giełdę'], ['account', 'ze znanym kontem publicznym'], ['attested', 'poświadczone jako polskie'], ['binance', 'z tokenem Binance']];

/**
 * The register of Polish wallets built on this machine from public sources. The list comes first — every wallet
 * there is any trace of, the most telling at the top, a page at a time — and the summary after it.
 * A row is a lead: one click starts a full analysis of that wallet.
 */
export function Register({ onAnalyze }: { onAnalyze(address: string): void }) {
  const [stats, setStats] = useState<RegisterStats>();
  const [data, setData] = useState<Page>();
  const [missing, setMissing] = useState(false);
  const [show, setShow] = useState(false);
  const [only, setOnly] = useState('all');
  const [page, setPage] = useState(1);
  const [jump, setJump] = useState('');

  useEffect(() => {
    fetch('/api/register')
      .then((r) => r.json() as Promise<{ available: boolean; stats: RegisterStats }>)
      .then((r) => (r.available ? setStats(r.stats) : setMissing(true)))
      .catch(() => setMissing(true));
  }, []);
  useEffect(() => {
    fetch(`/api/register/wallets?page=${page}&size=20&only=${only}`)
      .then((r) => r.json() as Promise<Page>)
      .then(setData)
      .catch(() => setData({ rows: [], total: 0, page: 1, pages: 1, size: 20 }));
  }, [page, only]);

  if (missing) {
    return (
      <main className="page register">
        <h1>Rejestr polskich portfeli</h1>
        <p>
          Rejestru nie ma na tej maszynie. Buduje się go poleceniami <code>npm run corpus -- attestations</code>, <code>expand</code> i <code>flows</code>; dane zostają lokalnie i nie trafiają do repozytorium.
        </p>
      </main>
    );
  }

  const f = stats?.flows;
  const most = Math.max(1, ...(f?.exchanges ?? []).map((e) => e.wallets));
  const go = (p: number) => data && setPage(Math.min(data.pages, Math.max(1, p)));
  const pager = data && (
    <div className="pager" role="navigation" aria-label="Strony rejestru">
      <button onClick={() => go(1)} disabled={data.page === 1}>
        Pierwsza
      </button>
      <button onClick={() => go(data.page - 1)} disabled={data.page === 1}>
        Poprzednia
      </button>
      <span>
        Strona {n(data.page)} z {n(data.pages)}
      </span>
      <button onClick={() => go(data.page + 1)} disabled={data.page === data.pages}>
        Następna
      </button>
      <button onClick={() => go(data.pages)} disabled={data.page === data.pages}>
        Ostatnia
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (Number(jump) >= 1) go(Math.floor(Number(jump)));
          setJump('');
        }}
      >
        <label>
          Przejdź do strony <input value={jump} onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))} inputMode="numeric" size={4} aria-label="Numer strony" />
        </label>
        <button>Przejdź</button>
      </form>
    </div>
  );

  return (
    <main className="page register">
      <h1>Rejestr polskich portfeli</h1>
      <p className="lede">Każdy portfel, o którym są jakiekolwiek publiczne ślady, że należy do osoby z Polski. Na górze te, które wysłały najwięcej na giełdy. Wiersz jest tropem: „Analizuj” zakłada dla niego sprawę.</p>

      <div className="register-controls">
        <label>
          Pokaż{' '}
          <select
            value={only}
            onChange={(e) => {
              setOnly(e.target.value);
              setPage(1);
            }}
          >
            {FILTERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setShow(!show)} aria-pressed={show}>
          {show ? 'Zakryj dane' : 'Odkryj dane'}
        </button>
        {data && <span className="quiet">Portfeli: {n(data.total)}. Kwoty to ilości aktywów bez przeliczenia; wartość w złotych liczy analiza sprawy.</span>}
      </div>

      <section className="card wide">
        {!data ? (
          <p className="quiet">Wczytywanie…</p>
        ) : !data.rows.length ? (
          <p>Żaden portfel nie spełnia tego warunku. Zmień filtr powyżej.</p>
        ) : (
          <>
            <table className="grid register-table">
              <thead>
                <tr>
                  <th className="num">Lp.</th>
                  <th>Portfel</th>
                  <th>Konto publiczne</th>
                  <th>Kto poświadcza właściciela</th>
                  <th>Giełdy, na które wpłacał</th>
                  <th className="num">Wpłat</th>
                  <th className="num">Stablecoiny</th>
                  <th className="num">ETH</th>
                  <th>Aktywność w sieci Base</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={r.wallet}>
                    <td className="num quiet">{n((data.page - 1) * data.size + i + 1)}</td>
                    <td className="mono">{coverAddress(r.wallet, show)}</td>
                    <td>{r.account ? `${coverHandle(r.account.handle, show)} (${r.account.service})` : <span className="quiet">nie znaleziono</span>}</td>
                    <td>{[r.attested && 'Coinbase: Polska', r.binance && 'Binance'].filter(Boolean).join(', ') || <span className="quiet">nikt</span>}</td>
                    <td>{r.exchanges.length ? r.exchanges.join(', ') : <span className="quiet">nie stwierdzono</span>}</td>
                    <td className="num">{r.deposits ? n(r.deposits) : '—'}</td>
                    <td className="num">{r.stablecoins ? n(Math.round(r.stablecoins)) : '—'}</td>
                    <td className="num">{r.ether ? n(r.ether) : '—'}</td>
                    <td>
                      {r.transfers === undefined ? <span className="quiet">nie odczytano</span> : r.transfers === 0 ? <span className="quiet">brak przelewów</span> : `${n(r.transfers)} przelewów`}
                      {r.firstAt && <div className="quiet">{day(r.firstAt) === day(r.lastAt) ? day(r.firstAt) : `${day(r.firstAt)} – ${day(r.lastAt)}`}</div>}
                    </td>
                    <td>
                      <button onClick={() => onAnalyze(r.wallet)}>Analizuj</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pager}
          </>
        )}
      </section>
      <p className="quiet">
        Wiersz jest tropem, nie ustaleniem. Poświadczenie giełdy mówi, kto zna właściciela portfela, a nie kim on jest; wpłata na giełdę mogła być sprzedażą, ale też przechowaniem. Rejestr powstał wyłącznie z danych publicznych i nie opuszcza tej
        maszyny.
      </p>

      {stats && (
        <>
          <h2>Rejestr w liczbach</h2>
          <p>Zbudowany na tej maszynie z dwóch publicznych źródeł: poświadczeń giełdy Coinbase („klient zweryfikowany w Polsce”) oraz kont publicznych, które same wskazały swoje portfele i podpisały to kluczem portfela.</p>
          <dl className="figures">
            <div><dt>portfeli w rejestrze</dt><dd>{n(stats.wallets)}</dd></div>
            <div><dt>poświadczonych przez giełdę jako polskie</dt><dd>{n(stats.attestedWallets)}</dd></div>
            <div><dt>kont publicznych ze wskazanym portfelem</dt><dd>{n(stats.accountsWithWallet)}</dd></div>
            <div><dt>portfeli w obu warstwach naraz</dt><dd>{n(stats.inBothLayers)}</dd></div>
            {stats.binanceVerified > 0 && <div><dt>z tokenem Binance dla zweryfikowanych klientów</dt><dd>{n(stats.binanceVerified)}</dd></div>}
            {stats.twoExchanges > 0 && <div><dt>poświadczonych przez dwie giełdy</dt><dd>{n(stats.twoExchanges)}</dd></div>}
          </dl>
          {stats.eventWallets > 0 && (
            <p>
              Osobno: {n(stats.eventWallets)} portfeli odebrało tokeny obecności na wydarzeniach w Polsce, z tego {n(stats.eventWalletsRepeat)} w co najmniej dwóch różnych dniach. To portfele osób, które były w Polsce, niekoniecznie polskich
              rezydentów; w sprawie taki token jest okolicznością, nie dowodem.
            </p>
          )}
        </>
      )}

      {f && (
        <>
          <h2>Dokąd trafiły środki</h2>
          <p>
            Historię w sieci Base odczytano dla {n(f.scanned)} portfeli; {n(f.active)} z nich ma tam jakiekolwiek przelewy. Do każdego zastosowano te same reguły co w pojedynczej sprawie: przelew na oznaczony adres giełdy (L1) albo na adres,
            który przekazał środki dalej na giełdę (D1).
          </p>
          <dl className="figures">
            <div><dt>portfeli z wpłatą na giełdę</dt><dd>{n(f.cashedOut)}</dd></div>
            <div><dt>z nich poświadczonych jako polskie</dt><dd>{n(f.cashedOutAttested)}</dd></div>
            <div><dt>z nich należących do znanego konta</dt><dd>{n(f.cashedOutAccounts)}</dd></div>
            <div><dt>wpłat łącznie</dt><dd>{n(f.deposits)}</dd></div>
            <div><dt>stablecoinów (USDC, USDT, DAI)</dt><dd>{n(f.stablecoins)}</dd></div>
            <div><dt>etheru (ETH)</dt><dd>{n(f.ether)}</dd></div>
          </dl>
          <table className="bars" aria-label="Giełdy według liczby portfeli, które na nie wpłacały">
            <caption>Giełdy według liczby portfeli, które na nie wpłacały</caption>
            <tbody>
              {f.exchanges.map((e) => (
                <tr key={e.name}>
                  <th scope="row">{e.name}</th>
                  <td>
                    <span className="bar" style={{ width: `${(86 * e.wallets) / most}%` }} />
                    <span className="bar-value">{n(e.wallets)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
