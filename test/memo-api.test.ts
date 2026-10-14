import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_HOST,
  createMemoApi,
  listen,
  tokenMatches,
  type MemoApiHandlers,
} from '../src/api/server.js';

const TOKEN = 'test-token-0123456789-abcdefgh';
const servers: Server[] = [];

function handlers(overrides: Partial<MemoApiHandlers> = {}): MemoApiHandlers {
  return {
    ask: vi.fn(async () => 'ответ'),
    summary: vi.fn(async () => ({ expenses_usd: 1 })),
    balances: vi.fn(async () => ({ capital_usd: 2 })),
    ...overrides,
  };
}

async function start(h: MemoApiHandlers, extra: { requestTimeoutMs?: number } = {}) {
  const server = createMemoApi({ token: TOKEN, handlers: h, ...extra });
  await listen(server, 0);
  servers.push(server);
  const { address, port } = server.address() as AddressInfo;
  expect(address).toBe(API_HOST);
  return `http://${API_HOST}:${port}`;
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'Content-Type': 'application/json' };

function post(base: string, body: unknown, headers: Record<string, string> = json) {
  return fetch(`${base}/v1/ask`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('tokenMatches', () => {
  it('accepts only the exact bearer token', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches('Bearer ', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });
});

describe('authentication', () => {
  it('rejects a missing or wrong token with 401 on every path, before routing', async () => {
    const h = handlers();
    const base = await start(h);

    for (const path of ['/v1/balances', '/v1/ask', '/v1/summary', '/nope']) {
      expect((await fetch(base + path)).status).toBe(401);
      const wrong = await fetch(base + path, { headers: { Authorization: 'Bearer wrong' } });
      expect(wrong.status).toBe(401);
    }
    expect(h.balances).not.toHaveBeenCalled();
    expect(h.ask).not.toHaveBeenCalled();
  });
});

describe('routing', () => {
  it('404 for unknown paths and 405 for the wrong method', async () => {
    const base = await start(handlers());
    expect((await fetch(`${base}/v1/nope`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v1/ask`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/v1/balances`, { method: 'POST', headers: json })).status).toBe(
      405,
    );
    // Read-only: no way to write an operation
    expect((await fetch(`${base}/v1/operations`, { method: 'POST', headers: json })).status).toBe(
      404,
    );
  });

  it('serves balances', async () => {
    const base = await start(handlers());
    const res = await fetch(`${base}/v1/balances`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ capital_usd: 2 });
  });

  it('passes validated summary parameters through', async () => {
    const h = handlers();
    const base = await start(h);

    await fetch(`${base}/v1/summary`, { headers: auth });
    expect(h.summary).toHaveBeenLastCalledWith('this_month', undefined);

    await fetch(`${base}/v1/summary?period=last_days&days=7`, { headers: auth });
    expect(h.summary).toHaveBeenLastCalledWith('last_days', 7);

    for (const query of ['period=year', 'period=last_days&days=0', 'days=9999', 'days=abc']) {
      expect((await fetch(`${base}/v1/summary?${query}`, { headers: auth })).status).toBe(400);
    }
  });
});

describe('POST /v1/ask', () => {
  it('returns the answer as JSON', async () => {
    const h = handlers();
    const base = await start(h);
    const res = await post(base, { question: 'сколько я потратил?' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ answer: 'ответ' });
    expect(h.ask).toHaveBeenCalledWith('сколько я потратил?');
  });

  it('adds the optional context to the question', async () => {
    const h = handlers();
    const base = await start(h);
    await post(base, { question: 'а на еду?', context: 'речь про сентябрь' });

    expect(vi.mocked(h.ask).mock.calls[0]?.[0]).toContain('а на еду?');
    expect(vi.mocked(h.ask).mock.calls[0]?.[0]).toContain('речь про сентябрь');
  });

  it('rejects invalid bodies', async () => {
    const h = handlers();
    const base = await start(h);

    expect((await post(base, { question: '' })).status).toBe(400);
    expect((await post(base, { question: 'x'.repeat(1001) })).status).toBe(400);
    expect((await post(base, { question: 5 })).status).toBe(400);
    expect((await post(base, '{not json')).status).toBe(400);
    expect(
      (await post(base, { question: 'q' }, { ...auth, 'Content-Type': 'text/plain' })).status,
    ).toBe(415);
    expect((await post(base, { question: 'q' }, auth)).status).toBe(415);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('rejects a body over 16 KB with 413', async () => {
    const h = handlers();
    const base = await start(h);
    const res = await post(base, { question: 'q', context: 'x'.repeat(20 * 1024) });

    expect(res.status).toBe(413);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('rejects an oversized body that does not declare its length', async () => {
    const h = handlers();
    const base = await start(h);
    const big = new Blob(['{"question":"', 'x'.repeat(20 * 1024), '"}']).stream();
    const res = await fetch(`${base}/v1/ask`, {
      method: 'POST',
      headers: json,
      body: big,
      duplex: 'half',
    } as RequestInit);

    expect(res.status).toBe(413);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('hides the cause when the pipeline fails', async () => {
    const base = await start(
      handlers({
        ask: vi.fn(async () => {
          throw new Error('OPENROUTER_API_KEY=sk-secret exploded');
        }),
      }),
    );
    const res = await post(base, { question: 'q' });
    const text = await res.text();

    expect(res.status).toBe(502);
    expect(text).not.toContain('sk-secret');
  });

  it('answers 504 when the pipeline outlasts the request timeout', async () => {
    const base = await start(handlers({ ask: () => new Promise<string>(() => undefined) }), {
      requestTimeoutMs: 50,
    });
    expect((await post(base, { question: 'q' })).status).toBe(504);
  });

  it('runs one question at a time, queues three, and turns the rest away', async () => {
    const releases: Array<(answer: string) => void> = [];
    const ask = vi.fn(() => new Promise<string>((resolve) => releases.push(resolve)));
    const base = await start(handlers({ ask }));

    const pending = Array.from({ length: 4 }, (_, i) => post(base, { question: `q${i}` }));
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    // Give the other three time to reach the queue
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ask).toHaveBeenCalledTimes(1);

    const rejected = await post(base, { question: 'one too many' });
    expect(rejected.status).toBe(429);

    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(i));
      releases[i]?.(`a${i}`);
    }
    const statuses = await Promise.all(pending.map(async (p) => (await p).status));
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it('does not spend a model call on a request that timed out in the queue', async () => {
    const ask = vi.fn(() => new Promise<string>(() => undefined));
    const base = await start(handlers({ ask }), { requestTimeoutMs: 100 });

    const first = post(base, { question: 'blocks the line' });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    const second = await post(base, { question: 'waits in the queue' });
    expect(second.status).toBe(504);
    expect((await first).status).toBe(504);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
