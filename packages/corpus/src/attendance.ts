import type { AddressAttestation } from '@olcys/core';
import { readPoapHolders } from './poap';

/**
 * Attendance tokens of events held in Poland, as a statement about an address: the wallet received a token that
 * an organiser hands out at the venue. It places the wallet's holder at an event in Poland; it does not say
 * who they are or where they live. Events marked as online are left out.
 */
export function attendanceLookup(root: string): (address: string) => AddressAttestation[] {
  let index: Map<string, ReturnType<typeof readPoapHolders>> | undefined;
  return (address) => {
    if (!index) {
      index = new Map();
      for (const h of readPoapHolders(root)) {
        if (h.virtual) continue;
        const key = h.wallet.toLowerCase();
        index.set(key, [...(index.get(key) ?? []), h]);
      }
    }
    const held = (index.get(address.toLowerCase()) ?? []).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    if (!held.length) return [];
    const events = [...new Map(held.map((h) => [h.dropId, `${h.drop}${h.city ? `, ${h.city}` : ''}${h.date ? ` (${h.date.slice(0, 10)})` : ''}`])).values()];
    return [{
      chain: 'ethereum', address, issuer: 'POAP', claim: 'event_attendance', value: events.slice(0, 6).join('; '), uid: `POAP-PL-${address}`, at: held[0].mintedAt ?? held[0].date,
      sourceUrl: `https://collectors.poap.xyz/scan/${address}`,
      note: `portfel odebrał ${events.length === 1 ? 'token obecności' : `tokeny obecności z ${events.length} wydarzeń`} w Polsce, wydawane uczestnikom na miejscu: ${events.slice(0, 6).join('; ')}${events.length > 6 ? ' i inne' : ''}`,
    }];
  };
}
