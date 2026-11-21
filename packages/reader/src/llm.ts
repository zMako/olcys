/**
 * The language model behind the reader. It is one small interface on purpose: the tool does not depend on a
 * particular model. By default it talks to a model served on this machine (Bielik, a Polish open model, through
 * Ollama); pointing LLM_URL and LLM_MODEL elsewhere swaps it without touching the code.
 */
export interface LlmClient {
  /** Model name, recorded with everything the model produced. */
  name: string;
  complete(system: string, user: string): Promise<string>;
}

export interface OllamaOptions {
  url?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_LLM_MODEL = 'SpeakLeash/bielik-11b-v3.1-instruct:Q8_0';

export function createOllamaClient(opts: OllamaOptions = {}): LlmClient {
  const url = (opts.url ?? process.env.LLM_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  const model = opts.model ?? process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: model,
    async complete(system, user) {
      const res = await doFetch(`${url}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        body: JSON.stringify({ model, stream: false, options: { temperature: 0 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`Model językowy odpowiedział ${res.status}`);
      return ((await res.json()) as { message?: { content?: string } }).message?.content?.trim() ?? '';
    },
  };
}

/** True when a model is being served and answers. */
export async function llmAvailable(opts: OllamaOptions = {}): Promise<boolean> {
  const url = (opts.url ?? process.env.LLM_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  try {
    return (await (opts.fetchImpl ?? fetch)(`${url}/api/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** The first JSON object in a model's answer, or undefined. Models like to wrap JSON in prose or code fences. */
export function firstJson<T>(answer: string): T | undefined {
  const start = answer.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < answer.length; i++) {
    const ch = answer[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(answer.slice(start, i + 1)) as T;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
