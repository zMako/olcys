/**
 * A small classifier on top of sentence embeddings: one weight vector per label (multinomial logistic regression).
 * It is trained here, on labelled real posts, in seconds; it reads thousands of sentences a second; and its
 * whole content is a table of numbers that can be inspected and retrained.
 */
export interface LinearModel {
  labels: string[];
  dim: number;
  weights: number[][];
  bias: number[];
  meta?: Record<string, unknown>;
}

export interface TrainOptions {
  epochs?: number;
  rate?: number;
  /** Penalty on large weights; keeps a model trained on few examples from memorising them. */
  l2?: number;
  /** Rare labels count for more, up to this factor, so the common "nothing here" label does not drown them. */
  maxClassWeight?: number;
}

export function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

export function predict(model: LinearModel, x: ArrayLike<number>): number[] {
  return softmax(model.weights.map((w, k) => {
    let z = model.bias[k];
    for (let j = 0; j < model.dim; j++) z += w[j] * x[j];
    return z;
  }));
}

export function trainSoftmax(X: ArrayLike<number>[], y: number[], labels: string[], opts: TrainOptions = {}): LinearModel {
  const [n, dim, k] = [X.length, X[0].length, labels.length];
  const { epochs = 300, rate = 2, l2 = 0.002, maxClassWeight = 8 } = opts;
  const counts = Array<number>(k).fill(0);
  for (const c of y) counts[c]++;
  const classWeight = counts.map((c) => (c ? Math.min(maxClassWeight, n / (k * c)) : 0));
  const total = y.reduce((s, c) => s + classWeight[c], 0);
  const W = Array.from({ length: k }, () => new Float64Array(dim));
  const b = new Float64Array(k);
  const [mW, mb] = [Array.from({ length: k }, () => new Float64Array(dim)), new Float64Array(k)];
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gW = Array.from({ length: k }, () => new Float64Array(dim));
    const gb = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      const x = X[i];
      const z = Array<number>(k);
      for (let c = 0; c < k; c++) {
        let s = b[c];
        const w = W[c];
        for (let j = 0; j < dim; j++) s += w[j] * x[j];
        z[c] = s;
      }
      const p = softmax(z);
      const cw = classWeight[y[i]] / total;
      for (let c = 0; c < k; c++) {
        const d = (p[c] - (c === y[i] ? 1 : 0)) * cw;
        if (d === 0) continue;
        gb[c] += d;
        const g = gW[c];
        for (let j = 0; j < dim; j++) g[j] += d * x[j];
      }
    }
    for (let c = 0; c < k; c++) {
      mb[c] = 0.9 * mb[c] + gb[c];
      b[c] -= rate * mb[c];
      for (let j = 0; j < dim; j++) {
        mW[c][j] = 0.9 * mW[c][j] + gW[c][j] + l2 * W[c][j];
        W[c][j] -= rate * mW[c][j];
      }
    }
  }
  return { labels, dim, weights: W.map((w) => Array.from(w, (v) => Math.round(v * 1e5) / 1e5)), bias: Array.from(b, (v) => Math.round(v * 1e5) / 1e5) };
}

export interface LabelMetrics {
  label: string;
  examples: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Precision and recall per label from true and predicted labels. */
export function metricsOf(truth: number[], predicted: number[], labels: string[]): LabelMetrics[] {
  return labels.map((label, c) => {
    let [tp, fp, fn] = [0, 0, 0];
    for (let i = 0; i < truth.length; i++) {
      if (predicted[i] === c && truth[i] === c) tp++;
      else if (predicted[i] === c) fp++;
      else if (truth[i] === c) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return { label, examples: tp + fn, precision: r(precision), recall: r(recall), f1: r(precision + recall ? (2 * precision * recall) / (precision + recall) : 0) };
  });
}

/**
 * Honest measurement on few examples: the data is split into `folds` parts; each part in turn is held back,
 * the model is trained on the rest and asked about the part it has not seen. Returns the prediction for every example.
 */
export function crossValidate(X: ArrayLike<number>[], y: number[], labels: string[], folds = 5, opts: TrainOptions = {}): { predicted: number[]; probabilities: number[][] } {
  const predicted = Array<number>(y.length).fill(0);
  const probabilities: number[][] = Array.from({ length: y.length }, () => []);
  // stratified: each fold gets its share of every label
  const fold = Array<number>(y.length).fill(0);
  const seen = Array<number>(labels.length).fill(0);
  y.forEach((c, i) => (fold[i] = seen[c]++ % folds));
  for (let f = 0; f < folds; f++) {
    const train = y.map((_, i) => i).filter((i) => fold[i] !== f);
    const model = trainSoftmax(train.map((i) => X[i]), train.map((i) => y[i]), labels, opts);
    y.forEach((_, i) => {
      if (fold[i] !== f) return;
      const p = predict(model, X[i]);
      probabilities[i] = p;
      predicted[i] = p.indexOf(Math.max(...p));
    });
  }
  return { predicted, probabilities };
}
