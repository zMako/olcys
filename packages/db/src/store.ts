import { GENESIS_HASH, chainHash, identifierKey, sha256Hex, type AccountInfo, type AddressAttestation, type AddressMention, type Deployment, type Fingerprint, type Identifier, type Segment, type SourceItem, type Transfer } from '@olcys/core';
import type { SqlExecutor } from './executor';

export interface CaseRow {
  id: string;
  title: string;
  created_at: string;
  sources: string;
  /** Where the case stands: new, in_analysis, request_sent, answered, closed. */
  status: string;
  status_at: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  /** The analyst, or "harmonogram" for scheduled runs. */
  actor: string;
  action: string;
  caseId?: string;
  runId?: string;
  detail: Record<string, unknown>;
  hash: string;
}

export interface ScheduleRow {
  case_id: string;
  every_seconds: number;
  next_run_at: string;
}

export interface RunRow {
  id: string;
  case_id: string;
  status: string;
  trigger: string;
  engine_version: string;
  params: unknown;
  stats: unknown;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface SnapshotRow {
  id: string;
  run_id: string;
  seq: number;
  connector_id: string;
  url: string;
  http_status: number;
  content_type: string;
  sha256: string;
  fetched_at: string;
  prev_chain_hash: string;
  chain_hash: string;
}

/** A found address with everything needed to show where it came from. */
export interface MentionView {
  chain: string;
  address: string;
  address_type: string;
  checksum: string;
  raw: string;
  method: string;
  obfuscation: string[];
  segment_kind: string;
  quoted_author: string | null;
  context: string;
  source_url: string | null;
  source_snapshot_id: string | null;
  document_id: string;
  url: string;
  doc_type: string;
  title: string | null;
  author_handle: string | null;
  relation: string;
  connector_id: string;
  origin: string;
  container: { kind: string; id?: string; title?: string; section?: string; url?: string } | null;
  published_at: string | null;
  fetched_at: string;
  snapshot_id: string;
  snapshot_sha256: string;
}

/**
 * Real-world text contains things a database will not store as JSON: a null character, or half of an emoji left by
 * cutting a string at a fixed length. They are replaced, so one odd post cannot fail a whole analysis.
 */
export const wellFormed = (s: string): string =>
  s.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
const json = (v: unknown) => JSON.stringify(v ?? null, (_k, x) => (typeof x === 'string' ? wellFormed(x) : x));
/** JSON with object keys in a fixed order, for hashing: the database stores JSON objects in its own key order. */
const canonical = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x) => (typeof x === 'string' ? wellFormed(x) : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

export class Store {
  constructor(readonly db: SqlExecutor) {}

  // Entries of a hash chain must be written one at a time: each needs the hash of the one before it.
  private chainTail: Promise<unknown> = Promise.resolve();
  private inOrder<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chainTail.then(work, work);
    this.chainTail = result.catch(() => undefined);
    return result;
  }


  async createCase(title: string, identifiers: Identifier[]): Promise<CaseRow> {
    const { rows } = await this.db.query<CaseRow>('INSERT INTO cases (title) VALUES ($1) RETURNING *', [title]);
    for (const id of identifiers) {
      await this.db.query(
        'INSERT INTO case_identifiers (case_id, kind, value, normalized) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [rows[0].id, id.kind, id.value, id.normalized],
      );
    }
    return rows[0];
  }

  /**
   * The case for exactly these identifiers and sources; created if there is none yet.
   * Analysing the same thing again therefore adds a run to the same case, so results can be compared.
   */
  async findOrCreateCase(title: string, identifiers: Identifier[], sources = 'synthetic'): Promise<CaseRow & { created: boolean }> {
    const fingerprint = `${sources}|${identifiers.map(identifierKey).sort().join('|')}`;
    const existing = (await this.db.query<CaseRow>('SELECT * FROM cases WHERE fingerprint = $1 ORDER BY created_at LIMIT 1', [fingerprint])).rows[0];
    if (existing) return { ...existing, created: false };
    const c = await this.createCase(title, identifiers);
    await this.db.query('UPDATE cases SET fingerprint = $2, sources = $3 WHERE id = $1', [c.id, fingerprint, sources]);
    return { ...c, sources, created: true };
  }

  /** The last completed run of the same case that started before the given run. */
  async previousRun(runId: string): Promise<RunRow | undefined> {
    return (
      await this.db.query<RunRow>(
        `SELECT p.* FROM runs p JOIN runs r ON r.case_id = p.case_id
          WHERE r.id = $1 AND p.id <> r.id AND p.status = 'completed' AND p.started_at < r.started_at
          ORDER BY p.started_at DESC LIMIT 1`,
        [runId],
      )
    ).rows[0];
  }

  /** True while a run of the case is in progress (runs stuck for over ten minutes are treated as abandoned). */
  async hasRunningRun(caseId: string): Promise<boolean> {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    return (await this.db.query("SELECT 1 FROM runs WHERE case_id = $1 AND status = 'running' AND started_at > $2 LIMIT 1", [caseId, since])).rows.length > 0;
  }

  /** For each run of a case: what it reported as changed since the run before it (absent for a first run). */
  async changeNotes(caseId: string): Promise<Map<string, { changed: boolean; summary: string }>> {
    const { rows } = await this.db.query<{ run_id: string; payload: { changed: boolean; summary: string } }>(
      "SELECT e.run_id, e.payload FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.case_id = $1 AND e.type = 'diff'",
      [caseId],
    );
    return new Map(rows.map((r) => [r.run_id, { changed: r.payload.changed, summary: r.payload.summary }]));
  }

  // ------------------------------------------------------------------ schedules

  /** Sets how often the case is analysed again; null switches repetition off. */
  async setSchedule(caseId: string, everySeconds: number | null): Promise<void> {
    if (everySeconds === null) {
      await this.db.query('DELETE FROM case_schedules WHERE case_id = $1', [caseId]);
      return;
    }
    await this.db.query(
      `INSERT INTO case_schedules (case_id, every_seconds, next_run_at) VALUES ($1, $2, $3)
       ON CONFLICT (case_id) DO UPDATE SET every_seconds = EXCLUDED.every_seconds, next_run_at = EXCLUDED.next_run_at`,
      [caseId, everySeconds, new Date(Date.now() + everySeconds * 1000).toISOString()],
    );
  }

  async schedule(caseId: string): Promise<ScheduleRow | undefined> {
    return (await this.db.query<ScheduleRow>('SELECT case_id, every_seconds, next_run_at FROM case_schedules WHERE case_id = $1', [caseId])).rows[0];
  }

  /** Schedules whose time has come. */
  async dueSchedules(now = new Date()): Promise<(ScheduleRow & { sources: string })[]> {
    return (
      await this.db.query<ScheduleRow & { sources: string }>(
        'SELECT s.case_id, s.every_seconds, s.next_run_at, c.sources FROM case_schedules s JOIN cases c ON c.id = s.case_id WHERE s.next_run_at <= $1 ORDER BY s.next_run_at',
        [now.toISOString()],
      )
    ).rows;
  }

  /** Moves a schedule to its next slot, counted from now. */
  async bumpSchedule(caseId: string, everySeconds: number): Promise<void> {
    await this.db.query('UPDATE case_schedules SET next_run_at = $2 WHERE case_id = $1', [caseId, new Date(Date.now() + everySeconds * 1000).toISOString()]);
  }

  async getCase(id: string): Promise<CaseRow | undefined> {
    return (await this.db.query<CaseRow>('SELECT * FROM cases WHERE id = $1', [id])).rows[0];
  }

  /** Removes a case with every analysis, finding and stored page of it. The audit log keeps the record that it existed and who removed it. */
  async deleteCase(id: string): Promise<void> {
    await this.db.query('DELETE FROM cases WHERE id = $1', [id]);
    // stored pages are kept once per content; those no analysis refers to any more go too
    await this.db.query('DELETE FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.sha256 = b.sha256)');
  }

  async setCaseStatus(id: string, status: string): Promise<void> {
    await this.db.query('UPDATE cases SET status = $2, status_at = $3 WHERE id = $1', [id, status, new Date().toISOString()]);
  }

  async listCases(): Promise<CaseRow[]> {
    return (await this.db.query<CaseRow>('SELECT * FROM cases ORDER BY created_at DESC')).rows;
  }

  async caseIdentifiers(caseId: string): Promise<Identifier[]> {
    const { rows } = await this.db.query<Identifier>(
      'SELECT kind, value, normalized FROM case_identifiers WHERE case_id = $1 ORDER BY created_at, id',
      [caseId],
    );
    return rows;
  }

  async createRun(caseId: string, engineVersion: string, params: unknown, trigger = 'manual'): Promise<RunRow> {
    const { rows } = await this.db.query<RunRow>(
      'INSERT INTO runs (case_id, engine_version, params, trigger) VALUES ($1, $2, $3::jsonb, $4) RETURNING *',
      [caseId, engineVersion, json(params), trigger],
    );
    return rows[0];
  }

  /**
   * Closes analyses that were still running when the server stopped. Nothing is working on them any more, so
   * leaving them "running" would keep their cases looking busy for ever. Returns how many were closed.
   */
  async closeInterruptedRuns(): Promise<number> {
    const { rows } = await this.db.query("UPDATE runs SET status = 'failed', error = 'Analiza przerwana: serwer został zatrzymany w jej trakcie.', finished_at = now() WHERE status = 'running' RETURNING id");
    return rows.length;
  }

  async finishRun(runId: string, status: 'completed' | 'failed', stats: unknown, error?: string): Promise<void> {
    await this.db.query('UPDATE runs SET status = $2, stats = $3::jsonb, error = $4, finished_at = now() WHERE id = $1', [
      runId, status, json(stats), error ?? null,
    ]);
  }

  async getRun(id: string): Promise<RunRow | undefined> {
    return (await this.db.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id])).rows[0];
  }

  async listRuns(caseId: string): Promise<RunRow[]> {
    return (await this.db.query<RunRow>('SELECT * FROM runs WHERE case_id = $1 ORDER BY started_at', [caseId])).rows;
  }

  async addRunIdentifier(runId: string, id: Identifier, origin: string, depth: number, documentId?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO run_identifiers (run_id, kind, value, normalized, origin, depth, discovered_in_document)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [runId, id.kind, id.value, id.normalized, origin, depth, documentId ?? null],
    );
  }

  async runIdentifiers(runId: string) {
    return (
      await this.db.query<Identifier & { origin: string; depth: number; discovered_in_document: string | null }>(
        'SELECT kind, value, normalized, origin, depth, discovered_in_document FROM run_identifiers WHERE run_id = $1 ORDER BY depth, created_at, id',
        [runId],
      )
    ).rows;
  }

  /** Stores a response body and appends it to the run's hash chain. */
  async saveSnapshot(s: { runId: string; connectorId: string; url: string; status: number; contentType: string; body: string | Uint8Array; fetchedAt: string; requestBody?: string }): Promise<SnapshotRow> {
    return this.inOrder(() => this.appendSnapshot(s));
  }

  private async appendSnapshot(s: { runId: string; connectorId: string; url: string; status: number; contentType: string; body: string | Uint8Array; fetchedAt: string; requestBody?: string }): Promise<SnapshotRow> {
    const bytes = typeof s.body === 'string' ? new TextEncoder().encode(s.body) : s.body;
    const sha = sha256Hex(bytes);
    await this.db.query('INSERT INTO blobs (sha256, size, body) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [sha, bytes.length, bytes]);
    const last = (
      await this.db.query<{ seq: number; chain_hash: string }>('SELECT seq, chain_hash FROM snapshots WHERE run_id = $1 ORDER BY seq DESC LIMIT 1', [s.runId])
    ).rows[0];
    const prev = last?.chain_hash ?? GENESIS_HASH;
    const { rows } = await this.db.query<SnapshotRow>(
      `INSERT INTO snapshots (run_id, seq, connector_id, url, http_status, content_type, sha256, fetched_at, prev_chain_hash, chain_hash, request_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [s.runId, (last?.seq ?? 0) + 1, s.connectorId, s.url, s.status, s.contentType, sha, s.fetchedAt, prev, chainHash(prev, { sha256: sha, url: s.url, fetchedAt: s.fetchedAt }), s.requestBody ?? null],
    );
    return rows[0];
  }

  async snapshots(runId: string): Promise<SnapshotRow[]> {
    return (await this.db.query<SnapshotRow>('SELECT * FROM snapshots WHERE run_id = $1 ORDER BY seq', [runId])).rows;
  }

  async snapshotBody(sha256: string): Promise<string | undefined> {
    const row = (await this.db.query<{ body: Uint8Array }>('SELECT body FROM blobs WHERE sha256 = $1', [sha256])).rows[0];
    return row ? new TextDecoder().decode(row.body) : undefined;
  }

  /**
   * Recomputes every content hash and chain link of a run.
   * Returns the sequence numbers of records that no longer match what was captured.
   */
  async verifyEvidence(runId: string): Promise<{ ok: boolean; checked: number; broken: number[] }> {
    const broken: number[] = [];
    let prev = GENESIS_HASH;
    const rows = await this.snapshots(runId);
    for (const s of rows) {
      const blob = (await this.db.query<{ body: Uint8Array }>('SELECT body FROM blobs WHERE sha256 = $1', [s.sha256])).rows[0];
      const contentOk = !!blob && sha256Hex(new Uint8Array(blob.body)) === s.sha256;
      const linkOk = s.prev_chain_hash === prev && s.chain_hash === chainHash(prev, { sha256: s.sha256, url: s.url, fetchedAt: s.fetched_at });
      if (!contentOk || !linkOk) broken.push(s.seq);
      prev = s.chain_hash;
    }
    return { ok: broken.length === 0, checked: rows.length, broken };
  }

  async logEgress(e: { runId?: string; connectorId: string; url: string; host: string; allowed: boolean; status?: number; note?: string }): Promise<void> {
    await this.db.query('INSERT INTO egress_log (run_id, connector_id, url, host, allowed, http_status, note) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      e.runId ?? null, e.connectorId, e.url, e.host, e.allowed, e.status ?? null, e.note ?? null,
    ]);
  }

  async egressLog(runId: string) {
    return (
      await this.db.query<{ connector_id: string; url: string; host: string; allowed: boolean; http_status: number | null; note: string | null }>(
        'SELECT connector_id, url, host, allowed, http_status, note FROM egress_log WHERE run_id = $1 ORDER BY id',
        [runId],
      )
    ).rows;
  }

  /** Stores a document once per run. `created` is false when the resource was already captured. */
  async saveDocument(runId: string, connectorId: string, origin: string, matched: Identifier, item: SourceItem): Promise<{ id: string; created: boolean }> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO documents (run_id, snapshot_id, connector_id, origin, resource_id, url, doc_type, title, author_handle,
         author_display_name, author_profile_url, published_at, container, relation, matched_identifier, segments, discovered, fingerprints)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb)
       ON CONFLICT (run_id, connector_id, resource_id) DO NOTHING RETURNING id`,
      [
        runId, item.snapshotId, connectorId, origin, item.resourceId, item.url, item.docType, item.title ? wellFormed(item.title) : null,
        item.author?.handle ?? null, item.author?.displayName ?? null, item.author?.profileUrl ?? null, item.publishedAt ?? null,
        json(item.container), item.relation, json(matched), json(item.segments), json(item.discovered), json(item.fingerprints ?? []),
      ],
    );
    if (rows[0]) return { id: rows[0].id, created: true };
    const existing = await this.db.query<{ id: string }>('SELECT id FROM documents WHERE run_id = $1 AND connector_id = $2 AND resource_id = $3', [runId, connectorId, item.resourceId]);
    return { id: existing.rows[0].id, created: false };
  }

  /** Records that an identifier led to a document (also when the document was already known). */
  async addHit(runId: string, documentId: string, id: Identifier, relation: string): Promise<void> {
    await this.db.query('INSERT INTO document_hits (run_id, document_id, identifier_kind, identifier_value, identifier_normalized, relation) VALUES ($1, $2, $3, $4, $5, $6)', [
      runId, documentId, id.kind, id.value, id.normalized, relation,
    ]);
  }

  /** `source` is given when the address was read from something other than the page text, e.g. a photo. */
  async saveMention(runId: string, documentId: string, segmentIndex: number, segment: Segment, m: AddressMention, source?: { url: string; snapshotId: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO address_mentions (run_id, document_id, chain, address, address_type, checksum, raw, method, obfuscation,
         segment_index, segment_kind, quoted_author, start_offset, end_offset, context, source_url, source_snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        runId, documentId, m.chain, m.address, m.addressType, m.checksum, m.raw, m.method, json(m.obfuscation),
        segmentIndex, segment.kind, segment.quotedAuthor ?? null, m.start, m.end, wellFormed(m.context), source?.url ?? null, source?.snapshotId ?? null,
      ],
    );
  }

  async saveProof(runId: string, documentId: string, p: { chain: string; address: string; message: string; signature: string; valid: boolean; reason?: string; attestedBy?: string }): Promise<void> {
    await this.db.query('INSERT INTO proofs (run_id, document_id, chain, address, message, signature, valid, reason, attested_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      runId, documentId, p.chain, p.address, p.message, p.signature, p.valid, p.reason ?? null, p.attestedBy ?? null,
    ]);
  }

  /** A stored response exactly as it was received, for showing evidence (e.g. the photo an address was read from). */
  async snapshotBlob(runId: string, snapshotId: string): Promise<{ contentType: string; body: Uint8Array; url: string } | undefined> {
    const row = (
      await this.db.query<{ content_type: string; body: Uint8Array; url: string }>(
        'SELECT s.content_type, b.body, s.url FROM snapshots s JOIN blobs b ON b.sha256 = s.sha256 WHERE s.run_id = $1 AND s.id = $2',
        [runId, snapshotId],
      )
    ).rows[0];
    return row && { contentType: row.content_type, body: new Uint8Array(row.body), url: row.url };
  }

  async mentions(runId: string): Promise<MentionView[]> {
    const { rows } = await this.db.query<MentionView>(
      `SELECT m.chain, m.address, m.address_type, m.checksum, m.raw, m.method, m.obfuscation, m.segment_kind, m.quoted_author, m.context, m.source_url, m.source_snapshot_id,
              d.id AS document_id, d.url, d.doc_type, d.title, d.author_handle, d.relation, d.connector_id, d.origin, d.container, d.published_at,
              s.fetched_at, s.id AS snapshot_id, s.sha256 AS snapshot_sha256
         FROM address_mentions m
         JOIN documents d ON d.id = m.document_id
         JOIN snapshots s ON s.id = d.snapshot_id
        WHERE m.run_id = $1
        ORDER BY m.chain, m.address, d.connector_id, d.url, m.start_offset`,
      [runId],
    );
    return rows;
  }

  async counts(runId: string): Promise<{ documents: number; mentions: number; snapshots: number; denied: number }> {
    const one = async (sql: string) => Number((await this.db.query<{ n: string }>(sql, [runId])).rows[0].n);
    return {
      documents: await one('SELECT count(*) AS n FROM documents WHERE run_id = $1'),
      mentions: await one('SELECT count(*) AS n FROM address_mentions WHERE run_id = $1'),
      snapshots: await one('SELECT count(*) AS n FROM snapshots WHERE run_id = $1'),
      denied: await one('SELECT count(*) AS n FROM egress_log WHERE run_id = $1 AND NOT allowed'),
    };
  }

  // ------------------------------------------------------------------ chain facts

  async saveChainAccount(runId: string, connectorId: string, info: AccountInfo): Promise<void> {
    await this.db.query(
      'INSERT INTO chain_accounts (run_id, chain, address, connector_id, info) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (run_id, chain, address) DO NOTHING',
      [runId, info.chain, info.address, connectorId, json(info)],
    );
  }

  async chainAccounts(runId: string): Promise<AccountInfo[]> {
    return (await this.db.query<{ info: AccountInfo }>('SELECT info FROM chain_accounts WHERE run_id = $1 ORDER BY chain, address', [runId])).rows.map((r) => r.info);
  }

  async saveTransfers(runId: string, subject: string, transfers: Transfer[]): Promise<void> {
    for (const t of transfers) {
      await this.db.query(
        `INSERT INTO chain_transfers (run_id, subject_address, chain, tx_hash, at, from_address, to_address, asset, amount, snapshot_id, network)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [runId, subject, t.chain, t.txHash, t.at, t.from, t.to, t.asset, t.amount, t.snapshotId ?? null, t.network ?? null],
      );
    }
  }

  // ------------------------------------------------------------------ scoring rules in force

  async saveRuleset(version: string, body: unknown, changes: unknown, actor: string): Promise<void> {
    await this.db.query('INSERT INTO rulesets (version, body, changes, actor, created_at) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)', [version, json(body), json(changes), actor, new Date().toISOString()]);
  }

  /** The rules saved most recently, with what was changed from the built-in ones; undefined when none were ever saved. */
  async activeRuleset<T>(): Promise<{ body: T; changes: { path: string; from: number; to: number }[]; saved: number; at: string; actor: string } | undefined> {
    const { rows } = await this.db.query<Record<string, any>>('SELECT body, changes, created_at, actor, (SELECT count(*) FROM rulesets) AS saved FROM rulesets ORDER BY id DESC LIMIT 1');
    const r = rows[0];
    return r && { body: r.body as T, changes: r.changes ?? [], saved: Number(r.saved), at: r.created_at, actor: r.actor };
  }

  // ------------------------------------------------------------------ what could not be read

  async saveGap(runId: string, source: string, message: string): Promise<void> {
    await this.db.query('INSERT INTO run_gaps (run_id, source, message, at) VALUES ($1, $2, $3, $4)', [runId, source, wellFormed(message).slice(0, 500), new Date().toISOString()]);
  }

  /** Sources that failed during the run, each distinct failure once, with how many times it happened. */
  async gaps(runId: string): Promise<{ source: string; message: string; times: number }[]> {
    const { rows } = await this.db.query<Record<string, any>>('SELECT source, message, count(*) AS times, min(id) AS first FROM run_gaps WHERE run_id = $1 GROUP BY source, message ORDER BY first', [runId]);
    return rows.map((r) => ({ source: r.source, message: r.message, times: Number(r.times) }));
  }

  // ------------------------------------------------------------------ language-model output

  /** Keeps a piece of model output (and what the checks made of it). Asking again replaces the earlier answer. */
  async saveModelOutput(runId: string, kind: string, key: string, model: string, payload: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO model_outputs (run_id, kind, key, model, payload, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (run_id, kind, key) DO UPDATE SET model = EXCLUDED.model, payload = EXCLUDED.payload, created_at = EXCLUDED.created_at`,
      [runId, kind, key, model, json(payload), new Date().toISOString()],
    );
  }

  /** Drops earlier model output of one kind, before the model is asked afresh. */
  async clearModelOutputs(runId: string, kind: string): Promise<void> {
    await this.db.query('DELETE FROM model_outputs WHERE run_id = $1 AND kind = $2', [runId, kind]);
  }

  async modelOutputs<T = unknown>(runId: string, kind: string): Promise<{ key: string; model: string; payload: T; createdAt: string }[]> {
    const { rows } = await this.db.query<Record<string, any>>('SELECT key, model, payload, created_at FROM model_outputs WHERE run_id = $1 AND kind = $2 ORDER BY id', [runId, kind]);
    return rows.map((r) => ({ key: r.key, model: r.model, payload: r.payload as T, createdAt: r.created_at }));
  }

  // ------------------------------------------------------------------ audit log

  /** Records an action. Each entry's hash covers the previous entry, so the log cannot be edited unnoticed. */
  async audit(e: { actor: string; action: string; caseId?: string; runId?: string; detail?: Record<string, unknown> }): Promise<void> {
    return this.inOrder(() => this.appendAudit(e));
  }

  private async appendAudit(e: { actor: string; action: string; caseId?: string; runId?: string; detail?: Record<string, unknown> }): Promise<void> {
    const prev = (await this.db.query<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0]?.hash ?? GENESIS_HASH;
    const at = new Date().toISOString();
    const detail = json(e.detail ?? {});
    const actor = wellFormed(e.actor).slice(0, 80);
    const hash = sha256Hex([prev, at, actor, e.action, e.caseId ?? '', e.runId ?? '', canonical(e.detail ?? {})].join('|'));
    await this.db.query('INSERT INTO audit_log (at, actor, action, case_id, run_id, detail, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)', [
      at, actor, e.action, e.caseId ?? null, e.runId ?? null, detail, prev, hash,
    ]);
  }

  /** The log of one case (or of everything), newest first. */
  async auditTrail(opts: { caseId?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT id, at, actor, action, case_id, run_id, detail, hash FROM audit_log ${opts.caseId ? 'WHERE case_id = $2' : ''} ORDER BY id DESC LIMIT $1`,
      opts.caseId ? [opts.limit ?? 200, opts.caseId] : [opts.limit ?? 200],
    );
    return rows.map((r) => ({ id: Number(r.id), at: r.at, actor: r.actor, action: r.action, caseId: r.case_id ?? undefined, runId: r.run_id ?? undefined, detail: r.detail ?? {}, hash: r.hash }));
  }

  /** Recomputes the whole chain. Returns the number of entries and the first one that does not match, if any. */
  async verifyAudit(): Promise<{ entries: number; intact: boolean; brokenAt?: number }> {
    const { rows } = await this.db.query<Record<string, any>>('SELECT id, at, actor, action, case_id, run_id, detail, prev_hash, hash FROM audit_log ORDER BY id');
    let prev = GENESIS_HASH;
    for (const r of rows) {
      const expected = sha256Hex([prev, r.at, r.actor, r.action, r.case_id ?? '', r.run_id ?? '', canonical(r.detail ?? {})].join('|'));
      if (r.prev_hash !== prev || r.hash !== expected) return { entries: rows.length, intact: false, brokenAt: Number(r.id) };
      prev = r.hash;
    }
    return { entries: rows.length, intact: true };
  }

  // ------------------------------------------------------------------ what the person's posts say

  /** Text of everything the run captured that was written by someone (posts and ads), for reading. */
  async authoredTexts(runId: string): Promise<{ documentId: string; origin: string; authorHandle: string; url: string; at?: string; text: string }[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT id, origin, author_handle, url, published_at, segments FROM documents
        WHERE run_id = $1 AND doc_type IN ('post', 'ad') AND author_handle IS NOT NULL ORDER BY published_at NULLS LAST, id`,
      [runId],
    );
    return rows.map((r) => ({
      documentId: r.id as string, origin: r.origin as string, authorHandle: r.author_handle as string, url: r.url as string, at: (r.published_at ?? undefined) as string | undefined,
      // the author's own words only: quoted text belongs to someone else
      text: ((r.segments ?? []) as { kind: string; text: string }[]).filter((x) => x.kind === 'title' || x.kind === 'body').map((x) => x.text).join('\n').trim(),
    }));
  }

  /** What each account says about itself and a few of its posts: the material for comparing two accounts. */
  async profileCards(runId: string): Promise<{ origin: string; handle: string; displayName?: string; profile: string; posts: string[] }[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT origin, author_handle, author_display_name, doc_type, relation, segments FROM documents
        WHERE run_id = $1 AND author_handle IS NOT NULL ORDER BY published_at NULLS LAST, id`,
      [runId],
    );
    const cards = new Map<string, { origin: string; handle: string; displayName?: string; profile: string; posts: string[] }>();
    for (const r of rows) {
      const key = `${r.origin}|${String(r.author_handle).toLowerCase()}`;
      const card = cards.get(key) ?? { origin: r.origin as string, handle: r.author_handle as string, profile: '', posts: [] };
      cards.set(key, card);
      card.displayName ??= (r.author_display_name ?? undefined) as string | undefined;
      const text = ((r.segments ?? []) as { kind: string; text: string }[]).filter((x) => x.kind !== 'quote').map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (r.doc_type === 'profile') card.profile = `${card.profile} ${text}`.trim().slice(0, 700);
      else if (r.relation !== 'mention' && card.posts.length < 6) card.posts.push(text.slice(0, 240));
    }
    return [...cards.values()];
  }

  async saveReading(
    runId: string,
    r: { posts: number; generated: number; read: number; model?: unknown; statements: { documentId: string; relevance: number; text: string; at?: string; url?: string }[] },
  ): Promise<void> {
    await this.db.query(
      'INSERT INTO readings (run_id, posts, generated, read, model) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (run_id) DO UPDATE SET posts = EXCLUDED.posts, generated = EXCLUDED.generated, read = EXCLUDED.read, model = EXCLUDED.model',
      [runId, r.posts, r.generated, r.read, json(r.model)],
    );
    for (const x of r.statements) {
      await this.db.query(
        'INSERT INTO statements (run_id, document_id, relevance, text, at, url) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id, document_id) DO NOTHING',
        [runId, x.documentId, x.relevance, wellFormed(x.text), x.at ?? null, x.url ?? null],
      );
    }
  }

  async reading<D = unknown>(runId: string): Promise<{ posts: number; generated: number; read: number; statements: { documentId: string; relevance: number; text: string; at?: string; url?: string; detail?: D }[] } | undefined> {
    const head = (await this.db.query<{ posts: number; generated: number; read: number }>('SELECT posts, generated, read FROM readings WHERE run_id = $1', [runId])).rows[0];
    if (!head) return undefined;
    const { rows } = await this.db.query<Record<string, any>>('SELECT document_id, relevance, text, at, url, detail FROM statements WHERE run_id = $1 ORDER BY relevance DESC, id', [runId]);
    return {
      posts: head.posts, generated: head.generated, read: head.read,
      statements: rows.map((r) => ({ documentId: r.document_id as string, relevance: Number(r.relevance), text: r.text as string, at: r.at ?? undefined, url: r.url ?? undefined, detail: (r.detail ?? undefined) as D | undefined })),
    };
  }

  async setStatementDetail(runId: string, documentId: string, detail: unknown): Promise<void> {
    await this.db.query('UPDATE statements SET detail = $3::jsonb WHERE run_id = $1 AND document_id = $2', [runId, documentId, json(detail)]);
  }

  async saveNarrative(runId: string, model: string, text: string): Promise<void> {
    await this.db.query('INSERT INTO narratives (run_id, model, text) VALUES ($1, $2, $3) ON CONFLICT (run_id) DO UPDATE SET model = EXCLUDED.model, text = EXCLUDED.text, created_at = now()', [runId, model, text]);
  }

  async narrative(runId: string): Promise<{ model: string; text: string; createdAt: string } | undefined> {
    const r = (await this.db.query<{ model: string; text: string; created_at: string | Date }>('SELECT model, text, created_at FROM narratives WHERE run_id = $1', [runId])).rows[0];
    return r && { model: r.model, text: r.text, createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) };
  }

  async saveAttestations(runId: string, list: AddressAttestation[]): Promise<void> {
    for (const a of list) {
      await this.db.query(
        `INSERT INTO address_attestations (run_id, chain, address, issuer, claim, value, uid, at, source_url, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (run_id, uid) DO NOTHING`,
        [runId, a.chain, a.address, a.issuer, a.claim, a.value ?? null, a.uid, a.at ?? null, a.sourceUrl ?? null, a.note ?? null],
      );
    }
  }

  async attestations(runId: string): Promise<AddressAttestation[]> {
    const { rows } = await this.db.query<Record<string, any>>('SELECT chain, address, issuer, claim, value, uid, at, source_url, note FROM address_attestations WHERE run_id = $1 ORDER BY id', [runId]);
    return rows.map((r) => ({ chain: r.chain, address: r.address, issuer: r.issuer, claim: r.claim, value: r.value ?? undefined, uid: r.uid, at: r.at ?? undefined, sourceUrl: r.source_url ?? undefined, note: r.note ?? undefined }));
  }

  async saveDeployment(runId: string, d: Deployment): Promise<void> {
    await this.db.query(
      `INSERT INTO deployments (run_id, chain, contract, creator, tx_hash, at, source_url, snapshot_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (run_id, chain, contract) DO NOTHING`,
      [runId, d.chain, d.contract, d.creator, d.txHash ?? null, d.at ?? null, d.sourceUrl ?? null, d.snapshotId ?? null],
    );
  }

  /** Contracts and the addresses that created them, as far as the run looked them up. */
  async deployments(runId: string): Promise<Deployment[]> {
    const { rows } = await this.db.query<Record<string, any>>('SELECT chain, contract, creator, tx_hash, at, source_url FROM deployments WHERE run_id = $1 ORDER BY id', [runId]);
    return rows.map((r) => ({ chain: r.chain, contract: r.contract, creator: r.creator, txHash: r.tx_hash ?? undefined, at: r.at ?? undefined, sourceUrl: r.source_url ?? undefined }));
  }

  /** Every stored value movement of a run, oldest first. */
  async transfers(runId: string): Promise<(Transfer & { subject: string })[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      'SELECT subject_address, chain, tx_hash, at, from_address, to_address, asset, amount, network FROM chain_transfers WHERE run_id = $1 ORDER BY at, id',
      [runId],
    );
    return rows.map((r) => ({ subject: r.subject_address, chain: r.chain, txHash: r.tx_hash, at: r.at, from: r.from_address, to: r.to_address, asset: r.asset, amount: Number(r.amount), network: r.network ?? undefined }));
  }

  async saveActivity(runId: string, chain: string, address: string, a: { activity: unknown; indicators: unknown; wallet: unknown; offRamps: unknown }): Promise<void> {
    await this.db.query(
      `INSERT INTO chain_activity (run_id, chain, address, activity, indicators, wallet, off_ramps) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
       ON CONFLICT (run_id, chain, address) DO UPDATE SET activity = EXCLUDED.activity, indicators = EXCLUDED.indicators, wallet = EXCLUDED.wallet, off_ramps = EXCLUDED.off_ramps`,
      [runId, chain, address, json(a.activity), json(a.indicators), json(a.wallet), json(a.offRamps)],
    );
  }

  async activities<T = Record<string, unknown>>(runId: string): Promise<T[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT chain, address, activity, indicators, wallet, off_ramps FROM chain_activity WHERE run_id = $1 ORDER BY chain, address',
      [runId],
    );
    return rows.map((r) => ({ chain: r.chain, address: r.address, activity: r.activity, indicators: r.indicators, wallet: r.wallet, offRamps: r.off_ramps }) as T);
  }

  async saveEstimate(runId: string, estimate: unknown): Promise<void> {
    await this.db.query('INSERT INTO run_estimates (run_id, estimate) VALUES ($1, $2::jsonb) ON CONFLICT (run_id) DO UPDATE SET estimate = EXCLUDED.estimate', [runId, json(estimate)]);
  }

  async estimate<T = unknown>(runId: string): Promise<T | undefined> {
    return (await this.db.query<{ estimate: T }>('SELECT estimate FROM run_estimates WHERE run_id = $1', [runId])).rows[0]?.estimate;
  }

  // ------------------------------------------------------------------ scoring

  /** Everything the scoring needs about a run, read back from the database. */
  async runFacts(runId: string) {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    const opt = <T,>(v: T | null): T | undefined => v ?? undefined;
    const documents = (
      await this.db.query<Record<string, never>>(
        `SELECT d.id, d.origin, d.connector_id, d.url, d.doc_type, d.title, d.author_handle, d.author_display_name, d.author_profile_url,
                d.relation, d.container, d.discovered, d.fingerprints, d.published_at, s.fetched_at, s.sha256
           FROM documents d JOIN snapshots s ON s.id = d.snapshot_id WHERE d.run_id = $1 ORDER BY d.created_at, d.id`,
        [runId],
      )
    ).rows.map((r: Record<string, any>) => ({
      id: r.id as string, origin: r.origin as string, connectorId: r.connector_id as string, url: r.url as string, docType: r.doc_type as string,
      title: opt<string>(r.title), authorHandle: opt<string>(r.author_handle), authorDisplayName: opt<string>(r.author_display_name),
      authorProfileUrl: opt<string>(r.author_profile_url), relation: r.relation as string,
      container: opt<{ kind: string; id?: string; title?: string; section?: string; url?: string; stats?: Record<string, number> }>(r.container),
      discovered: (r.discovered ?? []) as Identifier[], publishedAt: opt<string>(r.published_at), fetchedAt: r.fetched_at as string, snapshotSha256: r.sha256 as string,
      fingerprints: (r.fingerprints ?? []) as Fingerprint[],
    }));
    const hits = (
      await this.db.query<Record<string, string>>('SELECT document_id, identifier_kind, identifier_value, identifier_normalized, relation FROM document_hits WHERE run_id = $1 ORDER BY id', [runId])
    ).rows.map((r) => ({
      documentId: r.document_id,
      identifier: { kind: r.identifier_kind as Identifier['kind'], value: r.identifier_value, normalized: r.identifier_normalized },
      relation: r.relation,
    }));
    const mentions = (
      await this.db.query<Record<string, any>>(
        'SELECT document_id, chain, address, segment_kind, quoted_author, method, obfuscation, raw, context, source_url, source_snapshot_id FROM address_mentions WHERE run_id = $1 ORDER BY chain, address, document_id, start_offset',
        [runId],
      )
    ).rows.map((r) => ({
      documentId: r.document_id as string, chain: r.chain as string, address: r.address as string, segmentKind: r.segment_kind as string,
      quotedAuthor: opt<string>(r.quoted_author), method: r.method as string, obfuscation: (r.obfuscation ?? []) as string[], raw: r.raw as string, context: r.context as string,
      imageUrl: opt<string>(r.source_url), imageSnapshotId: opt<string>(r.source_snapshot_id),
    }));
    const proofs = (
      await this.db.query<Record<string, any>>('SELECT document_id, chain, address, message, valid, reason, attested_by FROM proofs WHERE run_id = $1 ORDER BY address, document_id', [runId])
    ).rows.map((r) => ({ documentId: r.document_id as string, chain: r.chain as string, address: r.address as string, message: r.message as string, valid: r.valid as boolean, reason: opt<string>(r.reason), attestedBy: opt<string>(r.attested_by) }));
    // Readable names of the sources ("BitRozmowy"), keyed by independence group.
    const sources: Record<string, string> = {};
    for (const c of ((run.params as { connectors?: { name: string; origin?: string }[] }).connectors ?? [])) {
      // several connectors may read one service (the live one and a local index of it): the first one names it
      if (c.origin && !sources[c.origin]) sources[c.origin] = c.name.replace(/\s*\(.*\)\s*$/, '');
    }
    const wallets = (await this.activities<{ chain: string; address: string; wallet: { address: string; via?: { txHash: string; with: string } }[] }>(runId))
      .map((a) => ({ chain: a.chain, root: a.address, members: a.wallet }));
    return {
      seeds: await this.caseIdentifiers(run.case_id), documents, hits, mentions, proofs, accounts: await this.chainAccounts(runId), sources,
      wallets, amountMatches: await this.amountMatches<any>(runId), names: await this.nameRecords<any>(runId),
      deployments: await this.deployments(runId),
      attestations: await this.attestations(runId),
      opinions: (await this.modelOutputs<{ origin: string; handle: string; verdict: 'same' | 'different' | 'unclear'; reasons: string[] }>(runId, 'judgement')).map((o) => ({ ...o.payload, model: o.model })),
      transfers: (await this.transfers(runId)).map((t) => ({ subject: t.subject, chain: t.chain as string, txHash: t.txHash, at: t.at, from: t.from, to: t.to })),
    };
  }

  async saveAssessment(
    runId: string,
    ruleset: { id: string; version: string },
    result: { clusters: unknown; histories?: unknown; links: { clusterId: string; chain: string; address: string; status: string; score: number; band: string }[] },
  ): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      'INSERT INTO assessments (run_id, ruleset_id, ruleset_version, ruleset, clusters, histories) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) RETURNING id',
      [runId, ruleset.id, ruleset.version, json(ruleset), json(result.clusters), json(result.histories ?? [])],
    );
    let position = 0;
    for (const l of result.links) {
      await this.db.query(
        'INSERT INTO links (assessment_id, run_id, position, cluster_id, chain, address, status, score, band, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)',
        [rows[0].id, runId, position++, l.clusterId, l.chain, l.address, l.status, l.score, l.band, json(l)],
      );
    }
    return rows[0].id;
  }

  /** The most recent scoring of a run, exactly as it was computed. */
  async latestAssessment<R = unknown, C = unknown, L = unknown, H = unknown>(runId: string): Promise<{ id: string; ruleset: R; clusters: C; histories: H; links: L[]; createdAt: string } | undefined> {
    const a = (await this.db.query<{ id: string; ruleset: R; clusters: C; histories: H; created_at: string }>('SELECT id, ruleset, clusters, histories, created_at FROM assessments WHERE run_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [runId])).rows[0];
    if (!a) return undefined;
    const links = (await this.db.query<{ detail: L }>('SELECT detail FROM links WHERE assessment_id = $1 ORDER BY position', [a.id])).rows.map((r) => r.detail);
    return { id: a.id, ruleset: a.ruleset, clusters: a.clusters, histories: a.histories, links, createdAt: a.created_at };
  }

  // ------------------------------------------------------------------ on-chain names

  async saveNameRecord(runId: string, record: { chain: string; address: string; verified: boolean } & Record<string, unknown>): Promise<void> {
    await this.db.query(
      `INSERT INTO name_records (run_id, chain, address, record) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (run_id, chain, address) DO UPDATE SET record = CASE WHEN (EXCLUDED.record->>'verified')::boolean THEN EXCLUDED.record ELSE name_records.record END`,
      [runId, record.chain, record.address, json(record)],
    );
  }

  async nameRecords<T = unknown>(runId: string): Promise<T[]> {
    return (await this.db.query<{ record: T }>('SELECT record FROM name_records WHERE run_id = $1 ORDER BY chain, address', [runId])).rows.map((r) => r.record);
  }

  // ------------------------------------------------------------------ stated amounts

  async saveStatedAmount(runId: string, documentId: string, a: { value: number; unit: string; raw: string; kind: 'price' | 'text' }): Promise<void> {
    await this.db.query('INSERT INTO stated_amounts (run_id, document_id, value, unit, raw, kind) VALUES ($1, $2, $3, $4, $5, $6)', [runId, documentId, a.value, a.unit, a.raw, a.kind]);
  }

  /** Stated amounts with the document each one stands in. */
  async statedAmounts(runId: string) {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT a.document_id, a.value, a.unit, a.raw, a.kind, d.url, d.doc_type, d.title, d.published_at, d.origin, d.author_handle
         FROM stated_amounts a JOIN documents d ON d.id = a.document_id WHERE a.run_id = $1 ORDER BY a.id`,
      [runId],
    );
    return rows.map((r) => ({
      documentId: r.document_id as string, url: r.url as string, docType: r.doc_type as string, title: (r.title ?? undefined) as string | undefined,
      at: (r.published_at ?? undefined) as string | undefined, value: Number(r.value), unit: r.unit as string, raw: r.raw as string, kind: r.kind as 'price' | 'text',
      origin: r.origin as string, authorHandle: (r.author_handle ?? undefined) as string | undefined,
    }));
  }

  async saveAmountMatches(runId: string, matches: unknown): Promise<void> {
    await this.db.query('INSERT INTO amount_matches (run_id, matches) VALUES ($1, $2::jsonb) ON CONFLICT (run_id) DO UPDATE SET matches = EXCLUDED.matches', [runId, json(matches)]);
  }

  async amountMatches<T = unknown>(runId: string): Promise<T[]> {
    return (await this.db.query<{ matches: T[] }>('SELECT matches FROM amount_matches WHERE run_id = $1', [runId])).rows[0]?.matches ?? [];
  }

  // ------------------------------------------------------------------ run events

  async addEvent(runId: string, seq: number, type: string, payload: unknown): Promise<void> {
    await this.db.query('INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, $2, $3, $4::jsonb)', [runId, seq, type, json(payload)]);
  }

  /** Events of a run in order, optionally only those after a given sequence number. */
  async events<E = Record<string, unknown>>(runId: string, after = 0): Promise<(E & { seq: number; at: string; type: string })[]> {
    const { rows } = await this.db.query<{ seq: number; type: string; payload: E; at: string | Date }>(
      'SELECT seq, type, payload, at FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq',
      [runId, after],
    );
    return rows.map((r) => ({ ...r.payload, seq: r.seq, type: r.type, at: r.at instanceof Date ? r.at.toISOString() : String(r.at) }));
  }
}
