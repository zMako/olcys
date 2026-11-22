export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`serwer odpowiedział kodem ${res.status}`);
  return (await res.json()) as T;
}

export const sendJson = <T,>(url: string, body: unknown = {}, method = 'POST'): Promise<T> =>
  getJson<T>(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** One case on the analyst's desk, with what its latest analysis found. */
export interface CaseRow {
  id: string;
  title: string;
  sources: string;
  status: string;
  statusAt: string | null;
  createdAt: string;
  identifiers: { kind: string; value: string }[];
  runs: number;
  running: boolean;
  /** The newest analysis, whatever its outcome; a case whose only analysis failed can still be opened to see why. */
  latestRunId: string | null;
  failed: boolean;
  lastRun: {
    id: string; startedAt: string; changes: { changed: boolean; summary: string } | null;
    attributed: number; uncertain: number; rejected: number; totalPln: number; exchanges: string[]; attesters: string[]; gaps: number;
  } | null;
  schedule: { everySeconds: number; nextRunAt: string } | null;
}

/** The life of a case, in order. The analyst moves it along; the tool records when. */
export const STATUS_ORDER = ['new', 'in_analysis', 'request_sent', 'answered', 'closed'];
export const STATUS: Record<string, string> = {
  new: 'Nowa', in_analysis: 'W analizie', request_sent: 'Zapytanie wysłane', answered: 'Odpowiedź otrzymana', closed: 'Zamknięta',
};
export const SOURCES: Record<string, string> = { synthetic: 'Środowisko testowe', live: 'Internet, na żywo' };
