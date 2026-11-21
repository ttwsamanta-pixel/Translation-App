import { production } from '../../shared/src/config';
import { GoogleCloudProvider } from './cloud';
import { GeminiProvider, OpenAIProvider } from './llm';
import { postJson, ProviderError, TranslationInput, TranslationProvider, translations } from './http';

export { ProviderError } from './http';

class DeepLProvider implements TranslationProvider {
  validateConfiguration(credential?: string) {
    return Boolean(credential ?? process.env.DEEPL_API_KEY);
  }

  async translate({ text, source, target }: TranslationInput, credential?: string) {
    const key = credential ?? process.env.DEEPL_API_KEY;
    if (!key) throw new ProviderError('deepl_unconfigured');
    const origin = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const upper = target.toUpperCase();
    const targetLang = ['EN-GB', 'EN-US', 'PT-BR', 'PT-PT', 'ZH-HANS', 'ZH-HANT', 'ES-419'].includes(upper)
      ? upper
      : upper.split('-')[0];
    const body = {
      text,
      source_lang: source.split('-')[0].toUpperCase(),
      target_lang: targetLang,
    };
    if (Buffer.byteLength(JSON.stringify(body)) > 125_000)
      throw new ProviderError('segment_too_large', false);
    const data = await postJson<{ translations?: { text?: unknown }[] }>(
      'deepl',
      `${origin}/v2/translate`,
      { Authorization: `DeepL-Auth-Key ${key}` },
      body,
    );
    return translations(
      'deepl',
      Array.isArray(data.translations) ? data.translations.map((entry) => entry?.text) : undefined,
      text.length,
    );
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
  google_cloud: new GoogleCloudProvider(),
  gemini: new GeminiProvider(),
  openai: new OpenAIProvider(),
  mock: new MockProvider(),
};
