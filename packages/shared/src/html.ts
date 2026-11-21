import { load } from 'cheerio';
import sanitize from 'sanitize-html';

export function sanitizeArticle(html: string) {
  return sanitize(html, {
    allowedTags: [...sanitize.defaults.allowedTags, 'img', 'figure', 'figcaption', 'details', 'summary'],
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
  });
}

export function htmlSegments(html: string) {
  const $ = load(sanitizeArticle(html), {}, false);
  const segments: string[] = [];
  const updates: ((value: string) => void)[] = [];
  $('*')
    .add($.root())
    .contents()
    .each((_index, node) => {
      if (node.type !== 'text' || !node.data.trim() || $(node).parents('code,pre,kbd,samp').length) return;
      const parts = node.data.split(/(\[[^\]\n]{1,120}\]|\{\{[^}\n]+\}\})/g);
      updates.push(
        ...parts.flatMap((part, index) => {
          if (index % 2 || !part.trim()) return [];
          segments.push(part.trim());
          return [
            (value: string) => {
              parts[index] = (part.match(/^\s*/)?.[0] ?? '') + value + (part.match(/\s*$/)?.[0] ?? '');
              node.data = parts.join('');
            },
          ];
        }),
      );
    });
  $('img[alt]').each((_index, image) => {
    const value = $(image).attr('alt')?.trim();
    if (!value) return;
    segments.push(value);
    updates.push((translated) => {
      $(image).attr('alt', translated);
    });
  });
  return {
    segments,
    render(values: string[]) {
      if (values.length !== updates.length || values.some((value) => !value.trim()))
        throw new Error('invalid_translation_segments');
      updates.forEach((update, index) => update(values[index]));
      return $.html();
    },
  };
}

function visitUrls(
  html: string,
  source: string,
  visit: (url: URL, write: (value: string) => void, link: boolean) => void,
) {
  const $ = load(html, {}, false);
  $('a[href], img[src]').each((_index, node) => {
    const property = node.name === 'a' ? 'href' : 'src';
    const raw = $(node).attr(property);
    if (!raw || raw.startsWith('#')) return;
    try {
      const url = new URL(raw, source);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      visit(
        url,
        (value) => {
          $(node).attr(property, value);
        },
        property === 'href',
      );
    } catch {
      /* Preserve unresolvable links. */
    }
  });
  return $.html();
}

export function linkTargets(html: string, source: string) {
  const found = new Set<string>();
  visitUrls(html, source, (url, _write, link) => {
    if (!link || url.hostname !== new URL(source).hostname) return;
    url.hash = '';
    url.search = '';
    const key = url.href.replace(/\/$/, '');
    if (found.size < 500) {
      found.add(key);
      found.add(key + '/');
    }
  });
  return [...found];
}

export function rewriteLinks(html: string, source: string, translations: Map<string, string>) {
  return visitUrls(html, source, (url, write, link) => {
    const suffix = url.search + url.hash;
    url.search = '';
    url.hash = '';
    const path = link ? translations.get(url.href.replace(/\/$/, '')) : undefined;
    write((path ?? url.href) + suffix);
  });
}

export function firstImageMatches(html: string, featuredImage: string, source: string) {
  const $ = load(html, {}, false);
  const first = $('img[src]').first().attr('src');
  if (!first) return false;
  try {
    return new URL(first, source).href === new URL(featuredImage, source).href;
  } catch {
    return false;
  }
}
