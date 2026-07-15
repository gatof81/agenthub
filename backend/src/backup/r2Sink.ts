/**
 * R2 snapshot sink (B3-04): Cloudflare R2 over its S3-compatible API,
 * SigV4-signed with aws4fetch (tiny, zero-dependency, Web Crypto). This is
 * the durability role ADR-002 assigns R2; it is never exercised in CI
 * (credential-free, 13 §6) — the local sink stands in there.
 *
 * Endpoint/credentials come from deployment config only (R-09): the bucket
 * name, account endpoint, and a scoped Object-Read-&-Write token.
 */

import { AwsClient } from 'aws4fetch';
import type { SnapshotSink, StoredSnapshot } from './types.js';

export interface R2SinkOptions {
  /** e.g. https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
}

export class R2SinkError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'R2SinkError';
  }
}

export class R2SnapshotSink implements SnapshotSink {
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: R2SinkOptions) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: 'auto', // R2 ignores region but SigV4 needs one
    });
    this.base = `${opts.endpoint.replace(/\/+$/, '')}/${opts.bucket}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Sign the request, then send it through the (injectable) fetch. */
  private async send(input: string, init?: RequestInit): Promise<Response> {
    const signed = await this.client.sign(input, init);
    return this.fetchImpl(signed);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const res = await this.send(`${this.base}/${key}`, {
      method: 'PUT',
      body,
      headers: { 'content-type': 'application/gzip' },
    });
    if (!res.ok) throw new R2SinkError(res.status, `R2 put ${key} failed (${res.status})`);
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.send(`${this.base}/${key}`);
    if (!res.ok) throw new R2SinkError(res.status, `R2 get ${key} failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.send(`${this.base}/${key}`, { method: 'DELETE' });
    // 204 delete, 404 already gone — both fine
    if (!res.ok && res.status !== 404) {
      throw new R2SinkError(res.status, `R2 delete ${key} failed (${res.status})`);
    }
  }

  /** ListObjectsV2, parsed from the S3 XML response (keys + sizes only). */
  async list(prefix: string): Promise<StoredSnapshot[]> {
    const out: StoredSnapshot[] = [];
    let token: string | undefined;
    do {
      const url = new URL(this.base);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', `${prefix}/`);
      if (token) url.searchParams.set('continuation-token', token);
      const res = await this.send(url.toString());
      if (!res.ok) throw new R2SinkError(res.status, `R2 list failed (${res.status})`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]+)<\/Key>/.exec(m[1]!)?.[1];
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? '0');
        if (key) out.push({ key, size });
      }
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
    } while (token);
    return out;
  }
}
