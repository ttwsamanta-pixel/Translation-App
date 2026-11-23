import type { Labels, Website } from '../../../packages/shared/src/website';
import { escape } from './seo';

export type EditionLink = { name: string; code: string; url: string | null; current: boolean };

export type TemplateContext = {
  code: string;
  design: Website;
  labels: Labels;
  rss: boolean;
  editions: EditionLink[];
  categoryLabels?: Record<string, string>;
};

export const categoryPath = (name: string) => '/category/' + encodeURIComponent(name);
export const authorPath = (name: string) => '/author/' + encodeURIComponent(name);
export const categoryLabel = (site: TemplateContext, name: string) =>
  site.categoryLabels && Object.hasOwn(site.categoryLabels, name) ? site.categoryLabels[name] : name;

export function adSlot(context: TemplateContext, slot: Website['ads'][number]['slot']) {
  const ad = context.design.ads.find((item) => item.slot === slot);
  return ad
    ? `<aside class="ad" aria-label="${escape(context.labels.advertisement)}"><a href="${escape(ad.url)}" rel="sponsored"><img src="${escape(ad.image)}" alt="${escape(ad.label)}" loading="lazy"></a></aside>`
    : '';
}

const style = `<style>
*{box-sizing:border-box}body{margin:0;color:#172338;background:#f5f7fa;line-height:1.55}a{color:var(--primary)}
img{display:block;max-width:100%;height:auto}button,input{font:inherit}button{cursor:pointer}.masthead,footer{background:#fff}
.masthead{border-top:4px solid var(--accent);border-bottom:1px solid #dce2eb}.frame{max-width:1260px;margin:auto;padding:0 24px}
.brand-row{display:flex;gap:20px;flex-wrap:wrap;align-items:center;padding-block:20px;justify-content:space-between}
.brand{font-size:1.4rem;text-transform:uppercase;font-weight:900;text-decoration:none;line-height:1.1}.brand img{max-width:220px;max-height:56px}
.tools,nav,footer .frame{display:flex;align-items:center;gap:16px;flex-wrap:wrap}nav{padding-block:12px;border-top:1px solid #e7ebf1}
nav a,footer a{font-weight:650;text-decoration:none}nav a:hover,footer a:hover{text-decoration:underline}.tools form,.search{display:flex;gap:6px}
input,button,summary{padding:8px 10px;border:1px solid #cad4e2;background:white;border-radius:5px;color:var(--primary)}input{max-width:100%;min-width:0}
button{background:var(--primary);border-color:var(--primary);color:white}details{position:relative}summary{cursor:pointer}
.editions{position:absolute;z-index:2;right:0;width:min(280px,80vw);max-height:320px;overflow:auto;background:white;box-shadow:0 8px 24px #12253f22;padding:12px;border:1px solid #dce2eb}
.editions [data-edition]{display:block;padding:5px 2px}.editions [hidden]{display:none}.editions span{color:#536279}.editions input{width:100%;margin-bottom:8px}main.frame{min-height:60vh;padding-block:25px 50px}
h1,h2,h3{line-height:1.15}.heading{border-left:4px solid var(--accent);padding-left:12px}.block{margin:0 0 32px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.card{background:white;border:1px solid #dce2eb;border-radius:8px;overflow:hidden}.card img{aspect-ratio:16/9;width:100%;object-fit:cover}.card div{padding:15px}
.card h3{margin:0 0 8px;font-size:1.1rem}.card a{text-decoration:none}.featured .card:first-child{grid-column:span 2}.featured .card:first-child h3{font-size:1.5rem}
.taxonomy{display:flex;gap:12px;flex-wrap:wrap}.taxonomy a{background:white;border:1px solid #dce2eb;border-radius:5px;padding:8px 12px;text-decoration:none}
article.story{max-width:960px;margin:auto;background:white;border:1px solid #dce2eb;border-radius:8px;padding:clamp(18px,4vw,42px);overflow-wrap:anywhere}
article.story h1{font-size:clamp(1.9rem,4vw,3.35rem);margin-top:0}.story figure{margin-inline:0}.story table{display:block;overflow-x:auto}
.story img{border-radius:5px}.meta,time{color:#536279}.demo{color:#81560d;font-weight:700}.ad{margin:16px auto;text-align:center}.ad img{margin:auto}
.pager{display:flex;gap:20px;margin-top:25px}.share{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0 0}
footer{border-top:1px solid #dce2eb}footer .frame{padding-block:20px}.static{white-space:pre-wrap}.search input{width:min(28rem,65vw)}
@media(max-width:720px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.brand-row{gap:12px}.frame{padding-inline:16px}}
@media(max-width:470px){.grid{grid-template-columns:1fr}.featured .card:first-child{grid-column:auto}.tools{gap:8px}.editions{left:0;right:auto}}
</style>`;

export function renderPage(context: TemplateContext, title: string, main: string, head: string) {
  const { design, labels } = context;
  const font = { system: 'system-ui,sans-serif', serif: 'Georgia,serif', sans: 'Arial,sans-serif' }[
    design.font
  ];
  const branding = design.logo
    ? `<img src="${escape(design.logo)}" alt="${escape(design.name)}">`
    : escape(design.name);
  const links = (items: Website['navigation']) =>
    items.map((item) => `<a href="${escape(item.href)}">${escape(item.label)}</a>`).join('');
  const defaults = `<a href="/">${escape(labels.home)}</a><a href="/news">${escape(labels.latest)}</a>
    <a href="/interviews">${escape(labels.interviews)}</a><a href="/videos">${escape(labels.videos)}</a>
    <a href="/magazine">${escape(labels.magazine)}</a>`;
  const preferred = (item: EditionLink) => (design.popularLanguages ?? []).includes(item.code.toLowerCase());
  const editionItem = ({ url, code, name, current }: EditionLink) =>
    url
      ? `<a data-edition="${escape(code)}" href="${escape(url)}" hreflang="${escape(code)}"${current ? ' aria-current="page"' : ''}>${escape(name)}</a>`
      : `<span data-edition="${escape(code)}">${escape(name)} · ${escape(labels.unavailable)}</span>`;
  const popular = context.editions.filter(preferred);
  const languageForm = context.editions.length
    ? `<details><summary>${escape(labels.languages)}</summary><div class="editions">
       <input type="search" id="edition-search" aria-label="${escape(labels.languages)}" placeholder="${escape(labels.search)}">
       ${popular.length ? `<strong>${escape(labels.popularLanguages)}</strong>${popular.map(editionItem).join('')}` : ''}
       ${context.editions
         .filter((edition) => !preferred(edition))
         .map(editionItem)
         .join('')}</div></details>`
    : '';
  return `<!doctype html><html lang="${escape(context.code)}" dir="${/^(ar|fa|he|ur|ps|sd|yi)(-|$)/i.test(context.code) ? 'rtl' : 'ltr'}">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)}</title>${head}${style}<script src="/assets/editions.js" defer></script></head>
    <body style="--primary:${design.primary};--accent:${design.accent};font-family:${font}">
    <header class="masthead"><div class="frame"><div class="brand-row"><a class="brand" href="/">${branding}</a>
    <div class="tools">${languageForm}<form action="/search"><input type="search" name="q" aria-label="${escape(labels.search)}" placeholder="${escape(labels.search)}" required maxlength="120"><button>${escape(labels.search)}</button></form></div></div>
    <nav>${design.navigation.length ? links(design.navigation) : defaults}</nav></div></header><main class="frame">${main}</main>
    <footer><div class="frame"><strong>${escape(design.name)}</strong>${links(design.footer)}
    ${context.rss ? `<a href="/feed/">${escape(labels.feed)}</a>` : ''}</div></footer></body></html>`;
}

export const editionScript = `
const search = document.getElementById('edition-search');
if (search) search.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase();
  for (const option of search.parentElement.querySelectorAll('[data-edition]')) {
    option.hidden = !(option.textContent + ' ' + option.dataset.edition).toLocaleLowerCase().includes(query);
  }
});`;
