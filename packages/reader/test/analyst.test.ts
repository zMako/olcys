import { describe, expect, it } from 'vitest';
import type { Finding, Lead, ProfileCard } from '@olcys/core';
import { checkSentence, judgeSamePerson, numbersIn, parseSentences, rankLeads, writeGrounded, type LlmClient } from '../src';

const findings: Finding[] = [
  { id: 'U1', layer: 'fact', text: 'Wprowadzono: nick „szklane_domy”.' },
  { id: 'U2', layer: 'computed', text: 'Adres 0x60EDB7Cf…CECFEC (Ethereum): Wskaźnik Pewności 100%, bardzo wysokie, potwierdzony podpisem sprawdzonym matematycznie.' },
  { id: 'U3', layer: 'fact', text: 'Coinbase publicznie poświadcza, że adres 0x60EDB7Cf…CECFEC należy do klienta zweryfikowanego w kraju PL (poświadczenie z 2025-09-17).' },
  { id: 'U4', layer: 'conclusion', text: 'Wartość do wyjaśnienia: 2024: 2997 zł; 2025: 8075 zł; razem 11 072 zł.' },
];

/** A model that answers with what the test tells it to, in order. */
const scripted = (...answers: string[]): LlmClient & { asked: string[] } => {
  const asked: string[] = [];
  return { name: 'test-model', local: true, available: async () => true, asked, complete: async (_system, user) => (asked.push(user), answers.shift() ?? '{}') };
};
const json = (zdania: { tekst: string; ustalenia: string[] }[]) => JSON.stringify({ zdania });

describe('numbers in a sentence', () => {
  it('reads amounts the way they are written in Polish and ignores digits inside addresses', () => {
    expect(numbersIn('razem 11 072 zł, czyli 8 075 zł i 0,19 ETH w 2025 r.')).toEqual(['11072', '8075', '0.19', '2025']);
    expect(numbersIn('adres 0x60EDB7Cf…CECFEC ma 100%')).toEqual(['100']);
  });
});

describe('a sentence must stand on the findings it names', () => {
  it('accepts a sentence whose numbers and addresses are in the cited findings', () => {
    expect(checkSentence({ text: 'Adres 0x60EDB7Cf…CECFEC powiązano z pewnością 100%.', cites: ['U2'] }, findings)).toBeUndefined();
    expect(checkSentence({ text: 'Wartość do wyjaśnienia wynosi razem 11 072 zł.', cites: ['U4'] }, findings)).toBeUndefined();
  });
  it('rejects a sentence without a finding, with an unknown one, with a number from nowhere, with a foreign address, and with a legal claim', () => {
    expect(checkSentence({ text: 'Osoba ma konto na giełdzie.', cites: [] }, findings)).toMatch(/nie wskazuje/);
    expect(checkSentence({ text: 'Osoba ma konto na giełdzie.', cites: ['U9'] }, findings)).toMatch(/którego nie ma: U9/);
    expect(checkSentence({ text: 'Wartość do wyjaśnienia wynosi 15 000 zł.', cites: ['U4'] }, findings)).toMatch(/liczbę.*15000/);
    expect(checkSentence({ text: 'Kwotę 11 072 zł przypisano adresowi.', cites: ['U2'] }, findings)).toMatch(/liczbę/); // right number, wrong finding
    expect(checkSentence({ text: 'Adres 0xAbCd1234…99 należy do osoby.', cites: ['U2'] }, findings)).toMatch(/adres/);
    expect(checkSentence({ text: 'Kwota 11 072 zł podlega opodatkowaniu.', cites: ['U4'] }, findings)).toMatch(/ocenę prawną/);
  });
});

describe('reading the model’s answer', () => {
  it('takes JSON, and falls back to lines with marks', () => {
    expect(parseSentences('Oto opis:\n```json\n' + json([{ tekst: 'Wprowadzono nick [U1].', ustalenia: ['U1'] }]) + '\n```')).toEqual([{ text: 'Wprowadzono nick.', cites: ['U1'] }]);
    expect(parseSentences('Wprowadzono nick szklane_domy [U1].\nCoinbase poświadcza adres (U3).')).toEqual([
      { text: 'Wprowadzono nick szklane_domy.', cites: ['U1'] },
      { text: 'Coinbase poświadcza adres.', cites: ['U3'] },
    ]);
  });
});

describe('grounded writing', () => {
  it('keeps what passes, sends the rest back once, and reports what stayed rejected', async () => {
    const llm = scripted(
      json([
        { tekst: 'Wprowadzono nick „szklane_domy”.', ustalenia: ['U1'] },
        { tekst: 'Osoba uchyla się od opodatkowania kwoty 11 072 zł.', ustalenia: ['U4'] },
        { tekst: 'Wartość do wyjaśnienia to 12 000 zł.', ustalenia: ['U4'] },
      ]),
      json([
        { tekst: 'Wartość do wyjaśnienia wynosi razem 11 072 zł.', ustalenia: ['U4'] },
        { tekst: 'Osoba jest winna.', ustalenia: ['U4'] },
      ]),
    );
    const out = await writeGrounded(llm, findings, 'Piszesz opis sprawy.');
    expect(out.sentences.map((s) => s.text)).toEqual(['Wprowadzono nick „szklane_domy”.', 'Wartość do wyjaśnienia wynosi razem 11 072 zł.']);
    expect(out.rejected.map((r) => r.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/ocenę prawną/), expect.stringMatching(/liczbę/)]));
    expect(llm.asked).toHaveLength(2);
    expect(llm.asked[1]).toContain('zostały odrzucone');
  });
  it('asks once when everything passes', async () => {
    const llm = scripted(json([{ tekst: 'Coinbase poświadcza adres 0x60EDB7Cf…CECFEC, kraj PL.', ustalenia: ['U3'] }]));
    expect((await writeGrounded(llm, findings, 'x')).rejected).toEqual([]);
    expect(llm.asked).toHaveLength(1);
  });
});

describe('ordering leads', () => {
  const leads: Lead[] = [
    { id: 'T1', kind: 'unconfirmed', text: 'Potwierdzić konto szklanedomy-krk w serwisie Kodownia.', basis: [] },
    { id: 'T2', kind: 'attestation_request', text: 'Wystąpić do Coinbase o dane klienta adresu 0x60EDB7Cf…CECFEC.', basis: ['U3'] },
    { id: 'T3', kind: 'address', text: 'Wzmocnić powiązanie adresu.', basis: [] },
  ];
  it('takes the model’s order, ignores leads it made up, and keeps the ones it forgot', async () => {
    const llm = scripted(JSON.stringify({ kolejnosc: [{ trop: 'T2', powod: 'Coinbase zna tożsamość klienta.' }, { trop: 'T9', powod: 'wymyślony' }, { trop: 'T1', powod: 'Wynik wzrośnie do 250%.' }, { trop: 'T2', powod: 'powtórka' }] }));
    const out = await rankLeads(llm, leads, findings);
    expect(out.byModel).toBe(true);
    expect(out.leads.map((l) => l.id)).toEqual(['T2', 'T1', 'T3']);
    expect(out.leads[0].reason).toBe('Coinbase zna tożsamość klienta.');
    expect(out.leads[1].reason).toBe(''); // a number from nowhere: the reason is dropped, the lead stays
  });
  it('keeps the rule-based order when the model’s answer is unusable', async () => {
    const out = await rankLeads(scripted('nie wiem'), leads, findings);
    expect(out.byModel).toBe(false);
    expect(out.leads.map((l) => l.id)).toEqual(['T1', 'T2', 'T3']);
  });
});

describe('comparing two accounts', () => {
  const known: ProfileCard[] = [{ origin: 'bitrozmowy', service: 'BitRozmowy', handle: 'szklane_domy', profile: 'Kraków. Programista, piszę kontrakty w Solidity.', posts: ['Sprzedam koparkę, odbiór Kraków Podgórze.'] }];
  const candidate: ProfileCard = { origin: 'kodownia', service: 'Kodownia', handle: 'szklanedomy-krk', displayName: 'SD', profile: 'Solidity dev z Krakowa', posts: ['Nowy kontrakt w Solidity gotowy.'] };
  it('accepts a verdict only with quotes that are really in both accounts', async () => {
    const llm = scripted(JSON.stringify({ werdykt: 'ta_sama', dowody: [
      { co: 'zawód', cytat_osoba: 'piszę kontrakty w Solidity', cytat_kandydat: 'Solidity dev' },
      { co: 'miasto', cytat_osoba: 'mieszkam w Gdańsku', cytat_kandydat: 'z Krakowa' },
    ] }));
    const j = await judgeSamePerson(llm, known, candidate);
    expect(j.verdict).toBe('same');
    expect(j.reasons).toHaveLength(1);
    expect(j.reasons[0]).toContain('Solidity dev');
    expect(j.rejected).toBe(1);
  });
  it('does not take two different addresses, or the same display name, as evidence of one person', async () => {
    const a: ProfileCard[] = [{ origin: 'kodownia', service: 'Kodownia', handle: 'szklanedomy', displayName: 'Cezary Baryka', profile: 'BTC: bc1qmc5untqdkm6knvl869y0dv6642y5e4lh9qenwr', posts: [] }];
    const b: ProfileCard = { origin: 'forum', service: 'Forum', handle: 'czarek_b', displayName: 'Cezary Baryka', profile: 'BTC: bc1qq4ssxcx5plwaeh9jupqf002n2lzw0zqkntksqs', posts: [] };
    const j = await judgeSamePerson(scripted(JSON.stringify({ werdykt: 'ta_sama', dowody: [
      { co: 'adres', cytat_osoba: 'BTC: bc1qmc5untqdkm6knvl869y0dv6642y5e4lh9qenwr', cytat_kandydat: 'BTC: bc1qq4ssxcx5plwaeh9jupqf002n2lzw0zqkntksqs' },
      { co: 'nazwa', cytat_osoba: 'Cezary Baryka', cytat_kandydat: 'Cezary Baryka' },
    ] })), a, b);
    expect(j).toMatchObject({ verdict: 'unclear', reasons: [], rejected: 2 });
  });
  it('turns a verdict without real evidence into "unclear", and does not count the nick as evidence', async () => {
    const invented = await judgeSamePerson(scripted(JSON.stringify({ werdykt: 'ta_sama', dowody: [{ co: 'styl', cytat_osoba: 'lubię góry', cytat_kandydat: 'kocham Tatry' }] })), known, candidate);
    expect(invented).toMatchObject({ verdict: 'unclear', reasons: [], rejected: 1 });
    const nick = await judgeSamePerson(scripted(JSON.stringify({ werdykt: 'ta_sama', dowody: [{ co: 'nick', cytat_osoba: 'szklane_domy', cytat_kandydat: 'szklanedomy-krk' }] })), known, candidate);
    expect(nick.verdict).toBe('unclear');
  });
});
