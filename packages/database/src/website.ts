import {
  defaultWebsite,
  type Localization,
  type Website,
  type WebsiteOverride,
} from '../../shared/src/website';
import { execute, rows } from './db';

export function refreshWebsiteCache(domainId: number, conn?: Parameters<typeof execute>[2]) {
  return execute(
    'INSERT INTO public_cache_generations VALUES (?,1) ON DUPLICATE KEY UPDATE generation=generation+1',
    [domainId],
    conn,
  );
}

export async function websiteSettings(domain: { id: number; language_id: number }) {
  const [record] = await rows<{
    design: Website | null;
    overrides: WebsiteOverride | null;
    translations: Localization | null;
  }>(
    `SELECT v.configuration design,o.configuration overrides,t.translations
    FROM website_settings s LEFT JOIN website_versions v ON v.id=s.published_version
    LEFT JOIN website_domain_overrides o ON o.domain_id=?
    LEFT JOIN static_translations t ON t.language_id=? WHERE s.id=1`,
    [domain.id, domain.language_id],
  );
  return {
    design: { ...(record?.design ?? defaultWebsite), ...record?.overrides },
    translations: record?.translations ?? undefined,
  };
}
