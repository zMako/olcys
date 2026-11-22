/**
 * Presentation mode: covers personal data on screen — nicks, display names, on-chain names, addresses — so the tool
 * can be shown or recorded on real cases. It changes only what is drawn; the data and the report are untouched.
 */
const sensitive = new Set<string>();
let observer: MutationObserver | undefined;

const ADDRESS = /0x[0-9a-fA-F]{6}[0-9a-fA-F]*(?:…[0-9a-fA-F]{2,})?|\b(?:bc1|[13])[a-km-zA-HJ-NP-Z0-9]{6}[a-km-zA-HJ-NP-Z0-9]{3,}(?:…[a-zA-Z0-9]{2,})?/g;
const cover = (s: string) => `${s.slice(0, 2)}${'•'.repeat(Math.min(6, Math.max(3, s.length - 2)))}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function masked(text: string): string {
  let out = text.replace(ADDRESS, (a) => `${a.slice(0, 6)}…••••`);
  out = out.replace(/\bnr \d{4,}/g, 'nr ••••'); // account numbers identify a person as well as a nick does
  // longest first, so a name that contains a shorter one is covered whole
  for (const s of [...sensitive].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escape(s), 'gi'), cover(s));
  return out;
}

function sweep(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const next = masked(n.nodeValue ?? '');
    if (next !== n.nodeValue) n.nodeValue = next;
  }
}

/** Names what must be covered: called by the views as they learn who a case is about. */
export function markSensitive(values: (string | undefined)[]) {
  let added = false;
  for (const v of values) {
    const s = v?.trim();
    if (s && s.length >= 3 && !sensitive.has(s)) {
      sensitive.add(s);
      added = true;
    }
  }
  if (added && observer) sweep(document.body);
}

export function setMasking(on: boolean) {
  observer?.disconnect();
  observer = undefined;
  document.body.classList.toggle('masked', on);
  if (!on) return;
  sweep(document.body);
  observer = new MutationObserver((changes) => {
    for (const c of changes) {
      if (c.type === 'characterData') sweep(c.target.parentNode ?? c.target);
      else c.addedNodes.forEach((n) => sweep(n));
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
}
