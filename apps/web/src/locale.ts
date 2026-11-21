const english = {
  latest: 'Latest news',
  empty: 'No articles have been published yet.',
  demo: 'Demonstration content',
  feed: 'RSS feed',
};

const translations: Record<string, typeof english> = {
  fr: {
    latest: 'Dernières actualités',
    empty: 'Aucun article publié pour le moment.',
    demo: 'Contenu de démonstration',
    feed: 'Flux RSS',
  },
  hy: {
    latest: 'Վերջին նորությունները',
    empty: 'Դեռևս հրապարակված հոդվածներ չկան։',
    demo: 'Փորձնական բովանդակություն',
    feed: 'RSS հոսք',
  },
};

export function publicLabels(locale: string) {
  return translations[locale.toLowerCase().split('-')[0]] ?? english;
}
