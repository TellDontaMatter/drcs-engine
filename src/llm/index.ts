/**
 * LLM CLIENT — the single place the engine talks to a large language model.
 *
 * Used by C5 (Misalignment Protocol — fresh caption generation) and by the
 * simplified prompt-input layer (turning a free-form idea into the structured
 * fields the gate pipeline needs). Isolating the network call here means:
 *   - there is exactly ONE code path to configure/observe, and
 *   - tests mock the LLM by spying on `callLLM` on THIS module object
 *     (`jest.spyOn(llm, 'callLLM')`), so no real network call is ever made in CI.
 *
 * Transport: the Abacus.AI RouteLLM OpenAI-compatible endpoint. The API key is
 * read from `process.env.ABACUS_API_KEY` at call time. If the key is missing or
 * the request fails, `callLLM` throws — callers (C5, the prompt layer) are
 * responsible for degrading gracefully.
 */

/** A single chat message in the OpenAI-compatible shape. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Options for {@link callLLM}. */
export interface CallLlmOptions {
  /** Optional system prompt prepended to the conversation. */
  system?: string;
  /** Sampling temperature (0 = mostly deterministic). Default: 0.4. */
  temperature?: number;
  /** Model identifier to route to. Default: a fast general-purpose model. */
  model?: string;
  /** Abort the request after this many milliseconds. Default: 20000. */
  timeout_ms?: number;
}

/** Abacus.AI RouteLLM OpenAI-compatible chat-completions endpoint. */
const ENDPOINT = 'https://routellm.abacus.ai/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Raised when the LLM cannot be reached or returns an error / empty response.
 * Callers catch this and degrade gracefully (never crash the pipeline).
 */
export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Send a prompt to the LLM and return the assistant's text.
 *
 * @param prompt The user message.
 * @param options Optional system prompt / temperature / model / timeout.
 * @returns The assistant's text content (trimmed, non-empty).
 * @throws LlmError when the API key is missing, the request fails, or the
 *   response contains no usable content.
 */
export async function callLLM(
  prompt: string,
  options: CallLlmOptions = {},
): Promise<string> {
  const apiKey = process.env.ABACUS_API_KEY;
  if (!apiKey) {
    throw new LlmError('ABACUS_API_KEY is not set; cannot call the LLM.');
  }

  const messages: LlmMessage[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout_ms ?? 20000);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        messages,
        temperature: options.temperature ?? 0.4,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LlmError(
      `LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new LlmError(`LLM returned HTTP ${res.status}.`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new LlmError('LLM returned a non-JSON response.');
  }

  const content = extractContent(data);
  if (!content) {
    throw new LlmError('LLM response contained no usable text.');
  }
  return content.trim();
}

/** Pull the assistant text out of an OpenAI-compatible chat-completions body. */
function extractContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  return typeof content === 'string' && content.trim().length > 0 ? content : null;
}
