/**
 * B3-04 R2 sink: verifies the S3 wire shape (signed PUT/GET/DELETE, prefix
 * ListObjectsV2 with XML parsing + pagination) against a mock fetch —
 * offline, no credentials, no network.
 */

import { describe, expect, it, vi } from 'vitest';
import { R2SinkError, R2SnapshotSink } from '../src/backup/r2Sink.js';

const OPTS = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'test-bucket',
  accessKeyId: 'AKIA-test',
  secretAccessKey: 'secret-test',
};

const listXml = (keys: string[], next?: string): string =>
  `<?xml version="1.0"?><ListBucketResult>${keys
    .map((k) => `<Contents><Key>${k}</Key><Size>${k.length}</Size></Contents>`)
    .join('')}${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`;

describe('R2SnapshotSink', () => {
  it('PUTs a signed request to the bucket/key with the object body', async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (req: Request) => {
      calls.push(req);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const sink = new R2SnapshotSink({ ...OPTS, fetchImpl });

    await sink.put('snapshots/x.sqlite.gz', new Uint8Array([1, 2, 3]));
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('https://acct.r2.cloudflarestorage.com/test-bucket/snapshots/x.sqlite.gz');
    // SigV4 signing headers are present (aws4fetch)
    expect(calls[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(calls[0]!.headers.get('x-amz-content-sha256')).toBeTruthy();
  });

  it('throws R2SinkError with the status on a failed PUT', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    const sink = new R2SnapshotSink({ ...OPTS, fetchImpl });
    const err = await sink.put('k', new Uint8Array()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(R2SinkError);
    expect((err as R2SinkError).status).toBe(403);
  });

  it('GET returns the object bytes', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array([9, 8, 7]), { status: 200 }),
    ) as unknown as typeof fetch;
    const sink = new R2SnapshotSink({ ...OPTS, fetchImpl });
    expect([...(await sink.get('k'))]).toEqual([9, 8, 7]);
  });

  it('DELETE tolerates 404 (already gone) but surfaces other errors', async () => {
    let status = 404;
    const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
    const sink = new R2SnapshotSink({ ...OPTS, fetchImpl });
    await expect(sink.delete('gone')).resolves.toBeUndefined();
    status = 500;
    await expect(sink.delete('boom')).rejects.toBeInstanceOf(R2SinkError);
  });

  it('list parses ListObjectsV2 XML and follows continuation tokens', async () => {
    const pages = [listXml(['snapshots/a.gz', 'snapshots/b.gz'], 'TKN'), listXml(['snapshots/c.gz'])];
    let i = 0;
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (req: Request) => {
      seen.push(req.url);
      return new Response(pages[i++]!, { status: 200 });
    }) as unknown as typeof fetch;
    const sink = new R2SnapshotSink({ ...OPTS, fetchImpl });

    const out = await sink.list('snapshots');
    expect(out.map((s) => s.key)).toEqual(['snapshots/a.gz', 'snapshots/b.gz', 'snapshots/c.gz']);
    expect(seen[0]).toContain('list-type=2');
    expect(seen[0]).toContain('prefix=snapshots%2F');
    expect(seen[1]).toContain('continuation-token=TKN');
  });
});
