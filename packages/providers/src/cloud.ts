import { postJson, ProviderError, TranslationInput, TranslationProvider, translations } from './http';

function googleLanguage(locale: string) {
  const { language, script, region } = new Intl.Locale(locale);
  if (language === 'zh')
    return script === 'Hant' || ['TW', 'HK', 'MO'].includes(region ?? '') ? 'zh-TW' : 'zh-CN';
  return language;
}

export class GoogleCloudProvider implements TranslationProvider {
  maxBatchBytes = 90_000;

  validateConfiguration(credential?: string) {
    return Boolean(credential);
  }

  async translate({ text, source, target }: TranslationInput, credential?: string) {
    if (!credential) throw new ProviderError('google_cloud_unconfigured');
    const response = await postJson<{ data?: { translations?: { translatedText?: unknown }[] } }>(
      'google_cloud',
      'https://translation.googleapis.com/language/translate/v2',
      { 'X-Goog-Api-Key': credential },
      { q: text, source: googleLanguage(source), target: googleLanguage(target), format: 'text' },
    );
    return translations(
      'google_cloud',
      Array.isArray(response.data?.translations)
        ? response.data.translations.map((item) => item?.translatedText)
        : undefined,
      text.length,
    );
  }
}
