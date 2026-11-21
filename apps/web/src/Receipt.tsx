import type { CSSProperties } from 'react';
import type { Link, ReceiptLine } from '@olcys/scoring';
import { BAND_COLOR } from './graph/Graph';
import { BAND, CHAIN } from './pl';

const points = (r: ReceiptLine) =>
  r.points === null ? '' : r.effect === 'bonus' ? `+${r.points}` : r.effect === 'penalty' ? `−${r.points}` : r.effect === 'cap' ? `do ${r.points}` : String(r.points);

/**
 * The Confidence Score as a till receipt: every rule that fired is a line with its points,
 * the total is at the bottom, and each line names the sources it rests on.
 */
export function Receipt({ link, ruleset }: { link: Link; ruleset: { name: string; version: string } }) {
  const rejected = link.status !== 'attributed';
  const n = link.receipt.length;
  return (
    <div className="receipt" aria-label={`Uzasadnienie wyniku dla adresu ${link.address}`}>
      <div className="receipt-paper">
        <div className="r-head">
          <strong>Wskaźnik Pewności</strong>
          <span>{CHAIN[link.chain] ?? link.chain}</span>
        </div>
        <div className="r-address">{link.address}</div>
        <div className="r-rule" />
        <ol className="r-lines">
          {link.receipt.map((r, i) => (
            <li key={i} className={`r-line effect-${r.effect}`} style={{ '--i': i } as CSSProperties}>
              <span className="r-code">{r.rule}</span>
              <span className="r-title">{r.title}</span>
              <span className="r-points">{points(r)}</span>
              <p className="r-detail">
                {r.detail}
                {r.evidence.length > 0 && (
                  <span className="r-sources">
                    {' '}
                    Źródła:{' '}
                    {r.evidence.map((u, k) => (
                      <a key={u} href={u} target="_blank" rel="noreferrer">
                        [{k + 1}]
                      </a>
                    ))}
                  </span>
                )}
              </p>
            </li>
          ))}
        </ol>
        <div className="r-rule" />
        <div className="r-total" style={{ '--i': n } as CSSProperties}>
          <span>Razem</span>
          <strong>{rejected ? 0 : link.score}%</strong>
        </div>
        {!rejected && (
          <div className="r-meter" style={{ '--i': n } as CSSProperties}>
            <span style={{ width: `${link.score}%`, background: BAND_COLOR[link.band] }} />
          </div>
        )}
        {rejected ? (
          <div className="stamp-row">
            <div className="stamp" style={{ '--i': n } as CSSProperties}>{BAND[link.band]}</div>
          </div>
        ) : (
          <div className="r-band" style={{ '--i': n } as CSSProperties}>{BAND[link.band]}</div>
        )}
        <div className="r-foot">
          Reguły: {ruleset.name}, wersja {ruleset.version}
        </div>
      </div>
    </div>
  );
}
