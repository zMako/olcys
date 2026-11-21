import type { StoredRunEvent } from '@olcys/engine';

/** Polish wording for everything the interface shows. */

export const KIND: Record<string, string> = {
  username: 'nick', full_name: 'imię i nazwisko', email: 'e-mail', phone: 'telefon', messenger_id: 'komunikator',
  profile_url: 'odnośnik do profilu', crypto_address: 'adres krypto',
};
export const LEAD: Record<string, string> = {
  username: 'ten sam nick', full_name: 'nazwisko', email: 'e-mail', phone: 'telefon', messenger_id: 'komunikator', profile_url: 'odnośnik',
};
export const CHAIN: Record<string, string> = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', tron: 'Tron' };
export const CHAIN_CODE: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH', tron: 'TRX' };
export const DOC: Record<string, string> = { profile: 'profil', repo: 'repozytorium', ad: 'ogłoszenie', post: 'wpis', page: 'strona' };
export const SEGMENT: Record<string, string> = {
  signature: 'sygnatura', bio: 'opis profilu', readme: 'opis', contact: 'dane kontaktowe', quote: 'cytat', link: 'odnośnik', body: 'treść', title: 'tytuł',
};
export const PLACEMENT: Record<string, string> = {
  own_profile: 'własny profil', sale: 'ogłoszenie', discussion: 'dyskusja na forum', mass_comment: 'masowe komentarze', quoted: 'cytat cudzej wypowiedzi',
};
export const BAND: Record<string, string> = {
  very_high: 'Bardzo wysokie', probable: 'Prawdopodobne', medium: 'Średnie', noise: 'Niskie, szum', excluded: 'Wykluczone', not_attributable: 'Nie do przypisania',
};
export const ACCOUNT_KIND: Record<string, string> = {
  eoa: 'zwykły adres', delegated_eoa: 'adres prywatny z delegacją EIP-7702', smart_wallet: 'portfel kontraktowy', contract: 'smart kontrakt',
};
export const CATEGORY: Record<string, string> = {
  exchange: 'giełda', exchange_deposit: 'giełda', p2p: 'wymiana P2P', payment_gateway: 'bramka płatnicza', card: 'karta płatnicza', otc: 'kantor',
  dex: 'giełda zdecentralizowana', token: 'kontrakt tokena', contract: 'smart kontrakt', mixer: 'mikser', charity: 'zbiórka', bridge: 'most', other: 'usługa',
};
export const CERTAINTY: Record<string, string> = { probable: 'zbycie prawdopodobne', possible: 'zbycie możliwe' };
export const LEVEL: Record<string, string> = {
  entered: 'Osoba, o którą pytano', publisher: 'Konto, które podało ten adres', handle_variant: 'Konto o podobnym nicku',
  name_unique: 'Możliwe, że ta sama osoba', name_ambiguous: 'Inna osoba o tym samym nazwisku?',
};
/** Short captions for the outlines around accounts in the graph. */
export const GROUP: Record<string, string> = {
  entered: 'Osoba, o którą pytano', publisher: 'Konto, które podało ten adres', handle_variant: 'Podobny nick',
  name_unique: 'Tylko zbieżność nazwiska', name_ambiguous: 'Tylko zbieżność nazwiska',
};
export const OBFUSCATION: Record<string, string> = {
  split: 'pocięty na fragmenty', 'zero-width': 'przedzielony niewidocznymi znakami', homoglyph: 'zapisany literami z innego alfabetu', 'compat-form': 'zapisany nietypowymi znakami',
};

/** "+5 adresów tej osoby" with Polish plural forms. */
export const moreAddresses = (total: number) => {
  const k = total - 1;
  const word = k === 1 ? 'adres' : k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 12 || k % 100 > 14) ? 'adresy' : 'adresów';
  return `+${k} ${word} tej osoby`;
};
export const shortAddress = (a: string) => (a.length > 18 ? `${a.slice(0, 9)}…${a.slice(-6)}` : a);
export const pln = (n: number) => `${Math.round(n).toLocaleString('pl-PL')} zł`;
export const amount = (n: number) => n.toLocaleString('pl-PL', { maximumFractionDigits: 8 });
export const amounts = (list: { asset: string; amount: number }[]) => list.map((x) => `${amount(x.amount)} ${x.asset}`).join(' + ');
export const day = (iso?: string) => (iso ? iso.slice(0, 10) : '—');
export const minute = (iso?: string) => (iso ? iso.slice(0, 16).replace('T', ', ') : '—');
/** Strips the environment note from a source name: "BitRozmowy (forum, środowisko testowe)" → "BitRozmowy". */
export const sourceName = (s: string) => s.replace(/\s*\(.*\)\s*$/, '');

/** One plain sentence per step of the run, for the playback bar and the log. */
export function describe(e: StoredRunEvent): string {
  switch (e.type) {
    case 'run.started':
      return 'Początek analizy.';
    case 'lead':
      if (e.origin === 'seed') return `Wprowadzono: ${KIND[e.kind] ?? e.kind} „${e.value}”.`;
      if (e.origin === 'variant') return `Sprawdzam też inny zapis nicku: „${e.value}”.`;
      if (e.origin === 'name') return `Trop z nazwy adresu: ${KIND[e.kind] ?? e.kind} „${e.value}”.`;
      if (e.origin === 'wallet') return e.kind === 'crypto_address' ? `Szukam w sieci adresu z portfela: ${shortAddress(e.value)}.` : 'Konto powiązane przez portfel: czytam je w całości.';
      return e.kind === 'crypto_address' ? `Nowy trop: kto jeszcze podaje adres ${shortAddress(e.value)}?` : `Nowy trop: ${KIND[e.kind] ?? e.kind} „${e.value}”.`;
    case 'search':
      return `${sourceName(e.source)}: szukam „${e.kind === 'crypto_address' ? shortAddress(e.value) : e.value}”.`;
    case 'document':
      return `${sourceName(e.source)}: ${DOC[e.docType] ?? e.docType}${e.handle ? ` użytkownika ${e.handle}` : ''}${e.relation === 'mention' ? ' (obce konto)' : ''}.`;
    case 'hit':
      return `Trop „${e.via.value}” prowadzi do znanego już dokumentu.`;
    case 'address':
      if (e.method === 'ens') return `Nazwa ${e.name ?? ''} wskazuje adres ${CHAIN[e.chain] ?? e.chain} ${shortAddress(e.address)}.`;
      if (e.method === 'qr') return `Wykryto adres ${CHAIN[e.chain] ?? e.chain} ${shortAddress(e.address)} — odczytany z kodu QR na zdjęciu.`;
      return `Wykryto adres ${CHAIN[e.chain] ?? e.chain} ${shortAddress(e.address)}${e.method !== 'plain' ? ` — był ${e.obfuscation.map((o) => OBFUSCATION[o] ?? o).join(', ')}` : ''}${e.segmentKind === 'quote' ? ' (w cytacie)' : e.segmentKind === 'archived' ? ' (w archiwalnej wersji profilu)' : ''}.`;
    case 'proof':
      return e.valid ? `Podpis sprawdzony: wiadomość podpisano kluczem adresu ${shortAddress(e.address)}.` : `Podpis przy adresie ${shortAddress(e.address)} jest nieprawidłowy.`;
    case 'archive':
      return `Archiwum: profil ${e.handle ?? ''} w wersji z ${e.at.slice(0, 10)}.`;
    case 'history':
      return `Zmiana w czasie: ${e.changes[0]?.detail ?? ''}`;
    case 'account':
      return `Eksplorator: ${shortAddress(e.address)} to ${e.labels[0] ? `„${e.labels[0].name}”` : ACCOUNT_KIND[e.kind] ?? e.kind}.`;
    case 'identities':
      return `Ustalono, które konta należą do jednej osoby (${e.clusters.length === 1 ? '1 tożsamość' : `${e.clusters.length} tożsamości`}).`;
    case 'link':
      if (e.status === 'attributed') return `${shortAddress(e.address)}: Wskaźnik Pewności ${e.score}% — ${BAND[e.band]?.toLowerCase()}.`;
      return `${shortAddress(e.address)}: odrzucono — ${e.label ?? e.reason.toLowerCase()}.`;
    case 'ranked':
      return 'Adresy uporządkowane według pewności.';
    case 'trail':
      return `Z łańcucha bloków z powrotem do sieci: kto podał ukryty adres portfela ${shortAddress(e.address)}?`;
    case 'match':
      return e.detail;
    case 'name':
      return `Adres ${shortAddress(e.address)} ma w łańcuchu bloków nazwę ${e.name}${Object.keys(e.records).length ? `; jej rekordy wskazują: ${Object.values(e.records).slice(0, 2).join(', ')}` : ''}.`;
    case 'wallet':
      if (e.rule === 'D2') return `Ten sam klient giełdy: na adres depozytowy wpłacał też inny adres — razem ${e.members}.`;
      return `Portfel: z adresem ${shortAddress(e.address)} wydawane są środki z jeszcze ${e.members - 1} adresów — to jeden portfel.`;
    case 'estimate':
      return `Szacunek: do usług wyjścia trafiło łącznie ${pln(e.totalPln)}.`;
    case 'activity':
      return `Eksplorator: ${e.transfers} przelewów adresu ${shortAddress(e.address)}.`;
    case 'indicator':
      return `${e.title}: ${e.summary}`;
    case 'diff':
      return e.summary;
    case 'run.finished':
      return e.status === 'completed' ? 'Analiza zakończona.' : `Analiza przerwana: ${e.error ?? 'błąd'}.`;
  }
}
