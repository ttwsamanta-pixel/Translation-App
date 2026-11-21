export const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );

export const articlePath = (slug: string) => '/article/' + encodeURIComponent(slug);
export const jsonLd = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function links(canonical: string, alternatives: { code: string; url: string }[]) {
  return (
    `<link rel="canonical" href="${escape(canonical)}">` +
    alternatives
      .map(({ code, url }) => `<link rel="alternate" hreflang="${escape(code)}" href="${escape(url)}">`)
      .join('')
  );
}
