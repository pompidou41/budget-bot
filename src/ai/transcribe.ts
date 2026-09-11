const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const TIMEOUT_MS = 60_000;

export interface TranscriberOptions {
  apiKey: string;
  model: string;
}

/** Speech-to-text for a voice message. `filename` extension tells Groq the format. */
export type Transcriber = (
  audio: ArrayBuffer,
  filename: string,
  prompt?: string,
) => Promise<string>;

export function createTranscriber(options: TranscriberOptions): Transcriber {
  return async (audio, filename, prompt) => {
    const form = new FormData();
    form.append('file', new Blob([audio]), filename);
    form.append('model', options.model);
    form.append('language', 'ru');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (prompt) form.append('prompt', prompt);

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await response.text();
    if (!response.ok) throw new Error(`Groq ${response.status}: ${body.slice(0, 300)}`);

    const text = (JSON.parse(body) as { text?: string }).text?.trim();
    if (!text) throw new Error('Groq returned an empty transcription');
    return text;
  };
}
