import { describe, expect, it } from 'vitest';
import { extractAddresses, findSignedMessages, signBitcoinMessage, signEthereumMessage, usernameVariants, verifySignedMessage } from '@olcys/core';
import { adPhoto, generateWorld, makeWallet } from '@olcys/world';
import { readImage } from '../src';

describe('reading images', () => {
  it('reads a wallet address from the QR code on a photo', () => {
    const w = makeWallet('t', 'btc-segwit', 'a');
    const found = readImage(adPhoto(5012, `bitcoin:${w.address}?label=Antminer`), 'image/png');
    expect(found).toEqual([{ kind: 'qr', text: `bitcoin:${w.address}?label=Antminer` }]);
    expect(extractAddresses(found[0].text).map((m) => m.address)).toEqual([w.address]);
  });

  it('finds nothing on a photo without a code, and survives junk', () => {
    expect(readImage(adPhoto(5013), 'image/png')).toEqual([]);
    expect(readImage(new Uint8Array([1, 2, 3, 4]), 'image/png')).toEqual([]);
    expect(readImage(new Uint8Array(0), 'text/html')).toEqual([]);
  });

  it('reads every QR photo in the synthetic world', () => {
    const ads = generateWorld().ads.ads.filter((a) => a.qr);
    expect(ads.length).toBeGreaterThan(2);
    for (const a of ads) expect(readImage(adPhoto(a.id, a.qr), 'image/png')[0]?.text, String(a.id)).toBe(a.qr);
  });
});

describe('signed messages', () => {
  const legacy = makeWallet('t', 'btc-legacy', 'a');
  const segwit = makeWallet('t', 'btc-segwit', 'a');
  const eth = makeWallet('t', 'eth', 'a');
  const msg = 'Ja, szklane_domy, potwierdzam, że to mój adres. Zażółć gęślą jaźń.';

  it('verifies genuine Bitcoin and Ethereum signatures', () => {
    expect(verifySignedMessage({ message: msg, address: legacy.address, signature: signBitcoinMessage(msg, legacy.privateKeyHex, 'p2pkh') })).toMatchObject({ valid: true, chain: 'bitcoin' });
    expect(verifySignedMessage({ message: msg, address: segwit.address, signature: signBitcoinMessage(msg, segwit.privateKeyHex, 'p2wpkh') })).toMatchObject({ valid: true });
    expect(verifySignedMessage({ message: msg, address: eth.address, signature: signEthereumMessage(msg, eth.privateKeyHex) })).toMatchObject({ valid: true, chain: 'ethereum', address: eth.address });
  });

  it('rejects a changed message, a signature by another key, and garbage', () => {
    const sig = signBitcoinMessage(msg, legacy.privateKeyHex);
    expect(verifySignedMessage({ message: msg + '!', address: legacy.address, signature: sig })).toMatchObject({ valid: false });
    expect(verifySignedMessage({ message: msg, address: segwit.address.replace(/.$/, 'x'), signature: sig }).valid).toBe(false);
    expect(verifySignedMessage({ message: msg, address: makeWallet('t', 'btc-legacy', 'b').address, signature: sig })).toMatchObject({ valid: false, reason: 'podpis nie pochodzi od klucza tego adresu' });
    expect(verifySignedMessage({ message: msg, address: eth.address, signature: '0x1234' }).valid).toBe(false);
    expect(verifySignedMessage({ message: msg, address: legacy.address, signature: 'not-base64!!' }).valid).toBe(false);
  });

  it('finds both the wallet block and the three-line forum form in text', () => {
    const sig = signBitcoinMessage(msg, legacy.privateKeyHex);
    const ethSig = signEthereumMessage('krótka', eth.privateKeyHex);
    const text = `Cześć,\n-----BEGIN BITCOIN SIGNED MESSAGE-----\n${msg}\n-----BEGIN SIGNATURE-----\n${legacy.address}\n${sig}\n-----END BITCOIN SIGNED MESSAGE-----\noraz\nWiadomość: krótka\nAdres: ${eth.address}\nPodpis: ${ethSig}\nkoniec`;
    const found = findSignedMessages(text);
    expect(found.map((f) => [f.message, f.address])).toEqual([[msg, legacy.address], ['krótka', eth.address]]);
    expect(found.every((f) => verifySignedMessage(f).valid)).toBe(true);
  });

  it('the synthetic world carries one bound proof, one unbound and one forgery', () => {
    const world = generateWorld();
    expect(world.proofs.map((p) => [p.valid, p.namesAccount])).toEqual([[true, true], [true, false], [false, true]]);
    const posts = world.forum.threads.flatMap((t) => t.posts);
    for (const p of world.proofs) {
      const found = findSignedMessages(posts.find((x) => x.id === p.postId)!.text);
      expect(found).toHaveLength(1);
      expect(verifySignedMessage(found[0]).valid).toBe(p.valid);
    }
  });
});

describe('nick variants', () => {
  it('produces other spellings only for nicks with separators', () => {
    expect(usernameVariants('szklane_domy').sort()).toEqual(['szklane-domy', 'szklane.domy', 'szklanedomy']);
    expect(usernameVariants('Krypto-Wilk_92').sort()).toEqual(['krypto-wilk-92', 'krypto.wilk.92', 'krypto_wilk_92', 'kryptowilk92']);
    expect(usernameVariants('szklanedomy')).toEqual([]);
  });
});
