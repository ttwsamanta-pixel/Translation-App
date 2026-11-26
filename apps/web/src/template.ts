import { defaultWebsite, type Labels, type Website } from '../../../packages/shared/src/website';
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
type PageLayout = { kind?: 'home' | 'article' | 'archive' | 'page'; path?: string };

const assets = '/assets/ttw';
const sourceSite = 'https://www.travelandtourworld.com';
export const categoryPath = (name: string) => '/category/' + encodeURIComponent(name);
export const authorPath = (name: string) => '/author/' + encodeURIComponent(name);
export const tagPath = (name: string) => '/tag/' + encodeURIComponent(name);
export const categoryLabel = (site: TemplateContext, name: string) =>
  site.categoryLabels && Object.hasOwn(site.categoryLabels, name) ? site.categoryLabels[name] : name;

export function adSlot(context: TemplateContext, slot: Website['ads'][number]['slot']) {
  const ad = context.design.ads.find((item) => item.slot === slot);
  return ad
    ? `<aside class="ad" aria-label="${escape(context.labels.advertisement)}"><a href="${escape(ad.url)}" rel="sponsored"><img src="${escape(ad.image)}" alt="${escape(ad.label)}" loading="lazy"></a></aside>`
    : '';
}

function editionMenu({ editions, design, labels }: TemplateContext) {
  if (!editions.length) return '';
  const preferred = (item: EditionLink) => (design.popularLanguages ?? []).includes(item.code.toLowerCase());
  const editionItem = ({ url, code, name, current }: EditionLink) =>
    url
      ? `<a data-edition="${escape(code)}" href="${escape(url)}" hreflang="${escape(code)}"${current ? ' aria-current="page"' : ''}>${escape(name)}</a>`
      : `<span data-edition="${escape(code)}">${escape(name)} · ${escape(labels.unavailable)}</span>`;
  const popular = editions.filter(preferred);
  return `<details class="ttw-disclosure"><summary class="ttw-icon" aria-label="${escape(labels.languages)}">⌄</summary>
    <div class="ttw-panel editions"><label for="edition-search">${escape(labels.languages)}</label>
    <input type="search" id="edition-search" placeholder="${escape(labels.search)}">
    ${popular.length ? `<strong>${escape(labels.popularLanguages)}</strong>${popular.map(editionItem).join('')}` : ''}
    ${editions
      .filter((edition) => !preferred(edition))
      .map(editionItem)
      .join('')}</div></details>`;
}

function pageLink(design: Website, slug: string) {
  return design.pages.some((page) => page.slug === slug) ? '/' + slug : sourceSite + '/' + slug + '/';
}

function navigation({ design, labels }: TemplateContext) {
  if (design.navigation.length) return design.navigation;
  return [
    { label: labels.home, href: '/' },
    { label: labels.news, href: '/news' },
    { label: labels.interviews, href: '/interviews' },
    { label: labels.videos, href: '/videos' },
    ...(
      [
        [labels.shows, 'shows'],
        [labels.clients, 'clients'],
        [labels.about, 'about-us'],
        [labels.team, 'our-team'],
        [labels.contact, 'contact-us'],
      ] as const
    ).map(([label, slug]) => ({ label, href: pageLink(design, slug) })),
  ];
}

function header(site: TemplateContext, path?: string) {
  const { design, labels } = site;
  const menu = `<ul class="primary-nav__list">${navigation(site)
    .map(
      ({ href, label }) =>
        `<li class="menu-item"><a href="${escape(href)}"${href === path ? ' aria-current="page"' : ''}>${escape(label)}</a></li>`,
    )
    .join('')}</ul>`;
  return `<a class="skip-link" href="#primary-content">${escape(labels.skip)}</a>
    <header class="header-main" id="header-main"><div class="container header-main__inner">
      <div class="header-brand"><div class="site-logo"><a class="site-logo__link" href="/" rel="home">
        <img class="site-logo__img" src="${escape(design.logo ?? assets + '/uploads/TTW-Logo.svg')}" alt="${escape(design.name)}" width="783" height="310">
      </a></div>${editionMenu(site)}</div>
      <nav class="primary-nav" aria-label="${escape(labels.menu)}">${menu}</nav>
      <div class="header-actions ttw-actions">
        <button class="ttw-icon ttw-theme-switch" type="button" aria-label="${escape(labels.darkMode)}" aria-pressed="false">☼</button>
        <details class="ttw-disclosure ttw-search"><summary class="ttw-icon" aria-label="${escape(labels.search)}"><svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 5 5" stroke="currentColor" stroke-width="2"/></svg></summary>
          <form class="ttw-panel header-search" action="/search" role="search"><label class="screen-reader-text" for="header-search-input">${escape(labels.search)}</label>
          <input id="header-search-input" class="header-search__input" type="search" name="q" placeholder="${escape(labels.search)}" maxlength="120" required><button class="ttw-action">${escape(labels.search)}</button></form>
        </details>
        ${design.pages.some((page) => page.slug === 'subscribe') ? `<a class="btn btn-download-app ttw-subscribe" href="/subscribe">${escape(labels.subscribe)}</a>` : ''}
        <details class="ttw-disclosure ttw-mobile-nav"><summary class="ttw-icon" aria-label="${escape(labels.menu)}">☰</summary><nav class="ttw-panel" aria-label="${escape(labels.menu)}">${menu}</nav></details>
      </div>
    </div></header>`;
}

function footer(site: TemplateContext) {
  const { design, labels } = site;
  const footerLinks = design.footer.length
    ? design.footer
    : [
        { label: labels.about, href: pageLink(design, 'about-us') },
        { label: labels.contact, href: pageLink(design, 'contact-us') },
        { label: labels.magazine, href: '/magazine' },
      ];
  const link = ({ href, label }: { href: string; label: string }) =>
    `<li><a href="${escape(href)}">${escape(label)}</a></li>`;
  return `<footer class="site-footer"><div class="container site-footer__grid">
    <div class="footer-col footer-col--brand"><a class="footer-logo-badge" href="/"><img
      src="${escape(design.logo ?? assets + '/uploads/TTW-Logo.svg')}" alt="${escape(design.name)}" width="783" height="310" loading="lazy"></a></div>
    <nav class="footer-col footer-col--links" aria-label="${escape(labels.usefulLinks)}"><h2 class="footer-col__title">${escape(labels.usefulLinks)}</h2>
    <ul class="footer-links">${footerLinks.map(link).join('')}${site.rss ? link({ href: '/feed/', label: labels.feed }) : ''}</ul></nav>
    <nav class="footer-col" aria-label="${escape(labels.news)}"><h2 class="footer-col__title">${escape(labels.news)}</h2>
    <ul class="footer-links">${[
      { href: '/news', label: labels.latest },
      { href: '/categories', label: labels.categories },
      { href: '/interviews', label: labels.interviews },
      { href: '/videos', label: labels.videos },
    ]
      .map(link)
      .join('')}</ul></nav>
    <div class="footer-col footer-col--social"><h2 class="footer-col__title">${escape(labels.followUs)}</h2>
    <ul class="footer-links">${[
      { href: 'https://www.linkedin.com/company/travel-and-tour-world', label: 'LinkedIn' },
      { href: 'https://www.facebook.com/ttwemagazine', label: 'Facebook' },
      { href: 'https://www.instagram.com/travelandtourworld', label: 'Instagram' },
      { href: 'https://www.youtube.com/user/TravelAndTourWorld', label: 'YouTube' },
    ]
      .map(link)
      .join('')}</ul></div></div>
    <div class="site-footer__bottom"><div class="container site-footer__bottom-inner">© ${new Date().getUTCFullYear()} ${escape(design.name)}</div></div></footer>`;
}

export function renderPage(
  site: TemplateContext,
  title: string,
  main: string,
  head: string,
  layout: PageLayout = {},
) {
  const { design } = site;
  const routeStyle = { home: 'home', article: 'single', archive: 'category', page: 'page' }[
    layout.kind ?? 'page'
  ];
  const theme = ['fonts', 'header', 'typography', 'footer', routeStyle]
    .map((file) => `<link rel="stylesheet" href="${assets}/assets/css/${file}.css">`)
    .join('');
  const font = { system: '', serif: 'Georgia,serif', sans: 'Arial,sans-serif' }[design.font];
  const custom = [
    design.primary !== defaultWebsite.primary && `--ttw-blue:${design.primary}`,
    design.accent !== defaultWebsite.accent && `--ttw-red:${design.accent}`,
    font && `font-family:${font}`,
  ]
    .filter(Boolean)
    .join(';');
  return `<!doctype html><html lang="${escape(site.code)}" dir="${/^(ar|fa|he|ur|ps|sd|yi)(-|$)/i.test(site.code) ? 'rtl' : 'ltr'}">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)}</title>${head}${theme}<link rel="stylesheet" href="${assets}/edition.css"><script src="/assets/editions.js" defer></script></head>
    <body class="ttw-edition ttw-edition--${layout.kind ?? 'page'}"${custom ? ` style="${custom}"` : ''}>
    ${header(site, layout.path)}<main id="primary-content" class="site-main"><div class="container ttw-content">${main}</div></main>
    ${footer(site)}</body></html>`;
}

export const editionScript = `
const search = document.getElementById('edition-search');
if (search) search.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase();
  for (const option of search.parentElement.querySelectorAll('[data-edition]')) {
    option.hidden = !(option.textContent + ' ' + option.dataset.edition).toLocaleLowerCase().includes(query);
  }
});
const themeSwitch = document.querySelector('.ttw-theme-switch');
if (themeSwitch) {
  const setTheme = (dark) => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    themeSwitch.setAttribute('aria-pressed', String(dark));
    themeSwitch.textContent = dark ? '☾' : '☼';
  };
  try { setTheme(localStorage.getItem('ttw-theme') === 'dark'); } catch {}
  themeSwitch.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    setTheme(dark);
    try { localStorage.setItem('ttw-theme', dark ? 'dark' : 'light'); } catch {}
  });
}
for (const carousel of document.querySelectorAll('[data-ttw-carousel]')) {
  const slides = [...carousel.querySelectorAll('.news-carousel__slide')];
  let index = 0;
  carousel.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => {
    slides[index].classList.remove('is-active');
    slides[index].hidden = true;
    index = (index + Number(button.dataset.step) + slides.length) % slides.length;
    slides[index].hidden = false;
    slides[index].classList.add('is-active');
  }));
}`;
