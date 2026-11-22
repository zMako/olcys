import { bundledLabel, foldDiacritics, knowsIdentity, parseAddress, type AccountInfo, type AddressLabel } from '@olcys/core';
import { RECORD_SERVICES, accountKeyOf, resolveIdentities } from './identity';
import { buildHistories } from './history';
import { compareRhythm, hourHistogram, inWindow, quietHoursOf, windowText, type Rhythm } from './rhythm';
import { DEFAULT_RULESET, bandOf, type Ruleset } from './ruleset';
import type { Assessment, BandId, Challenge, Cluster, ClusterAccount, DocFact, Link, MentionFact, Occurrence, Placement, ReceiptLine, RunFacts } from './types';

const PLACEMENT_ORDER: Placement[] = ['own_profile', 'sale', 'discussion', 'mass_comment', 'quoted'];
const KIND_PL: Record<string, string> = { profile: 'profil', repo: 'repozytorium', ad: 'ogłoszenie', post: 'wpis', page: 'strona' };
const CATEGORY_PL: Record<string, string> = {
  exchange: 'giełda', exchange_deposit: 'adres depozytowy giełdy', p2p: 'usługa wymiany P2P', payment_gateway: 'bramka płatnicza', card: 'karta płatnicza',
  otc: 'kantor', dex: 'giełda zdecentralizowana', token: 'kontrakt tokena', contract: 'smart kontrakt', mixer: 'mikser', charity: 'zbiórka publiczna',
  bridge: 'most między sieciami', other: 'inny podmiot', sanctioned: 'adres z listy sankcyjnej', reported: 'adres zgłoszony jako oszustwo',
};
const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/**
 * Computes the Confidence Score of every person-to-address link of a run.
 * A pure function: the same facts and the same ruleset always give the same result,
 * and every point of the score is traceable to a rule and to stored sources.
 */
export function assess(facts: RunFacts, ruleset: Ruleset = DEFAULT_RULESET): Assessment {
  const docs = new Map(facts.documents.map((d) => [d.id, d]));
  const accountInfo = new Map<string, AccountInfo>(facts.accounts.map((a) => [`${a.chain}:${a.address}`, a]));

  const labelsOf = (chain: string, address: string): AddressLabel[] => {
    const bundled = bundledLabel(chain, address);
    return [...(bundled ? [bundled] : []), ...(accountInfo.get(`${chain}:${address}`)?.labels ?? [])];
  };

  /** Hard exclusions that depend only on the address itself. */
  const exclusionOf = (chain: string, address: string): { rule: string; title: string; detail: string } | undefined => {
    const label = labelsOf(chain, address).find((l) => ruleset.exclusions.labelCategories.includes(l.category));
    if (label) {
      return {
        rule: 'X1',
        title: 'Adres oznaczonego podmiotu',
        detail: `Adres należy do podmiotu „${label.name}” (${CATEGORY_PL[label.category] ?? label.category}; źródło: ${label.source}). Nie jest prywatnym portfelem badanej osoby.`,
      };
    }
    const info = accountInfo.get(`${chain}:${address}`);
    if (ruleset.exclusions.contractCode && info?.kind === 'contract') {
      return {
        rule: 'X2',
        title: 'Smart kontrakt',
        detail: `Pod adresem znajduje się kod wykonywalny (bytecode ${info.code.slice(0, 18)}…). To kontrakt, a nie konto prywatnego użytkownika.`,
      };
    }
    return undefined;
  };

  const massReason = (doc: DocFact): string | undefined => {
    const text = foldDiacritics(`${doc.container?.title ?? ''} ${doc.container?.section ?? ''}`).toLowerCase();
    const word = ruleset.massContext.keywords.find((k) => text.includes(k));
    if (word) return `w nazwie wątku lub działu występuje „${word}”`;
    const s = doc.container?.stats;
    if (s && s.postsWithAddress >= ruleset.massContext.minPostsWithAddress && s.postsWithAddress / Math.max(1, s.posts) >= ruleset.massContext.minShare) {
      return `${s.postsWithAddress} z ${s.posts} wpisów w wątku zawiera adres`;
    }
    return undefined;
  };

  const placementOf = (doc: DocFact, m: MentionFact): Placement => {
    if (m.segmentKind === 'quote') return 'quoted';
    if (doc.docType === 'profile' || doc.docType === 'repo') return 'own_profile';
    if (doc.docType === 'ad') return 'sale';
    return massReason(doc) ? 'mass_comment' : 'discussion';
  };

  const ids = resolveIdentities(facts, ruleset, { placementOf, isNonPersonal: (c, a) => !!exclusionOf(c, a) });

  // Who published each address in their own words (quotes do not count).
  const publishers = new Map<string, Set<string>>();
  for (const m of facts.mentions) {
    const k = accountKeyOf(docs.get(m.documentId)!);
    if (!k || m.segmentKind === 'quote') continue;
    const key = `${m.chain}:${m.address}`;
    publishers.set(key, (publishers.get(key) ?? new Set()).add(k));
  }

  const histories = buildHistories(facts);
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : '?');

  /** Transfers that left the wallet an address belongs to: the moments its owner acted. */
  const outgoing = (chain: string, address: string): { txHash: string; at: string }[] => {
    const wallet = (facts.wallets ?? []).find((w) => w.chain === chain && w.members.some((m) => m.address === address));
    const members = new Set(wallet ? wallet.members.map((m) => m.address) : [address]);
    const seen = new Set<string>();
    const out: { txHash: string; at: string }[] = [];
    for (const t of facts.transfers ?? []) {
      if (t.chain !== chain || !members.has(t.from) || members.has(t.to) || seen.has(t.txHash)) continue;
      seen.add(t.txHash);
      out.push({ txHash: t.txHash, at: t.at });
    }
    return out;
  };

  /** V1: what institutions publicly state about an address. They name nobody; some of them know who the owner is. */
  const vouchLines = (chain: string, address: string): { lines: Omit<ReceiptLine, 'total'>[]; vouchers: string[] } => {
    const lines: Omit<ReceiptLine, 'total'>[] = [];
    const attestedBy = (facts.attestations ?? []).filter((x) => x.chain === chain && x.address === address);
    for (const issuer of uniq(attestedBy.map((x) => x.issuer))) {
      const theirs = attestedBy.filter((x) => x.issuer === issuer);
      const country = theirs.find((x) => x.claim === 'verified_country' && x.value)?.value;
      const first = theirs.map((x) => x.at).filter(Boolean).sort()[0];
      const names = theirs.some(knowsIdentity);
      const said = uniq(theirs.map((x) => x.note).filter((n): n is string => !!n));
      lines.push({
        rule: 'V1', title: `Publiczne poświadczenie: ${issuer}`, effect: 'info', points: null,
        detail: `${said.length
          ? `Publicznie poświadczono: ${said.join('; ')}`
          : `${issuer} poświadcza publicznie, w łańcuchu bloków, że właściciel tego adresu jest zweryfikowanym klientem tej giełdy${country ? ` (kraj weryfikacji: ${country})` : ''}`}${first ? `; najwcześniejsze poświadczenie z ${day(first)}` : ''}. ${
          names
            ? `Poświadczenie nie mówi, kim jest właściciel — mówi, kto to wie: ${issuer} sprawdził jego dokumenty i może go wskazać na wniosek organu.`
            : 'Poświadczenie nie wskazuje osoby i nie pochodzi od podmiotu, który sprawdzał jej dokumenty; jest okolicznością, nie dowodem tożsamości.'
        } Nie zmienia Wskaźnika Pewności: dotyczy adresu, a nie tego, czy adres należy do badanej osoby.`,
        evidence: uniq(theirs.map((x) => x.sourceUrl).filter((u): u is string => !!u)),
      });
    }
    // Only an issuer that checked the owner's documents can name the owner.
    return { lines, vouchers: uniq(attestedBy.filter(knowsIdentity).map((x) => x.issuer)) };
  };

  const links: Link[] = [];
  for (const cluster of ids.clusters) {
    const byAddress = new Map<string, Occurrence[]>();
    for (const m of facts.mentions) {
      const d = docs.get(m.documentId)!;
      const k = accountKeyOf(d);
      if (!k || ids.clusterOfAccount.get(k) !== cluster.id) continue;
      const placement = placementOf(d, m);
      const key = `${m.chain}:${m.address}`;
      byAddress.set(key, [
        ...(byAddress.get(key) ?? []),
        {
          documentId: d.id, url: d.url, origin: d.origin, source: facts.sources?.[d.origin] ?? d.origin, docType: d.docType, title: d.title, authorHandle: d.authorHandle,
          segmentKind: m.segmentKind, quotedAuthor: m.quotedAuthor, placement,
          placementNote: placement === 'mass_comment' ? massReason(d) : undefined,
          method: m.method, obfuscation: m.obfuscation, raw: m.raw, context: m.context,
          publishedAt: d.publishedAt, fetchedAt: d.fetchedAt, snapshotSha256: d.snapshotSha256,
          image: m.imageUrl && m.imageSnapshotId ? { url: m.imageUrl, snapshotId: m.imageSnapshotId } : undefined,
          archivedAt: d.container?.kind === 'archive' ? d.publishedAt : undefined,
        },
      ]);
    }

    // A contract the person shows as their own was created from some address. That address is theirs to explain
    // even though they never published it: it enters the list with the contract's place of publication.
    for (const dep of facts.deployments ?? []) {
      if (labelsOf(dep.chain, dep.contract).some((l) => ruleset.exclusions.labelCategories.includes(l.category))) continue; // an institution's contract
      const shown = (byAddress.get(`${dep.chain}:${dep.contract}`) ?? []).filter((o) => o.placement !== 'quoted' && o.method !== 'deployer');
      if (!shown.length) continue;
      const key = `${dep.chain}:${dep.creator}`;
      byAddress.set(key, [
        ...(byAddress.get(key) ?? []),
        ...shown.map((o): Occurrence => ({
          ...o, method: 'deployer', obfuscation: [], raw: dep.contract, image: undefined,
          context: `Kontrakt ${dep.contract} utworzono z tego adresu${dep.at ? ` dnia ${day(dep.at)}` : ''}${dep.txHash ? ` (transakcja ${dep.txHash.slice(0, 18)}…)` : ''}.`,
        })),
      ]);
    }

    // When the person publishes on the web. The hours they are never active are compared with each address's transfers.
    const mineKeys = new Set(cluster.accounts.map((x) => `${x.origin}:${x.handle.toLowerCase()}`));
    const webTimes = facts.documents
      .filter((d) => d.publishedAt && d.docType !== 'profile' && d.container?.kind !== 'archive' && mineKeys.has(accountKeyOf(d) ?? ''))
      .map((d) => d.publishedAt!);
    const { quiet } = quietHoursOf(webTimes, ruleset);
    const offBeat: Rhythm['conflicting'] = [];

    for (const [key, all] of byAddress) {
      const [chain, address] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const occurrences = all.sort((a, b) => PLACEMENT_ORDER.indexOf(a.placement) - PLACEMENT_ORDER.indexOf(b.placement) || a.url.localeCompare(b.url));
      const shownByPerson = occurrences.filter((o) => o.placement !== 'quoted');
      // Places where the address itself stands count first; places that only lead to it through a contract are used when there are no others.
      const derived = shownByPerson.filter((o) => o.method === 'deployer');
      const indirect = derived.length > 0 && derived.length === shownByPerson.length;
      const own = indirect ? shownByPerson : shownByPerson.filter((o) => o.method !== 'deployer');
      const info = accountInfo.get(key);
      const others: ClusterAccount[] = [...(publishers.get(key) ?? [])]
        .filter((k) => ids.clusterOfAccount.get(k) !== cluster.id)
        .sort()
        .map((k) => ids.accounts.get(k)!);

      const receipt: ReceiptLine[] = [];
      let total = 0;
      const line = (l: Omit<ReceiptLine, 'total'>) => receipt.push({ ...l, total });
      let status: Link['status'] = 'attributed';
      let proven = false;
      const challenges: Challenge[] = [];
      const wouldConfirm: string[] = [];
      const where = (os: Occurrence[]) => uniq(os.map((o) => `${KIND_PL[o.docType] ?? o.docType} w serwisie ${o.source}`)).join(', ');

      const exclusion = exclusionOf(chain, address);
      if (exclusion) {
        status = 'excluded';
        line({ ...exclusion, effect: 'exclusion', points: 0, evidence: info?.sourceUrl ? [info.sourceUrl] : [] });
        if (own.length) {
          const made = exclusion.rule === 'X2' ? (facts.deployments ?? []).find((d) => d.chain === chain && d.contract === address) : undefined;
          line({
            rule: 'F1',
            title: 'Odnotowano wzmiankę',
            detail: made
              ? `Badana osoba podaje ten kontrakt jako własny projekt (${where(own)}). Kontrakt nie jest portfelem, ale utworzono go z adresu ${short(made.creator)} — ten adres oceniono osobno.`
              : `Badana osoba sama podała ten adres (${where(own)}). To ślad korzystania z usług tego podmiotu, a nie jej portfel.`,
            effect: 'info', points: null, evidence: uniq(own.map((o) => o.url)),
          });
        }
      } else if (others.length >= ruleset.exclusions.unrelatedPublishers) {
        status = 'excluded';
        line({
          rule: 'X3',
          title: 'Adres publiczny',
          detail: `Ten sam adres publikuje ${others.length} niepowiązanych kont (${others.slice(0, 5).map((o) => `${o.handle} w serwisie ${o.source}`).join(', ')}). Prywatny portfel nie jest rozpowszechniany przez obce osoby.`,
          effect: 'exclusion', points: 0, evidence: uniq(own.map((o) => o.url)),
        });
      } else if (!own.length) {
        status = 'not_attributable';
        const quoted = uniq(occurrences.map((o) => o.quotedAuthor).filter(Boolean));
        line({
          rule: 'Q1',
          title: 'Adres tylko zacytowany',
          detail: `Adres występuje wyłącznie w cytacie cudzej wypowiedzi${quoted.length ? ` (autor: ${quoted.join(', ')})` : ''}. Należy do cytowanej osoby, nie do autora wpisu.`,
          effect: 'exclusion', points: 0, evidence: uniq(occurrences.map((o) => o.url)),
        });
      } else {
        // P: the strongest place of publication sets the starting score.
        const best = own[0].placement as Exclude<Placement, 'quoted'>;
        const rule = ruleset.placements[best];
        const bestOnes = own.filter((o) => o.placement === best);
        total = rule.base;
        line({
          rule: rule.rule, title: rule.title, effect: 'base', points: rule.base,
          detail: `${indirect ? 'Miejsce, w którym osoba podała kontrakt' : 'Najsilniejsze miejsce publikacji'}: ${where(bestOnes)}${bestOnes[0].placementNote ? ` (${bestOnes[0].placementNote})` : ''}. Wartość wyjściowa ${rule.base}%.`,
          evidence: uniq(bestOnes.map((o) => o.url)),
        });
        const weaker = own.filter((o) => o.placement !== best);
        if (weaker.length) {
          line({
            rule: 'P0', title: 'Pozostałe wystąpienia', effect: 'info', points: null,
            detail: `Adres występuje też w słabszych miejscach: ${uniq(weaker.map((o) => ruleset.placements[o.placement as Exclude<Placement, 'quoted'>].title.toLowerCase())).join('; ')}. Punkty nie sumują się — liczy się najsilniejsze miejsce.`,
            evidence: uniq(weaker.map((o) => o.url)),
          });
        }

        // K3: the address created a contract the person shows as their own.
        if (derived.length) {
          const contracts = uniq(derived.map((o) => o.raw));
          const dep = (facts.deployments ?? []).find((d) => d.chain === chain && d.creator === address && contracts.includes(d.contract));
          const when = dep?.at ? ` dnia ${day(dep.at)}` : '';
          const evidence = [...uniq(derived.map((o) => o.url)), ...(dep?.sourceUrl ? [dep.sourceUrl] : [])];
          if (indirect) {
            const cap = ruleset.deployer.max;
            total = Math.min(total, cap);
            line({
              rule: 'K3', title: 'Adres ustalony pośrednio: twórca kontraktu', effect: 'cap', points: cap,
              detail: `Tego adresu osoba nigdzie nie podała. Podaje natomiast jako własny kontrakt ${contracts.map(short).join(', ')} (${where(derived)}), a łańcuch bloków pokazuje, że kontrakt utworzono z tego adresu${when}. Kontrakt mógł wdrożyć także współpracownik, dlatego wynik jest ograniczony do ${cap}%.`,
              evidence,
            });
          } else {
            const add = Math.min(ruleset.deployer.bonus, 100 - total);
            total += add;
            line({
              rule: 'K3', title: 'Z tego adresu utworzono kontrakt osoby', effect: 'bonus', points: add,
              detail: `Osoba podaje ten adres wprost, a niezależnie od tego podaje jako własny kontrakt ${contracts.map(short).join(', ')}, który utworzono z tego adresu${when}. Premia +${ruleset.deployer.bonus} pkt proc.`,
              evidence,
            });
          }
        }

        // S: independent confirmation.
        const origins = uniq(own.map((o) => o.origin));
        const name = (origin: string) => facts.sources?.[origin] ?? origin;
        if (origins.length >= ruleset.synergy.minOrigins) {
          total = Math.min(100, total + ruleset.synergy.points);
          line({
            rule: ruleset.synergy.rule, title: 'Synergia śladów', effect: 'bonus', points: ruleset.synergy.points,
            detail: `Ten sam adres w ${origins.length} niezależnych źródłach (${origins.map(name).join(', ')}), na kontach tej samej osoby. Premia +${ruleset.synergy.points} pkt proc., nie więcej niż 100%.`,
            evidence: uniq(own.map((o) => o.url)),
          });
        }
        const repeated = origins.filter((o) => own.filter((x) => x.origin === o).length > 1);
        if (repeated.length) {
          line({
            rule: 'S2', title: 'Powtórzenia w jednym serwisie', effect: 'info', points: null,
            detail: `Wielokrotne wystąpienia w obrębie serwisu ${repeated.map(name).join(', ')} nie stanowią dodatkowego potwierdzenia i nie są punktowane.`,
            evidence: [],
          });
        }

        // O: the author went out of their way to hide the address from scrapers.
        const hidden = own.filter((o) => o.method === 'deobfuscated' || o.method === 'joined');
        if (hidden.length && ruleset.obfuscation.points) {
          total = Math.min(100, total + ruleset.obfuscation.points);
          line({
            rule: ruleset.obfuscation.rule, title: 'Adres celowo ukryty przed automatami', effect: 'bonus', points: ruleset.obfuscation.points,
            detail: `Autor zamaskował adres (${uniq(hidden.flatMap((o) => o.obfuscation)).join(', ')}). Tak postępuje się z własnym adresem, nie z cudzym. Premia +${ruleset.obfuscation.points} pkt proc.`,
            evidence: uniq(hidden.map((o) => o.url)),
          });
        }

        // G: read from a picture, not from the page text.
        const fromImage = own.filter((o) => o.image);
        if (fromImage.length) {
          line({
            rule: 'G1', title: 'Adres odczytany z obrazu', effect: 'info', points: null,
            detail: `${fromImage.length === own.length ? 'Adresu nie ma w treści strony' : 'Adres występuje także na zdjęciu'} — odczytano go z kodu QR na zdjęciu, które zostało zapisane w magazynie dowodów. Nie zmienia to punktacji: liczy się miejsce publikacji.`,
            evidence: uniq(fromImage.map((o) => o.image!.url)),
          });
        }

        // H: seen only in stored past versions of the profile.
        const archived = own.filter((o) => o.archivedAt);
        const gone = archived.length > 0 && !own.some((o) => !o.archivedAt && o.docType === 'profile' && o.origin === archived[0].origin);
        if (gone) {
          const dates = archived.map((o) => o.archivedAt!).sort();
          const swap = histories.flatMap((h) => h.changes).find((c) => c.kind === 'swap' && c.from === address);
          line({
            rule: 'H1', title: 'Adres z archiwalnej wersji profilu', effect: 'info', points: null,
            detail: `Adres widniał na profilu w zapisanych wersjach z okresu ${day(dates[0])} – ${day(dates[dates.length - 1])}. W obecnej wersji profilu go nie ma.${swap ? ` ${swap.detail}` : ''} Publikacja na własnym profilu liczy się tak samo, niezależnie od tego, kiedy miała miejsce.`,
            evidence: uniq(archived.map((o) => o.url)),
          });
        }

        // C: a signed message is mathematical proof that the author held the key.
        const proofs = (facts.proofs ?? []).filter((p) => p.chain === chain && p.address === address && ids.clusterOfAccount.get(accountKeyOf(docs.get(p.documentId)!) ?? '') === cluster.id);
        const genuine = proofs.filter((p) => p.valid);
        const names = (p: (typeof genuine)[number]) => {
          const handle = docs.get(p.documentId)!.authorHandle;
          return !!handle && p.message.toLowerCase().includes(handle.toLowerCase());
        };
        const naming = genuine.find((p) => !p.attestedBy && names(p));
        const vouched = genuine.find((p) => p.attestedBy && names(p));
        if (!naming && vouched) {
          // C3: the statement is signed, but the signature was checked by the service that holds it, not by this tool.
          const add = Math.max(0, ruleset.proof.attestedMin - total);
          total += add;
          line({
            rule: 'C3', title: `Oświadczenie podpisane, sprawdzone przez ${vouched.attestedBy}`, effect: 'bonus', points: add,
            detail: `${vouched.message}. Podpis sprawdził serwis ${vouched.attestedBy}; to narzędzie nie weryfikowało go samodzielnie, dlatego wynik to co najmniej ${ruleset.proof.attestedMin}%, a nie 100%.`,
            evidence: [docs.get(vouched.documentId)!.url],
          });
        } else if (naming) {
          const add = 100 - total;
          total = 100;
          proven = true;
          line({
            rule: 'C1', title: 'Dowód kryptograficzny', effect: 'bonus', points: add,
            detail: `Konto ${docs.get(naming.documentId)!.authorHandle} opublikowało wiadomość podpisaną kluczem prywatnym tego adresu, a treść wiadomości wymienia to konto: „${naming.message}”. Podpis sprawdzono matematycznie — mógł go złożyć tylko posiadacz klucza. Wynik 100%.`,
            evidence: [docs.get(naming.documentId)!.url],
          });
        } else if (genuine.some((p) => !p.attestedBy)) {
          const unbound = genuine.find((p) => !p.attestedBy)!;
          const add = Math.max(0, Math.min(ruleset.proof.unboundPoints, ruleset.proof.unboundMax - total));
          total += add;
          line({
            rule: 'C2', title: 'Podpis bez wskazania konta', effect: 'bonus', points: add,
            detail: `Wiadomość jest prawidłowo podpisana kluczem tego adresu, ale jej treść nie wymienia konta, które ją opublikowało („${unbound.message}”). Podpis mógł zostać skopiowany z innego miejsca, dlatego premia jest ograniczona: +${ruleset.proof.unboundPoints} pkt proc., nie więcej niż ${ruleset.proof.unboundMax}%.`,
            evidence: [docs.get(unbound.documentId)!.url],
          });
        } else if (proofs.length) {
          line({
            rule: 'C0', title: 'Nieprawidłowy podpis', effect: 'info', points: null,
            detail: `Przy adresie opublikowano podpisaną wiadomość, ale podpis jest nieprawidłowy (${proofs[0].reason ?? 'nie zgadza się z adresem'}). Niczego nie dowodzi; warto sprawdzić, po co go podano.`,
            evidence: [docs.get(proofs[0].documentId)!.url],
          });
        }

        // E / N: the address has a name on chain. A name given in the text is how some addresses are published;
        // a name whose records point back at the account confirms the link from the other side.
        const viaName = own.filter((o) => o.method === 'ens');
        if (viaName.length) {
          line({
            rule: 'E1', title: 'Adres ustalony z nazwy', effect: 'info', points: null,
            detail: `W treści podano nazwę ${uniq(viaName.map((o) => o.raw)).join(', ')} zamiast adresu. Nazwa wskazuje w łańcuchu bloków ten adres. Nie zmienia to punktacji: liczy się miejsce publikacji.`,
            evidence: uniq(viaName.map((o) => o.url)),
          });
        }
        const named = (facts.names ?? []).find((n) => n.chain === chain && n.address === address && n.verified);
        if (named) {
          const emails = new Set(cluster.identifiers.filter((i) => i.kind === 'email').map((i) => i.normalized));
          // a record confirms the link only if it names an account of this person on the very service the record is about
          const pointsHere = (k: string, v: string) => !!RECORD_SERVICES[k] && cluster.accounts.some((x) => RECORD_SERVICES[k].includes(x.origin) && x.handle.toLowerCase() === v.replace(/^@/, '').toLowerCase());
          const pointer = Object.entries(named.records).find(([k, v]) => (k === 'email' ? emails.has(v.toLowerCase()) : pointsHere(k, v)));
          if (pointer) {
            const add = Math.max(0, ruleset.names.mutualMin - total);
            total += add;
            line({
              rule: 'N1', title: 'Potwierdzenie z obu stron', effect: 'bonus', points: add,
              detail: `Konto podaje ten adres, a adres ma w łańcuchu bloków nazwę ${named.name}, której rekord „${pointer[0]}: ${pointer[1]}” wskazuje to konto. Rekordy nazwy może ustawić tylko ten, kto nią zarządza. Wynik co najmniej ${ruleset.names.mutualMin}%.`,
              evidence: named.sourceUrl ? [named.sourceUrl] : [],
            });
          } else {
            line({
              rule: 'N0', title: 'Adres ma nazwę', effect: 'info', points: null,
              detail: `Adres zgłosił w łańcuchu bloków nazwę ${named.name}${Object.keys(named.records).length ? `; jej rekordy: ${Object.entries(named.records).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}. Rekordy nie wskazują żadnego ze znalezionych kont.`,
              evidence: named.sourceUrl ? [named.sourceUrl] : [],
            });
          }
        }

        // A: a publicly stated amount that corresponds to an actual transfer on this address.
        const mine = new Set(cluster.accounts.map((x) => `${x.origin}:${x.handle.toLowerCase()}`));
        const walletAddresses = new Set((facts.wallets ?? []).find((w) => w.root === address)?.members.map((m) => m.address) ?? [address]);
        const matches = (facts.amountMatches ?? []).filter((m) => m.chain === chain && walletAddresses.has(m.address) && mine.has(accountKeyOf(docs.get(m.documentId) ?? { origin: '', authorHandle: undefined }) ?? ''));
        let matchPoints = 0;
        for (const m of matches) {
          const add = m.unique ? Math.max(0, Math.min(ruleset.amountMatch.points, ruleset.amountMatch.maxPoints - matchPoints, 100 - total)) : 0;
          matchPoints += add;
          total += add;
          line({
            rule: 'A1', title: m.kind === 'price' ? 'Wpłata zgodna z ceną z ogłoszenia' : 'Przelew zgodny z kwotą podaną we wpisie',
            effect: m.unique ? 'bonus' : 'info', points: m.unique ? add : null,
            detail: `${m.detail}${m.unique ? ` Premia +${ruleset.amountMatch.points} pkt proc. za każdą taką zgodność, łącznie najwyżej +${ruleset.amountMatch.maxPoints}.` : ''}`,
            evidence: [m.url],
          });
        }

        // V1: an institution vouches, in public, for whoever owns the address. It names nobody — it names who knows.
        const attested = vouchLines(chain, address);
        const vouchers = attested.vouchers;
        for (const l of attested.lines) line(l);

        if (info?.kind === 'delegated_eoa') {
          line({
            rule: 'K1', title: 'Konto prywatne z delegacją', effect: 'info', points: null,
            detail: `Adres ma kod, ale jest to znacznik delegacji EIP-7702 (do ${info.delegate ? short(info.delegate) : 'kontraktu'}), a nie smart kontrakt. Pozostaje kontem prywatnym — nie wyklucza się go.`,
            evidence: info.sourceUrl ? [info.sourceUrl] : [],
          });
        } else if (info?.kind === 'smart_wallet') {
          line({
            rule: 'K2', title: 'Portfel kontraktowy', effect: 'info', points: null,
            detail: 'Adres jest kontraktem-portfelem (np. Safe). Taki portfel może należeć do osoby fizycznej; nie wyklucza się go, ale własność wymaga dalszej weryfikacji.',
            evidence: info.sourceUrl ? [info.sourceUrl] : [],
          });
        }
        if (others.length) {
          line({
            rule: 'M1', title: 'Adres podany także przez inne konto', effect: 'info', points: null,
            detail: `Adres opublikowało również: ${others.map((o) => `${o.handle} w serwisie ${o.source}`).join(', ')}. Poniżej progu ${ruleset.exclusions.unrelatedPublishers} niepowiązanych kont nie zmienia to wyniku, ale warto sprawdzić związek.`,
            evidence: [],
          });
        }

        // What could undermine this link — shown beside the score so its weak points are not overlooked.
        const allFromImage = own.every((o) => o.image);
        const allArchived = gone && !own.some((o) => !o.archivedAt && o.placement === 'own_profile');
        const push = (weight: Challenge['weight'], text: string) => challenges.push({ weight, text });
        if (cluster.level === 'name_unique' || cluster.level === 'name_ambiguous') push('duże', 'Konto dopasowano wyłącznie po imieniu i nazwisku. To może być inna osoba o tym samym nazwisku.');
        if (cluster.level === 'handle_variant') push('średnie', 'Konto znaleziono po podobnym, a nie identycznym nicku, i nic więcej nie łączy go z osobą.');
        if (indirect) push('średnie', 'Kontrakt mógł wdrożyć współpracownik albo wykonawca, a nie autor repozytorium.');
        if (best === 'discussion' && !proven) push('duże', 'We wpisie na forum autor mógł podać adres innej osoby, na przykład kontrahenta, a nie własny.');
        if (best === 'mass_comment') push('duże', 'W wątkach konkursowych ludzie wklejają adresy przypadkowe lub jednorazowe.');
        if (matches.some((m) => m.unique)) push('małe', 'Zgodność kwoty i daty może być przypadkowa, zwłaszcza przy okrągłych kwotach.');
        if (best === 'sale' && !matches.some((m) => m.unique)) push('średnie', 'Adres w ogłoszeniu może należeć do pośrednika albo usługi, która rozlicza sprzedaż.');
        if (allFromImage) push('średnie', 'Adres odczytano wyłącznie z kodu QR na zdjęciu. Zdjęcie mogło zostać skopiowane z cudzego ogłoszenia.');
        if (allArchived) push('średnie', `Adresu nie ma już na profilu. Dowodzi to związku w przeszłości, niekoniecznie dziś.`);
        if (origins.length === 1 && !proven) push('średnie', `Adres występuje tylko w jednym serwisie (${name(origins[0])}). Brakuje niezależnego potwierdzenia.`);
        if (others.length) push('średnie', `Ten sam adres podało też inne konto: ${others.map((o) => `${o.handle} (${o.source})`).join(', ')}.`);
        if (info?.kind === 'smart_wallet') push('średnie', 'Portfel kontraktowy może mieć kilku współwłaścicieli.');
        if (info && info.txCount === 0) push('małe', 'Adres nie ma żadnych transakcji w łańcuchu bloków; mógł nigdy nie być używany.');
        if (cluster.level === 'entered' && cluster.accounts.length === 1) push('małe', 'Tożsamość opiera się na jednym koncie o podanym nicku. Taki sam nick może mieć inna osoba.');
        if (proven) push('małe', 'Podpis dowodzi, że autor miał klucz w chwili podpisania. Klucz mógł później zmienić właściciela.');
        if (!challenges.length) push('małe', 'Nie znaleziono istotnych zastrzeżeń. Uwaga ogólna: publikacja adresu nie przesądza, kto dziś nim dysponuje.');
        const order = { duże: 0, średnie: 1, małe: 2 };
        challenges.sort((a, b) => order[a.weight] - order[b.weight]);
        if (!proven) wouldConfirm.push('Wiadomość podpisana kluczem tego adresu, opublikowana przez konto osoby.');
        if (origins.length === 1) wouldConfirm.push('Ten sam adres na innym koncie tej osoby, w innym serwisie.');
        for (const issuer of vouchers) wouldConfirm.unshift(`Dane klienta z ${issuer}: podmiot ten sam poświadczył publicznie, że sprawdził tożsamość właściciela tego adresu.`);
        wouldConfirm.push('Dane giełdy lub usługi, do której trafiły środki z tego adresu.');

        if (indirect) wouldConfirm.unshift('Przelew między tym adresem a innym adresem osoby.');

        // R2: transfers leave this address at hours when the person is never active on the web.
        if (quiet && !proven) {
          const sent = outgoing(chain, address);
          const night = sent.filter((t) => inWindow(t.at, quiet));
          if (sent.length >= ruleset.rhythm.addressMinTransfers && night.length / sent.length >= ruleset.rhythm.conflictShare) {
            const cut = Math.min(ruleset.rhythm.conflictPenalty, total);
            total -= cut;
            line({
              rule: 'R2', title: 'Rytm doby inny niż rytm osoby', effect: 'penalty', points: cut,
              detail: `${night.length} z ${sent.length} przelewów wychodzących z tego adresu wysłano ${windowText(quiet)}. W tych godzinach osoba nigdy nie publikuje w sieci (na podstawie ${webTimes.length} datowanych wpisów i ogłoszeń). Adresem może dysponować ktoś inny. Wynik obniżony o ${cut} pkt proc.`,
              evidence: [],
            });
            challenges.unshift({ weight: 'duże', text: `Przelewy z tego adresu wychodzą w godzinach, w których osoba nie jest aktywna w sieci (${night.length} z ${sent.length}).` });
            offBeat.push({ chain, address, transfers: sent.length, inQuiet: night.length, hours: hourHistogram(sent.map((t) => t.at)) });
          }
        }

        // M1: a language model compared this unconfirmed account with the person's confirmed ones. Its opinion is an
        // aid: agreement adds a little and stays under the identity limit; disagreement takes points away after it.
        const opinion = cluster.identityCap < 100 ? facts.opinions?.find((o) => o.verdict !== 'unclear' && cluster.accounts.some((x) => x.origin === o.origin && x.handle.toLowerCase() === o.handle.toLowerCase())) : undefined;
        const said = opinion ? `Model językowy (${opinion.model}) porównał konto ${opinion.handle} z kontami osoby. ${opinion.reasons.join(' ')}`.trim() : '';
        if (opinion?.verdict === 'same') {
          total += ruleset.opinion.bonus;
          line({ rule: 'M1', title: 'Ocena modelu: prawdopodobnie ta sama osoba', effect: 'bonus', points: ruleset.opinion.bonus, detail: `${said} Ocena jest pomocnicza i nie podnosi wyniku ponad limit tożsamości.`, evidence: [] });
        }

        // T: the score can never exceed how sure we are that these accounts are the person asked about.
        if (total > cluster.identityCap) {
          total = cluster.identityCap;
          line({ rule: 'T1', title: 'Limit pewności tożsamości', effect: 'cap', points: cluster.identityCap, detail: cluster.identityNote, evidence: [] });
        }
        if (opinion?.verdict === 'different') {
          const cut = Math.min(ruleset.opinion.penalty, total);
          total -= cut;
          line({ rule: 'M1', title: 'Ocena modelu: prawdopodobnie inna osoba', effect: 'penalty', points: cut, detail: `${said} Ocena jest pomocnicza.`, evidence: [] });
        }
      }

      const band: { id: BandId; label: string } =
        status === 'excluded' ? { id: 'excluded', label: 'WYKLUCZONE' }
        : status === 'not_attributable' ? { id: 'not_attributable', label: 'NIE DO PRZYPISANIA' }
        : bandOf(ruleset, total);

      links.push({
        clusterId: cluster.id, chain, address, status, score: status === 'attributed' ? total : 0,
        band: band.id, bandLabel: band.label, receipt, occurrences, otherPublishers: others,
        proven: proven || undefined, challenges, wouldConfirm,
        account: info && { kind: info.kind, labels: labelsOf(chain, address), txCount: info.txCount, firstSeenAt: info.firstSeenAt, lastSeenAt: info.lastSeenAt, balances: info.balances, delegate: info.delegate },
      });
    }

    // The person's rhythm as a whole: all transfers that left their addresses, against the hours they publish.
    const skip = new Set(offBeat.map((x) => `${x.chain}:${x.address}`));
    const sentAt = new Map<string, string>();
    for (const l of links) {
      if (l.clusterId !== cluster.id || l.status !== 'attributed' || skip.has(`${l.chain}:${l.address}`)) continue;
      for (const t of outgoing(l.chain, l.address)) sentAt.set(`${l.chain}:${t.txHash}`, t.at);
    }
    if (webTimes.length || sentAt.size) cluster.rhythm = compareRhythm(webTimes, [...sentAt.values()], offBeat, ruleset);
  }

  // E1: an address the analyst entered is the starting point of the case even when no account published it.
  // The tool then says what the chain and public attestations show about it — and that it cannot name the owner.
  for (const seed of facts.seeds) {
    const parsed = seed.kind === 'crypto_address' ? parseAddress(seed.value) : undefined;
    if (!parsed || links.some((l) => l.chain === parsed.chain && l.address === parsed.address)) continue;
    const { chain, address } = parsed;
    const cluster: Cluster = {
      id: `A${ids.clusters.filter((c) => c.id.startsWith('A')).length + 1}`, level: 'entered', identityCap: 100,
      identityNote: 'Adres wprowadził analityk. Nie znaleziono konta, które go opublikowało, więc narzędzie nie wskazuje osoby.',
      accounts: [], joins: [], identifiers: [],
    };
    ids.clusters.push(cluster);
    const info = accountInfo.get(`${chain}:${address}`);
    const excluded = exclusionOf(chain, address);
    const receipt: ReceiptLine[] = [];
    const vouched = vouchLines(chain, address);
    if (excluded) receipt.push({ rule: excluded.rule, title: excluded.title, effect: 'exclusion', points: null, total: 0, detail: excluded.detail, evidence: info?.sourceUrl ? [info.sourceUrl] : [] });
    else {
      receipt.push({
        rule: 'E1', title: 'Adres wprowadzony przez analityka', effect: 'base', points: 100, total: 100,
        detail: 'Adres jest punktem wyjścia sprawy, a nie jej wynikiem. Wynik 100% znaczy, że adres należy do sprawy; nie mówi, kto jest jego właścicielem — żadne znalezione konto go nie opublikowało.',
        evidence: [],
      });
      for (const l of vouched.lines) receipt.push({ ...l, total: 100 });
    }
    const band: { id: BandId; label: string } = excluded ? { id: 'excluded', label: 'WYKLUCZONE' } : bandOf(ruleset, 100);
    links.push({
      clusterId: cluster.id, chain, address, status: excluded ? 'excluded' : 'attributed', score: excluded ? 0 : 100, band: band.id, bandLabel: band.label, receipt, occurrences: [], otherPublishers: [],
      challenges: excluded ? [] : [{ weight: 'duże', text: 'Nie znaleziono konta, które opublikowało ten adres. Kto nim dysponuje, wie tylko podmiot, który sprawdził tożsamość właściciela.' }],
      wouldConfirm: excluded ? [] : [
        ...vouched.vouchers.map((issuer) => `Dane klienta z ${issuer}: podmiot ten sam poświadczył publicznie, że sprawdził tożsamość właściciela tego adresu.`),
        'Dane giełdy lub usługi, do której trafiły środki z tego adresu.',
        'Konto w sieci, które opublikuje ten adres albo podpisze wiadomość jego kluczem.',
      ],
      account: info && { kind: info.kind, labels: labelsOf(chain, address), txCount: info.txCount, firstSeenAt: info.firstSeenAt, lastSeenAt: info.lastSeenAt, balances: info.balances, delegate: info.delegate },
    });
  }

  // W2: addresses of one wallet stand or fall together. If the person published two addresses that are
  // spent in the same transactions, the weaker one is raised to the stronger one's score (up to a limit).
  for (const w of facts.wallets ?? []) {
    const members = new Set(w.members.map((m) => m.address));
    for (const cluster of ids.clusters) {
      const inWallet = links.filter((l) => l.clusterId === cluster.id && l.status === 'attributed' && l.chain === w.chain && members.has(l.address));
      if (inWallet.length < 2) continue;
      const strongest = inWallet.reduce((a, b) => (b.score > a.score ? b : a));
      for (const l of inWallet) {
        const target = Math.min(strongest.score, ruleset.wallet.sharedMax, cluster.identityCap);
        if (l === strongest || l.score >= target) continue;
        const add = target - l.score;
        l.score = target;
        const band = bandOf(ruleset, target);
        l.band = band.id;
        l.bandLabel = band.label;
        l.receipt.push({
          rule: 'W2', title: 'Ten sam portfel', effect: 'bonus', points: add, total: target,
          detail: `Adres należy do tej samej osoby co adres ${short(strongest.address)} (wynik ${strongest.score}%): ${
            [l.address, strongest.address].some((x) => w.members.find((m) => m.address === x)?.rule === 'D2')
              ? 'oba wpłacały na ten sam adres depozytowy giełdy, a giełda przydziela taki adres jednemu klientowi'
              : 'środki z obu wydano w jednej transakcji, więc kontroluje je ta sama osoba'
          }. Wynik podniesiony do ${target}% (najwyżej ${ruleset.wallet.sharedMax}%).`,
          evidence: [],
        });
        l.challenges = l.challenges.filter((c) => !c.text.startsWith('We wpisie na forum') && !c.text.startsWith('Adres występuje tylko w jednym serwisie'));
        l.challenges = l.challenges.filter((c) => !c.text.startsWith('Adres w ogłoszeniu może należeć'));
        l.challenges.push({ weight: 'małe', text: 'Powiązanie przez łańcuch bloków opiera się na regule, która ma wyjątki: transakcje składane wspólnie przez kilka osób albo adres depozytowy używany przez więcej niż jednego klienta.' });
      }
    }
  }

  const statusOrder = ['attributed', 'not_attributable', 'excluded'];
  const clusterOrder = ids.clusters.map((c) => c.id);
  links.sort(
    (a, b) =>
      clusterOrder.indexOf(a.clusterId) - clusterOrder.indexOf(b.clusterId) ||
      statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) ||
      b.score - a.score ||
      a.address.localeCompare(b.address),
  );

  return {
    ruleset: { id: ruleset.id, version: ruleset.version, name: ruleset.name },
    clusters: ids.clusters,
    links,
    thirdPartyAccounts: ids.thirdPartyAccounts,
    histories,
  };
}
