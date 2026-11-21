import { production } from '../../shared/src/config';

export type TranslationInput = { text: string[]; source: string; target: string };
export interface TranslationProvider {
  translate(input: TranslationInput): Promise<string[]>;
  validateConfiguration(): boolean;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly transient = true,
  ) {
    super(code);
  }
}

class DeepLProvider implements TranslationProvider {
  validateConfiguration() {
    return Boolean(process.env.DEEPL_API_KEY);
  }

  async translate({ text, source, target }: TranslationInput) {
    const key = process.env.DEEPL_API_KEY;
    if (!key) throw new ProviderError('deepl_unconfigured');
    const origin = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const upper = target.toUpperCase();
    const targetLang = ['EN-GB', 'EN-US', 'PT-BR', 'PT-PT', 'ZH-HANS', 'ZH-HANT', 'ES-419'].includes(upper)
      ? upper
      : upper.split('-')[0];
    const body = JSON.stringify({
      text,
      source_lang: source.split('-')[0].toUpperCase(),
      target_lang: targetLang,
    });
    if (Buffer.byteLength(body) > 125_000) throw new ProviderError('segment_too_large', false);
    let response: Response;
    try {
      response = await fetch(`${origin}/v2/translate`, {
        method: 'POST',
        signal: AbortSignal.timeout(25_000),
        redirect: 'error',
        headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
        body,
      });
    } catch {
      throw new ProviderError('deepl_network');
    }
    if (!response.ok)
      throw new ProviderError(`deepl_http_${response.status}`, ![400, 413, 414].includes(response.status));
    const data = (await response.json().catch(() => null)) as { translations?: { text?: unknown }[] } | null;
    const output = Array.isArray(data?.translations)
      ? data.translations.map((entry) => entry?.text)
      : undefined;
    if (
      !output ||
      output.length !== text.length ||
      !output.every((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    ) {
      throw new ProviderError('deepl_invalid_response');
    }
    return output;
  }
}

class MockProvider implements TranslationProvider {
  validateConfiguration() {
    return !production && process.env.ALLOW_MOCK_TRANSLATION === 'true';
  }

  async translate({ text, target }: TranslationInput) {
    if (!this.validateConfiguration()) throw new ProviderError('mock_disabled');
    return text.map((value) => `[${target} · Démo] ${value}`);
  }
}

export const providers: Record<string, TranslationProvider> = {
  deepl: new DeepLProvider(),
  mock: new MockProvider(),
};
