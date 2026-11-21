// Trains and measures the statement classifier.
//   npm run reader -- train [--data .corpus/reader]     labelled posts → model file, with measured precision and recall
//   npm run reader -- second [--data .corpus/reader]    how often the language model agrees with the labels
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { crossValidate, trainSoftmax } from './classifier';
import { sharedEmbedder } from './embed';
import { createOllamaClient } from './llm';
import { DEFAULT_MODEL_PATH, KINDS, readWithLlm, type StatementKind } from './statements';
import { lexicalSigns, signCount, withSigns } from './lexical';
import { findTemplates, looksAppGenerated, templateSignature } from './templates';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const dir = flag('data') ?? '.corpus/reader';

/** Labelled examples: texts from to-label-N.jsonl joined with labels-N.jsonl by id. */
function examples(): { id: string; text: string; label: StatementKind }[] {
  const out: { id: string; text: string; label: StatementKind }[] = [];
  for (const file of readdirSync(dir).filter((f) => /^to-label-.*\.jsonl$/.test(f)).sort()) {
    const labels = `${dir}/${file.replace('to-label-', 'labels-')}`;
    if (!existsSync(labels)) continue;
    const byId = new Map(readFileSync(labels, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; label: string }).map((x) => [x.id, x.label]));
    for (const line of readFileSync(`${dir}/${file}`, 'utf8').split('\n').filter(Boolean)) {
      const { id, text } = JSON.parse(line) as { id: string; text: string };
      const label = byId.get(id);
      if (label && (KINDS as readonly string[]).includes(label)) out.push({ id, text, label: label as StatementKind });
    }
  }
  return out;
}

if (command === 'train') {
  // Every post of the corpus, to learn which openings are app templates (shared across accounts or repeated by one).
  const corpus = flag('corpus') ?? '.corpus/farcaster';
  const seen = new Set<string>();
  const posts: { author: string; text: string }[] = [];
  for (const f of ['casts-early.jsonl', 'casts.jsonl']) {
    if (!existsSync(`${corpus}/${f}`)) continue;
    for (const line of readFileSync(`${corpus}/${f}`, 'utf8').split('\n').filter(Boolean)) {
      const c = JSON.parse(line) as { fid: number; hash: string; text: string };
      if (!seen.has(c.hash) && seen.add(c.hash)) posts.push({ author: String(c.fid), text: c.text });
    }
  }
  const templates = findTemplates(posts);
  const generated = (t: string) => looksAppGenerated(t) || templates.has(templateSignature(t) ?? '');
  console.log(`Korpus: ${posts.length} wpisów ${new Set(posts.map((p) => p.author)).size} kont; szablonów ${templates.size}; wpisów pisanych przez aplikacje ${posts.filter((p) => generated(p.text)).length}.`);

  // Labelled posts, without the app-generated ones. A post counts as a statement only if it was confirmed on a second reading.
  const confirmed = new Set((JSON.parse(readFileSync(`${dir}/adjudicated.json`, 'utf8')) as { positive: string[] }).positive);
  const data = examples().filter((d) => !generated(d.text));
  const labels = ['inne', 'własne'];
  const y = data.map((d) => (confirmed.has(d.id) ? 1 : 0));
  const positives = y.filter(Boolean).length;
  console.log(`Przykłady po odsianiu: ${data.length}, w tym wypowiedzi o własnych kryptowalutach: ${positives}.`);
  const embedder = await sharedEmbedder();
  const started = Date.now();
  const plain = await embedder.embed(data.map((d) => d.text));
  console.log(`Osadzono ${plain.length} zdań w ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  // Next to the embedding, three lexical signs: an asset, the first person, a verb of buying, selling, holding or receiving.
  const X = flag('no-signs') !== undefined || rest.includes('--no-signs') ? plain : plain.map((v, i) => withSigns(v, data[i].text));
  const strict = data.filter((d) => signCount(lexicalSigns(d.text)) === 3);
  console.log(`Same znaki leksykalne (wszystkie trzy): ${strict.length} wpisów, w tym ${strict.filter((d) => confirmed.has(d.id)).length} z ${positives} wypowiedzi.`);

  // Measured on posts the model did not see in training (5-fold cross-validation), as a ranking:
  // if the analyst — or the language model — reads only the top share of posts, how many statements are among them?
  const opts = { maxClassWeight: Number(flag('weight') ?? 12), l2: Number(flag('l2') ?? 0.002) };
  const cv = crossValidate(X, y, labels, 5, opts);
  const order = cv.probabilities.map((p, i) => ({ i, score: p[1] })).sort((a, b) => b.score - a.score);
  const ranking = [0.02, 0.05, 0.1, 0.2].map((share) => {
    const top = order.slice(0, Math.ceil(order.length * share));
    const found = top.filter((o) => y[o.i] === 1).length;
    return { read: `${Math.round(share * 100)}% wpisów (${top.length})`, found: `${found} z ${positives}`, recall: Math.round((found / positives) * 100) / 100, precision: Math.round((found / top.length) * 100) / 100, threshold: Math.round(top[top.length - 1].score * 1000) / 1000 };
  });
  console.table(ranking);
  const missed = order.slice(Math.ceil(order.length * 0.1)).filter((o) => y[o.i] === 1).map((o) => data[o.i].text.slice(0, 100));
  if (missed.length) console.log('Poza pierwszymi 10%:', missed);

  const model = trainSoftmax(X, y, labels, opts);
  const threshold = ranking[2].threshold; // read the top tenth
  model.meta = {
    embedder: embedder.name, features: X === plain ? 'embedding' : 'embedding + lexical signs', trainedAt: new Date().toISOString(), examples: data.length, positives, threshold, templates: [...templates],
    data: 'publiczne wpisy polskich kont w sieci Farcaster, bez wpisów generowanych przez aplikacje; etykiety nadane przez model językowy według pisemnej instrukcji i potwierdzone w drugim czytaniu',
    crossValidation: { folds: 5, ranking },
  };
  writeFileSync(flag('out') ?? DEFAULT_MODEL_PATH, JSON.stringify(model));
  console.log(`Zapisano model: ${flag('out') ?? DEFAULT_MODEL_PATH} (próg ${threshold})`);
} else if (command === 'second') {
  // The language model as second reader, measured against the labels on a sample.
  const data = examples();
  const positives = data.filter((d) => d.label !== 'inne');
  const negatives = data.filter((d) => d.label === 'inne').slice(0, Number(flag('negatives') ?? 40));
  const llm = createOllamaClient();
  let [agreeKind, agreeRelevant, n] = [0, 0, 0];
  const rows: { label: string; llm: string; text: string }[] = [];
  const started = Date.now();
  for (const d of [...positives.slice(0, Number(flag('positives') ?? 60)), ...negatives]) {
    const r = await readWithLlm(llm, { text: d.text });
    if (!r) continue;
    n++;
    const kind = r.concernsAuthor ? r.kind : 'inne';
    if (kind === d.label) agreeKind++;
    if ((kind === 'inne') === (d.label === 'inne')) agreeRelevant++;
    else rows.push({ label: d.label, llm: kind, text: d.text.slice(0, 90) });
  }
  console.log(`${llm.name}: ${n} wpisów w ${Math.round((Date.now() - started) / 1000)} s; zgodność co do rodzaju ${Math.round((agreeKind / n) * 100)}%, co do tego, czy wpis dotyczy własnych transakcji ${Math.round((agreeRelevant / n) * 100)}%.`);
  console.table(rows.slice(0, 25));
} else {
  console.log('Użycie: npm run reader -- <train|second> [--data .corpus/reader]');
}
