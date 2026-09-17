import { logger } from '../logger.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;
/** Thinking first makes answers slower: a review with a reasoning budget can take a minute. */
const REASONING_TIMEOUT_MS = 180_000;
/** Room for the visible answer on top of the reasoning budget. */
const ANSWER_TOKENS = 8_000;

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  /** Reasoning budget in tokens; unset means the model answers without thinking first. */
  reasoningTokens?: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The call succeeded but the content was not the JSON we asked for. */
    readonly malformed = false,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/**
 * Finds the first balanced JSON object or array in free text, ignoring braces inside strings.
 * Returns null when the text holds no complete value — a truncated answer must not look valid.
 */
function extractJsonValue(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;

  const open = text[start] === '{' ? '{' : '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return text.slice(start, i + 1);
  }

  return null;
}

/**
 * Parses model output that may be wrapped in a ```json fence, or buried in prose.
 *
 * Endpoints that ignore `response_format` answer conversationally, and a model told to sound
 * human often wraps the object in a sentence or two. The object itself is still the answer we
 * asked for, so it is dug out rather than thrown away; only genuinely absent JSON throws.
 */
export function parseJsonContent(content: string): unknown {
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(unfenced);
  } catch (error) {
    const embedded = extractJsonValue(unfenced);
    if (embedded === null) throw error;
    return JSON.parse(embedded);
  }
}

async function request(
  options: OpenRouterOptions,
  messages: ChatMessage[],
  responseFormat?: Record<string, unknown>,
): Promise<unknown> {
  const reasoning = options.reasoningTokens;
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'budget-bot',
    },
    body: JSON.stringify({
      model: options.model,
      messages,
      // `reasoning.effort` is silently ignored on the ZDR Vertex endpoint; an explicit token
      // budget is honoured. Thinking models also don't need a sampling temperature.
      ...(reasoning
        ? { reasoning: { max_tokens: reasoning }, max_tokens: reasoning + ANSWER_TOKENS }
        : { temperature: 0 }),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      // No provider filters: the owner's OpenRouter account enforces Zero Data Retention, and
      // `require_parameters` (or `data_collection: 'deny'`) left no endpoint at all. For Claude
      // that routing lands on Google Vertex, which accepts `response_format` but ignores it —
      // hence the schema in the prompt and the fallback ladder in completeJson below.
    }),
    signal: AbortSignal.timeout(reasoning ? REASONING_TIMEOUT_MS : TIMEOUT_MS),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new OpenRouterError(
      `OpenRouter ${response.status}: ${body.slice(0, 500)}`,
      response.status,
    );
  }

  const data = JSON.parse(body) as {
    provider?: string;
    choices?: { message?: { content?: string | null } }[];
    error?: { message?: string };
  };
  if (data.error) throw new OpenRouterError(`OpenRouter: ${data.error.message ?? 'unknown error'}`);

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new OpenRouterError('OpenRouter returned empty content');

  try {
    return parseJsonContent(content);
  } catch {
    // Short excerpt on purpose: `describeError` caps the whole message at 200 characters before
    // it reaches Telegram, so a longer one here would only push the provider name out of view
    throw new OpenRouterError(
      `OpenRouter (${data.provider ?? 'unknown provider'}) returned non-JSON content: ${content.slice(0, 120)}`,
      response.status,
      true,
    );
  }
}

/**
 * Chat completion constrained to a JSON schema, degrading as far as the endpoint allows.
 *
 * Providers disagree on response formats, and ZDR routing decides which one answers. Some
 * reject an unsupported format with a 400; Vertex serving Claude takes it and replies with
 * prose. So the schema always travels in the prompt too, and either failure — a 400 or
 * content that isn't JSON — steps one rung down: strict schema, plain JSON mode, then the
 * prompt alone. The caller's zod schema is what actually validates the result.
 */
export async function completeJson(
  options: OpenRouterOptions,
  messages: ChatMessage[],
  schema: JsonSchemaSpec,
): Promise<unknown> {
  // The hint rides as `user`, not `system`: providers serving Claude merge every system message
  // into one block at the top of the prompt, which buries this instruction under the analyst's
  // «пиши обычным текстом» rules. Left there it loses the moment a conversation grows past the
  // first round, and the model answers in prose. As the last user turn it stays where it lands.
  const hinted: ChatMessage[] = [
    ...messages,
    {
      role: 'user',
      content: `Ответ — только JSON по этой JSON Schema, без пояснений и без markdown:\n${JSON.stringify(schema.schema)}`,
    },
  ];

  const tiers: { name: string; format?: Record<string, unknown> }[] = [
    {
      name: 'json_schema',
      format: {
        type: 'json_schema',
        json_schema: { name: schema.name, strict: true, schema: schema.schema },
      },
    },
    { name: 'json_object', format: { type: 'json_object' } },
    { name: 'prompt-only' },
  ];

  for (const [index, tier] of tiers.entries()) {
    try {
      return await request(options, hinted, tier.format);
    } catch (error) {
      const last = index === tiers.length - 1;
      const stepDown =
        error instanceof OpenRouterError && (error.status === 400 || error.malformed);
      if (last || !stepDown) throw error;

      logger.warn(
        {
          model: options.model,
          rejected: tier.name,
          next: tiers[index + 1]?.name,
          error: error.message,
        },
        'Provider did not honour the response format, stepping down',
      );
    }
  }

  // Unreachable: the last tier either returns or throws
  throw new OpenRouterError('OpenRouter: no response format was accepted');
}
