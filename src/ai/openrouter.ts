import { logger } from '../logger.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;

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
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/** Parses model output that may be wrapped in a ```json fence. */
export function parseJsonContent(content: string): unknown {
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(unfenced);
}

async function request(
  options: OpenRouterOptions,
  messages: ChatMessage[],
  responseFormat?: Record<string, unknown>,
): Promise<unknown> {
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
      temperature: 0,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      // No provider filters: the owner's OpenRouter account enforces Zero Data Retention, and the
      // ZDR-eligible endpoints aren't all tagged with response_format support, so
      // `require_parameters` (or `data_collection: 'deny'`) left no endpoint at all.
      // Anthropic has ZDR endpoints on Bedrock and Vertex, but the Vertex ones advertise no
      // strict structured outputs — hence the fallback ladder in completeJson below.
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new OpenRouterError(
      `OpenRouter ${response.status}: ${body.slice(0, 500)}`,
      response.status,
    );
  }

  const data = JSON.parse(body) as {
    choices?: { message?: { content?: string | null } }[];
    error?: { message?: string };
  };
  if (data.error) throw new OpenRouterError(`OpenRouter: ${data.error.message ?? 'unknown error'}`);

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new OpenRouterError('OpenRouter returned empty content');
  return parseJsonContent(content);
}

/**
 * Chat completion constrained to a JSON schema, degrading as far as the endpoint allows.
 *
 * Providers differ in what they accept, and ZDR routing decides which one serves a request:
 * Anthropic on Bedrock advertises strict structured outputs, the same model on Vertex does
 * not, and neither is guaranteed to take `json_object`. So each 400 steps one rung down —
 * strict schema, then plain JSON mode, then the schema in the prompt and nothing else.
 * `parseJsonContent` unwraps the fenced block the last rung tends to produce, and the
 * caller's zod schema is what actually validates the result either way.
 */
export async function completeJson(
  options: OpenRouterOptions,
  messages: ChatMessage[],
  schema: JsonSchemaSpec,
): Promise<unknown> {
  const hint: ChatMessage = {
    role: 'system',
    content: `Ответ — только JSON по этой JSON Schema:\n${JSON.stringify(schema.schema)}`,
  };

  const tiers = [
    {
      name: 'json_schema',
      messages,
      format: {
        type: 'json_schema',
        json_schema: { name: schema.name, strict: true, schema: schema.schema },
      },
    },
    { name: 'json_object', messages: [...messages, hint], format: { type: 'json_object' } },
    { name: 'prompt-only', messages: [...messages, hint], format: undefined },
  ];

  for (const [index, tier] of tiers.entries()) {
    try {
      return await request(options, tier.messages, tier.format);
    } catch (error) {
      const last = index === tiers.length - 1;
      if (last || !(error instanceof OpenRouterError) || error.status !== 400) throw error;

      logger.warn(
        {
          model: options.model,
          rejected: tier.name,
          next: tiers[index + 1]?.name,
          error: error.message,
        },
        'Provider rejected the response format, stepping down',
      );
    }
  }

  // Unreachable: the last tier either returns or throws
  throw new OpenRouterError('OpenRouter: no response format was accepted');
}
