export const providerKinds = ['deepl', 'google_cloud', 'gemini', 'openai'] as const;
export type ProviderKind = (typeof providerKinds)[number];

export const providerCatalog = {
  deepl: { name: 'DeepL', defaultModel: null },
  google_cloud: { name: 'Google Cloud Translation', defaultModel: null },
  gemini: { name: 'Gemini', defaultModel: 'gemini-3.5-flash-lite' },
  openai: { name: 'OpenAI', defaultModel: 'gpt-5-mini' },
} satisfies Record<ProviderKind, { name: string; defaultModel: string | null }>;

export function isProviderKind(value: unknown): value is ProviderKind {
  return providerKinds.some((kind) => kind === value);
}
