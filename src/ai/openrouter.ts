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
  responseFormat: Record<string, unknown>,
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
      response_format: responseFormat,
      // No provider filters: the owner's OpenRouter account enforces Zero Data Retention, and the
      // ZDR-eligible Google endpoints aren't tagged with response_format support, so
      // `require_parameters` (or `data_collection: 'deny'`) left no endpoint at all.
      // Google still honours the JSON schema; zod + the json_object fallback cover the rest.
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
 * Chat completion constrained to a JSON schema. If the provider rejects the
 * strict schema (400), retries once in plain JSON mode with the schema in the prompt.
 */
export async function completeJson(
  options: OpenRouterOptions,
  messages: ChatMessage[],
  schema: JsonSchemaSpec,
): Promise<unknown> {
  try {
    return await request(options, messages, {
      type: 'json_schema',
      json_schema: { name: schema.name, strict: true, schema: schema.schema },
    });
  } catch (error) {
    if (!(error instanceof OpenRouterError) || error.status !== 400) throw error;

    logger.warn(
      { error: error.message },
      'Strict JSON schema rejected, retrying in json_object mode',
    );
    const schemaHint: ChatMessage = {
      role: 'system',
      content: `Ответ — только JSON по этой JSON Schema:\n${JSON.stringify(schema.schema)}`,
    };
    return request(options, [...messages, schemaHint], { type: 'json_object' });
  }
}
