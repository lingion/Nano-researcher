import type { LlmCompletion, LlmMessage, LlmProvider } from './provider.ts';

interface AnthropicResponse { content?: Array<{ type?: string; text?: unknown }>; model?: string; usage?: unknown }

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly structuredOutputMode = 'none' as const;

  constructor(private readonly options: AnthropicOptions) {}

  async complete(input: { messages: LlmMessage[]; signal?: AbortSignal }): Promise<LlmCompletion> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('LLM request timed out')), this.options.timeoutMs ?? 120_000);
    const abort = () => controller.abort(input.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const system = input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
      const messages = input.messages.filter((message) => message.role !== 'system');
      const response = await (this.options.fetchImpl ?? fetch)(this.options.baseUrl, {
        method: 'POST',
        headers: { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.options.model, max_tokens: 16_384, ...(system ? { system } : {}), messages }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
      const payload = await response.json() as AnthropicResponse;
      const text = payload.content?.find((block) => block.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error('LLM response did not contain a text content block');
      return { text, model: payload.model ?? this.options.model, usage: payload.usage };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
    }
  }
}
