import Anthropic from '@anthropic-ai/sdk';

/**
 * The language model behind the reader. It is one small interface on purpose: the tool does not depend on a
 * particular model. By default it talks to a model served on this machine (Bielik, a Polish open model, through
 * Ollama); pointing LLM_URL and LLM_MODEL elsewhere swaps it without touching the code. With ANTHROPIC_API_KEY set
 * it uses Claude through the Anthropic API instead — the findings then leave the machine.
 */
export interface LlmClient {
  /** Model name, recorded with everything the model produced. */
  name: string;
  /** True when the model runs on this machine; false when the findings are sent to an outside service. */
  local: boolean;
  complete(system: string, user: string): Promise<string>;
  /** True when the model is being served and answers. */
  available(): Promise<boolean>;
}

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

export interface ClaudeOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/** Claude through the Anthropic API. The key is read from ANTHROPIC_API_KEY and never stored. */
export function createClaudeClient(opts: ClaudeOptions = {}): LlmClient {
  const client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY, timeout: opts.timeoutMs ?? 240_000 });
  const model = opts.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL;
  return {
    name: model,
    local: false,
    async complete(system, user) {
      const res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        // a declined request is re-run on a fallback model chosen by the API, inside the same call
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content: user }],
      });
      if (res.stop_reason === 'refusal') throw new Error('Model językowy odmówił odpowiedzi');
      return res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
    },
    async available() {
      return !!(opts.apiKey ?? process.env.ANTHROPIC_API_KEY);
    },
  };
}

/** Claude when an Anthropic API key is configured, otherwise the model served on this machine. */
export function createLlmClient(): LlmClient {
  return process.env.ANTHROPIC_API_KEY ? createClaudeClient() : createOllamaClient();
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
    local: true,
    available: () => llmAvailable(opts),
    async complete(system, user) {
      const res = await doFetch(`${url}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000),
        // A context large enough for a long list of findings (a prompt cut short loses its instructions), and a cap
        // on the answer so a model that starts repeating itself stops.
        body: JSON.stringify({ model, stream: false, options: { temperature: 0, num_ctx: 12288, num_predict: 1500 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
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

/** Every top-level JSON object in a model's answer, in order. A model asked for one object sometimes sends a list of them. */
export function allJson(answer: string): unknown[] {
  const out: unknown[] = [];
  let from = 0;
  for (;;) {
    const start = answer.indexOf('{', from);
    if (start < 0) return out;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < answer.length; i++) {
      const ch = answer[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return out;
    try {
      out.push(JSON.parse(answer.slice(start, end + 1)));
      from = end + 1;
    } catch {
      from = start + 1;
    }
  }
}
