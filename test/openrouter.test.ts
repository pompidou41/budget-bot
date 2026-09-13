import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeJson, OpenRouterError, parseJsonContent } from '../src/ai/openrouter.js';

const OPTIONS = { apiKey: 'k', model: 'anthropic/claude-sonnet-5' };
const SCHEMA = { name: 'answer', schema: { type: 'object' } };
const MESSAGES = [{ role: 'user' as const, content: 'вопрос' }];

function ok(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function bad(description: string): Response {
  return new Response(description, { status: 400 });
}

function formatOf(call: unknown[]): unknown {
  const init = call[1] as RequestInit;
  return (JSON.parse(String(init.body)) as { response_format?: unknown }).response_format;
}

describe('completeJson fallback ladder', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the strict schema when the provider accepts it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok('{"a":1}'));

    expect(await completeJson(OPTIONS, MESSAGES, SCHEMA)).toEqual({ a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(formatOf(fetchMock.mock.calls[0] as unknown[])).toMatchObject({ type: 'json_schema' });
  });

  it('steps down to json_object when the strict schema is refused', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bad('structured outputs not supported'))
      .mockResolvedValueOnce(ok('{"a":2}'));

    expect(await completeJson(OPTIONS, MESSAGES, SCHEMA)).toEqual({ a: 2 });
    expect(formatOf(fetchMock.mock.calls[1] as unknown[])).toEqual({ type: 'json_object' });
  });

  it('drops response_format entirely on a second refusal', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bad('no structured outputs'))
      .mockResolvedValueOnce(bad('json_object not supported'))
      .mockResolvedValueOnce(ok('```json\n{"a":3}\n```'));

    expect(await completeJson(OPTIONS, MESSAGES, SCHEMA)).toEqual({ a: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(formatOf(fetchMock.mock.calls[2] as unknown[])).toBeUndefined();
  });

  it('sends the schema in the prompt once it stops being a parameter', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bad('nope'))
      .mockResolvedValueOnce(ok('{"a":4}'));

    await completeJson(OPTIONS, MESSAGES, SCHEMA);
    const init = (fetchMock.mock.calls[1] as unknown[])[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };

    expect(body.messages.at(-1)?.content).toContain('JSON Schema');
  });

  it('does not retry a failure that is not about the response format', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('rate limited', { status: 429 }));

    await expect(completeJson(OPTIONS, MESSAGES, SCHEMA)).rejects.toThrow(OpenRouterError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up with the last error when every tier is refused', async () => {
    // A fresh Response per call: a body can only be read once
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => bad('never happy'));

    await expect(completeJson(OPTIONS, MESSAGES, SCHEMA)).rejects.toThrow('never happy');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('parseJsonContent', () => {
  it('unwraps a fenced block, which prompt-only mode tends to produce', () => {
    expect(parseJsonContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent('  {"a":1}  ')).toEqual({ a: 1 });
  });
});
