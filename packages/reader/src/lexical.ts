/**
 * Three plain signs that a sentence is someone speaking about their own crypto, in Polish or English:
 * it names an asset or an amount, it is in the first person, and it has a verb of buying, selling, holding or receiving.
 * They are cheap, readable, and — with only a handful of real examples to learn from — stronger than anything
 * a model can learn on its own. The classifier gets them next to the sentence embedding.
 */
const ASSET = /\$[A-Za-z]{2,10}\b|\b(btc|eths?|usdt|usdc|sol|bitcoin\w*|ethereum|token\w*|coin\w*|nft\w*|airdrop\w*|drop\w*|krypto\w*|crypto|degen|stablecoin\w*|bags?|gem\w*|mcap|portfel\w*|wallet|satoshi|sats)\b|\d[\d.,]*\s?(k|usd|pln|zł|eur)\b|[$€]\s?\d|\d\s?[$€]|-?\d+\s?%|\bx\d+\b/i;
const FIRST_PERSON = /\b(i|i['’]m|i['’]ve|my|me|mine)\b|(?<![\p{L}])(ja|mnie|mi|mój|moje|moja|moich|mam|u mnie|sobie)(?![\p{L}])|[\p{L}]{2,}(łem|łam)(?![\p{L}])|(?<![\p{L}])[\p{L}]{3,}(uję|am|ałem)(?![\p{L}])/iu;
const VERB = /\b(bought|buy|buying|sold|sell|selling|aped|ape|swapped|swap|cashed|hold|holding|hodl\w*|staked|stake|claimed|received|get|got|earned|made|profit|entry|bags?|dca|own)\b|(?<![\p{L}])(kupi[\p{L}]+|kupuj[\p{L}]+|dokup[\p{L}]+|sprzeda[\p{L}]+|spuści[\p{L}]+|trzyma[\p{L}]+|mam|zarobi[\p{L}]+|odbier[\p{L}]+|wpad[\p{L}]+|dosta[\p{L}]+|wypłac[\p{L}]+|wymieni[\p{L}]+|zamieni[\p{L}]+|stak[\p{L}]+|zysk[\p{L}]*|strat[\p{L}]*|poszł[\p{L}]+|wymint[\p{L}]+)(?![\p{L}])/iu;

export interface LexicalSigns {
  asset: boolean;
  firstPerson: boolean;
  verb: boolean;
}

export function lexicalSigns(text: string): LexicalSigns {
  return { asset: ASSET.test(text), firstPerson: FIRST_PERSON.test(text), verb: VERB.test(text) };
}

export const signCount = (s: LexicalSigns): number => Number(s.asset) + Number(s.firstPerson) + Number(s.verb);

/** The embedding with the three signs appended, each weighted so it can speak as loudly as the whole embedding. */
export function withSigns(vector: ArrayLike<number>, text: string, weight = 1): Float32Array {
  const s = lexicalSigns(text);
  const out = new Float32Array(vector.length + 4);
  out.set(vector as ArrayLike<number> as Float32Array);
  out[vector.length] = s.asset ? weight : 0;
  out[vector.length + 1] = s.firstPerson ? weight : 0;
  out[vector.length + 2] = s.verb ? weight : 0;
  out[vector.length + 3] = signCount(s) === 3 ? weight : 0;
  return out;
}
