export type TranslationInput = { text: string[]; source: string; target: string };
export interface TranslationProvider {
  maxBatchBytes?: number;
  translate(input: TranslationInput, credential?: string, model?: string): Promise<string[]>;
  validateConfiguration(credential?: string): boolean;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly transient = true,
  ) {
    super(code);
  }
}

export async function postJson<T>(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: object,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(40_000),
      redirect: 'error',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProviderError(provider + '_network');
  }
  if (!response.ok)
    throw new ProviderError(
      provider + '_http_' + response.status,
      ![400, 413, 414, 422].includes(response.status),
    );
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new ProviderError(provider + '_invalid_response');
  return data as T;
}

export function translations(provider: string, output: unknown, count: number): string[] {
  if (
    !Array.isArray(output) ||
    output.length !== count ||
    !output.every((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  ) {
    throw new ProviderError(provider + '_invalid_response');
  }
  return output;
}
