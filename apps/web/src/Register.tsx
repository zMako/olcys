import { useEffect, useState } from 'react';
import type { RegisterRow, RegisterStats } from '@olcys/corpus';

const n = (x: number) => x.toLocaleString('pl-PL');
const day = (iso: string) => iso.slice(0, 10);

/** Personal data stays covered until the analyst asks to see it: the first letters are enough to recognise a row. */
const coverAddress = (a: string, show: boolean) => (show ? `${a.slice(0, 10)}…${a.slice(-6)}` : `${a.slice(0, 6)}…••••`);
const coverHandle = (h: string, show: boolean) => (show ? h : `${h.slice(0, 2)}${'•'.repeat(Math.min(6, Math.max(3, h.length - 2)))}`);

/**
 * The register of Polish wallets built on this machine from public sources, and the wallets in it that paid into
 * exchanges. A row is a lead: one click starts a full analysis of that wallet.
 */
export function Register({ onAnalyze }: { onAnalyze(address: string): void }) {
  const [stats, setStats] = useState<RegisterStats>();
  const [rows, setRows] = useState<RegisterRow[]>();
  const [missing, setMissing] = useState(false);
  const [show, setShow] = useState(false);
  const [only, setOnly] = useState<'all' | 'account' | 'attested'>('all');

  useEffect(() => {
    fetch('/api/register')
      .then((r) => r.json() as Promise<{ available: boolean; stats: RegisterStats }>)
      .then((r) => (r.available ? setStats(r.stats) : setMissing(true)))
      .catch(() => setMissing(true));
    fetch('/api/register/wallets?limit=300')
      .then((r) => r.json() as Promise<{ rows: RegisterRow[] }>)
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, []);

  if (missing) {
    return (
      <main className="register">
        <h1>Rejestr polskich portfeli</h1>
        <p>Rejestru nie ma na tej maszynie. Buduje się go poleceniami <code>npm run corpus -- attestations</code>, <code>expand</code> i <code>flows</code>; dane zostają lokalnie i nie trafiają do repozytorium.</p>
      </main>
    );
  }
  if (!stats) return <main className="register"><p className="quiet">Wczytywanie rejestru…</p></main>;

  const f = stats.flows;
  const shown = (rows ?? []).filter((r) => (only === 'account' ? r.account : only === 'attested' ? r.attested : true));
  const most = Math.max(1, ...(f?.exchanges ?? []).map((e) => e.wallets));
  return (
    <main className="register">
      <h1>Rejestr polskich portfeli</h1>
      <p className="lede">
        Zbudowany na tej maszynie z dwóch publicznych źródeł: poświadczeń giełdy Coinbase („klient zweryfikowany w Polsce”) oraz kont publicznych, które same wskazały swoje portfele i podpisały to kluczem portfela.
        Rejestr odpowiada na pytanie, od którego zwykle nie ma jak zacząć: <em>które</em> portfele warto sprawdzić.
      </p>

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
          Osobno: {n(stats.eventWallets)} portfeli odebrało tokeny obecności na wydarzeniach w Polsce, z tego {n(stats.eventWalletsRepeat)} w co najmniej dwóch różnych dniach. To portfele osób, które były w Polsce, niekoniecznie
          polskich rezydentów; w sprawie taki token jest okolicznością, nie dowodem.
        </p>
      )}

      {f && (
        <>
          <h2>Dokąd trafiły środki</h2>
          <p>
            Historię w sieci Base odczytano dla {n(f.scanned)} portfeli; {n(f.active)} z nich ma tam jakiekolwiek przelewy. Do każdego zastosowano te same reguły co w pojedynczej sprawie: przelew na oznaczony adres giełdy (L1)
            albo na adres, który wszystko przekazał dalej na giełdę (D1).
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

      <h2>Portfele z wpłatami na giełdy</h2>
      <div className="register-controls">
        <label>
          Pokaż{' '}
          <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
            <option value="all">wszystkie</option>
            <option value="account">tylko ze znanym kontem publicznym</option>
            <option value="attested">tylko poświadczone jako polskie</option>
          </select>
        </label>
        <button onClick={() => setShow(!show)} aria-pressed={show}>
          {show ? 'Zakryj dane' : 'Odkryj dane'}
        </button>
        <span className="quiet">Kolejność: od największych wpłat. Kwoty to ilości aktywów, bez przeliczenia; wartość w złotych liczy analiza sprawy.</span>
      </div>
      {!rows ? (
        <p className="quiet">Wczytywanie…</p>
      ) : !shown.length ? (
        <p>Brak portfeli spełniających warunek. Zmień filtr powyżej.</p>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>Portfel</th>
              <th>Konto publiczne</th>
              <th>Poświadczenie</th>
              <th>Giełdy</th>
              <th className="r">Wpłat</th>
              <th className="r">Stablecoiny</th>
              <th className="r">ETH</th>
              <th>Okres</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.wallet}>
                <td className="mono">{coverAddress(r.wallet, show)}</td>
                <td>{r.account ? `${coverHandle(r.account.handle, show)} (${r.account.service})` : <span className="quiet">nie znaleziono</span>}</td>
                <td>{[r.attested && 'Coinbase: Polska', r.binance && 'Binance'].filter(Boolean).join(', ') || <span className="quiet">brak</span>}</td>
                <td>{r.exchanges.join(', ')}</td>
                <td className="r">{n(r.deposits)}</td>
                <td className="r">{r.stablecoins ? n(Math.round(r.stablecoins)) : '—'}</td>
                <td className="r">{r.ether ? n(r.ether) : '—'}</td>
                <td>{day(r.firstAt) === day(r.lastAt) ? day(r.firstAt) : `${day(r.firstAt)} – ${day(r.lastAt)}`}</td>
                <td>
                  <button onClick={() => onAnalyze(r.wallet)}>Analizuj</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="quiet">
        Wiersz jest tropem, nie ustaleniem. Poświadczenie giełdy mówi, kto zna właściciela portfela, a nie kim on jest; wpłata na giełdę mogła być sprzedażą, ale też przechowaniem. Rejestr powstał wyłącznie z danych publicznych i nie
        opuszcza tej maszyny.
      </p>
    </main>
  );
}
