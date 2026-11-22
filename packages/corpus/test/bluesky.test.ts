import { describe, expect, it } from 'vitest';
import { judgeBlueskyAccount, walletNamesIn } from '../src/bluesky';

const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const account = (description: string, displayName = 'Ola', handle = 'ola.bsky.social') => ({ did: 'did:plc:x', handle, displayName, description, followers: 0, follows: 0, posts: 0 });

describe('Bluesky accounts that state a wallet', () => {
  it('finds wallet names, and nothing that only looks like one', () => {
    expect(walletNamesIn('Napiwki: Mokotowska.eth, także mokotowska.base.eth i https://mokotowska.eth.limo')).toEqual(['mokotowska.eth', 'mokotowska.base.eth']);
    // a university, an e-mail address, a bare ticker and a two-letter label are not wallet names
    expect(walletNamesIn('Professor at ETH Zurich. Kontakt: ola@poczta.eth-zurich.example, lubię ETH. ab.eth')).toEqual([]);
  });

  it('keeps the Polish score, the names and the addresses apart', () => {
    const polish = judgeBlueskyAccount(account(`Jestem programistką z Warszawy, piszę o kryptowalutach. Portfel: mokotowska.eth albo ${ETH}`));
    expect(polish.polish.score).toBeGreaterThanOrEqual(0.5);
    expect(polish).toMatchObject({ names: ['mokotowska.eth'], addresses: [ETH] });
    // a wallet name in the display name counts; an English description does not make the account Polish
    const foreign = judgeBlueskyAccount(account('Artist and designer, exploring things.', '0009.eth'));
    expect(foreign.names).toEqual(['0009.eth']);
    expect(foreign.polish.score).toBeLessThan(0.5);
    // a handle on a .pl domain is a sign of its own
    expect(judgeBlueskyAccount(account('', 'Ola', 'ola.example.pl')).polish.reasons.join(' ')).toContain('.pl');
  });
});
