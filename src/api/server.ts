import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod/v4';
import { MAX_SUMMARY_DAYS, SUMMARY_PERIODS, type SummaryPeriod } from '../analytics/summary.js';
import { logger } from '../logger.js';

/** Loopback only: the API is for the assistant bot on the same machine, never for the network. */
export const API_HOST = '127.0.0.1';
export const MIN_TOKEN_LENGTH = 24;

export const MAX_BODY_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 90_000;
const MAX_QUESTION_LENGTH = 1000;
const MAX_CONTEXT_LENGTH = 1000;
const ASK_QUEUE = 3;

/** Read-only operations the API offers. There is deliberately nothing that writes. */
export interface MemoApiHandlers {
  ask(question: string): Promise<string>;
  summary(period: SummaryPeriod, days?: number): Promise<unknown>;
  balances(): Promise<unknown>;
}

export interface MemoApiOptions {
  token: string;
  handlers: MemoApiHandlers;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const askBody = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  context: z.string().trim().max(MAX_CONTEXT_LENGTH).optional(),
});

const summaryQuery = z.object({
  period: z.enum(SUMMARY_PERIODS).default('this_month'),
  days: z.coerce.number().int().min(1).max(MAX_SUMMARY_DAYS).optional(),
});

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time check; hashing first makes the buffers equal in length whatever was sent. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return match !== null && timingSafeEqual(digest(match[1] ?? ''), digest(token));
}

/** At most one job runs; up to `maxQueue` wait; the rest are turned away at once. */
export function createLimiter(maxQueue: number) {
  let running = false;
  const waiting: Array<() => void> = [];

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else running = false;
  }

  return {
    /** Resolves with a release function, or rejects when the queue is full. */
    acquire(): Promise<() => void> {
      if (!running) {
        running = true;
        return Promise.resolve(release);
      }
      if (waiting.length >= maxQueue) return Promise.reject(new HttpError(429, 'busy'));
      return new Promise((resolve) => waiting.push(() => resolve(release)));
    },
  };
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new HttpError(415, 'json_only');

  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'too_large');

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'too_large');
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

/** Answers 504 after `ms`; the signal lets queued work notice it is no longer wanted. */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HttpError(504, 'timeout'));
    }, ms);
  });
  return Promise.race([work(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

export function createMemoApi(options: MemoApiOptions): Server {
  const { token, handlers } = options;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const bodyLimit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const askLimiter = createLimiter(ASK_QUEUE);

  async function route(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    const only = (allowed: string) => {
      if (method !== allowed) throw new HttpError(405, 'method_not_allowed');
    };

    switch (url.pathname) {
      case '/v1/ask': {
        only('POST');
        const parsed = askBody.safeParse(await readJson(req, bodyLimit));
        if (!parsed.success) throw new HttpError(400, 'bad_request');
        const { question, context } = parsed.data;
        const full = context ? `${question}\n\n(Контекст от ассистента: ${context})` : question;

        const release = await askLimiter.acquire();
        try {
          // Waited out the deadline in the queue: the caller is gone, do not spend a model call
          if (signal.aborted) throw new HttpError(504, 'timeout');
          return { answer: await handlers.ask(full) };
        } finally {
          release();
        }
      }
      case '/v1/summary': {
        only('GET');
        const parsed = summaryQuery.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) throw new HttpError(400, 'bad_request');
        return handlers.summary(parsed.data.period, parsed.data.days);
      }
      case '/v1/balances':
        only('GET');
        return handlers.balances();
      default:
        throw new HttpError(404, 'not_found');
    }
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0];

    const finish = (status: number, body: unknown, close = false) => {
      if (close) {
        // The body was refused unread: end the connection rather than drain it
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
      }
      send(res, status, body);
      // Method, path and outcome only: no bodies, no query strings, no answers
      logger.info({ method: req.method, path, status, ms: Date.now() - started }, 'memo api');
    };

    // Authentication comes first, so an unauthenticated caller cannot even tell which paths exist
    if (!tokenMatches(req.headers.authorization, token)) {
      finish(401, { error: 'unauthorized' });
      req.resume();
      return;
    }

    withDeadline((signal) => route(req, signal), timeoutMs).then(
      (body) => finish(200, body),
      (error: unknown) => {
        if (error instanceof HttpError) {
          finish(error.status, { error: error.code }, error.status === 413 || error.status === 415);
          return;
        }
        logger.error({ error, method: req.method, path }, 'memo api handler failed');
        finish(502, { error: 'upstream_failed' });
      },
    );
  });

  server.requestTimeout = timeoutMs;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, API_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
