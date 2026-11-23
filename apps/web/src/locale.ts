import { englishLabels, type Labels } from '../../../packages/shared/src/website';

const translations: Record<string, Partial<Labels>> = {
  fr: {
    home: 'Accueil',
    featured: 'À la une',
    categories: 'Catégories',
    interviews: 'Entretiens',
    videos: 'Vidéos',
    magazine: 'Magazine',
    search: 'Rechercher',
    languages: 'Langues',
    share: 'Partager',
    related: 'Articles associés',
    next: 'Suivant',
    previous: 'Précédent',
    notFound: 'Page introuvable',
    advertisement: 'Publicité',
    popularLanguages: 'Langues populaires',
    unavailable: 'Traduction indisponible',
    latest: 'Dernières actualités',
    empty: 'Aucun article publié pour le moment.',
    demo: 'Contenu de démonstration',
    feed: 'Flux RSS',
  },
  hy: {
    home: 'Գլխավոր',
    featured: 'Գլխավոր նորություններ',
    categories: 'Բաժիններ',
    interviews: 'Հարցազրույցներ',
    videos: 'Տեսանյութեր',
    magazine: 'Ամսագիր',
    search: 'Որոնում',
    languages: 'Լեզուներ',
    share: 'Կիսվել',
    related: 'Առնչվող նորություններ',
    next: 'Հաջորդ',
    previous: 'Նախորդ',
    notFound: 'Էջը չի գտնվել',
    advertisement: 'Գովազդ',
    popularLanguages: 'Հանրաճանաչ լեզուներ',
    unavailable: 'Թարգմանությունը հասանելի չէ',
    latest: 'Վերջին նորությունները',
    empty: 'Դեռևս հրապարակված հոդվածներ չկան։',
    demo: 'Փորձնական բովանդակություն',
    feed: 'RSS հոսք',
  },
};

export function publicLabels(locale: string, stored?: Partial<Labels>) {
  return { ...englishLabels, ...translations[locale.toLowerCase().split('-')[0]], ...stored };
}
