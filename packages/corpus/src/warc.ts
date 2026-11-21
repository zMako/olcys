/** One record of a WARC file: its headers and its raw body. */
export interface WarcRecord {
  headers: Record<string, string>;
  body: Buffer;
}

const HEADER_END = Buffer.from('\r\n\r\n');

/**
 * Reads WARC records from a stream of bytes (already decompressed), one at a time.
 * Nothing but the record being read is held in memory, so files of any size can be scanned.
 */
export async function* parseWarc(stream: AsyncIterable<Uint8Array>): AsyncGenerator<WarcRecord> {
  let buf: Buffer = Buffer.alloc(0);
  let need = 0; // bytes of the current record still to arrive, once its headers are known
  let headers: Record<string, string> | undefined;

  const take = function* (): Generator<WarcRecord> {
    for (;;) {
      if (!headers) {
        // skip the blank lines that separate records
        let start = 0;
        while (start < buf.length && (buf[start] === 13 || buf[start] === 10)) start++;
        if (start) buf = buf.subarray(start);
        const end = buf.indexOf(HEADER_END);
        if (end < 0) return;
        const parsed: Record<string, string> = {};
        const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
        if (!lines[0].startsWith('WARC/')) throw new Error(`Not a WARC record: ${lines[0].slice(0, 40)}`);
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          if (colon > 0) parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        headers = parsed;
        need = Number(parsed['content-length'] ?? 0);
        buf = buf.subarray(end + HEADER_END.length);
      }
      if (buf.length < need) return;
      yield { headers, body: buf.subarray(0, need) };
      buf = buf.subarray(need);
      headers = undefined;
    }
  };

  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    yield* take();
  }
  yield* take();
}
