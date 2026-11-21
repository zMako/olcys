/**
 * Sentence embeddings, computed on this machine. The model (multilingual-e5-small, 118 MB, MIT licence) turns a
 * sentence in any of about a hundred languages into 384 numbers; sentences that mean similar things land close together.
 * Nothing leaves the machine: after the first download the model is read from a local folder.
 */
export interface Embedder {
  name: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbedderOptions {
  model?: string;
  /** Folder with the model files. Set it to run without any network access. */
  cacheDir?: string;
  /** Refuse to download: only use files already in `cacheDir`. */
  offline?: boolean;
  batch?: number;
}

let shared: Promise<Embedder> | undefined;

export async function createEmbedder(opts: EmbedderOptions = {}): Promise<Embedder> {
  const { pipeline, env } = await import('@huggingface/transformers');
  if (opts.cacheDir ?? process.env.READER_MODEL_DIR) env.cacheDir = (opts.cacheDir ?? process.env.READER_MODEL_DIR)!;
  if (opts.offline ?? process.env.READER_OFFLINE === '1') env.allowRemoteModels = false;
  const name = opts.model ?? process.env.READER_MODEL ?? 'Xenova/multilingual-e5-small';
  const extract = await pipeline('feature-extraction', name, { dtype: 'q8' });
  const batch = opts.batch ?? 64;
  return {
    name,
    dim: 384,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batch) {
        // The model was trained with this prefix for comparing sentences with each other.
        const part = texts.slice(i, i + batch).map((t) => `query: ${t.replace(/\s+/g, ' ').slice(0, 1200)}`);
        const tensor = await extract(part, { pooling: 'mean', normalize: true });
        const [n, dim] = tensor.dims as [number, number];
        const data = tensor.data as Float32Array;
        for (let r = 0; r < n; r++) out.push(data.slice(r * dim, (r + 1) * dim));
      }
      return out;
    },
  };
}

/** One embedder per process: loading the model takes a few seconds. */
export const sharedEmbedder = (opts?: EmbedderOptions): Promise<Embedder> => (shared ??= createEmbedder(opts));
