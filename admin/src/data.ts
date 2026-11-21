export type Row = Record<string, string | number | boolean | null>;
export type Overview = {
  articles: { total: number };
  domains: { total: number };
  jobs: { state: string; total: number }[];
  usage: Row[];
  groups: Row[];
  recent: Row[];
  activity: { day: string; articles: number; jobs: number }[];
  health: { api: boolean; mysql: boolean; redis: boolean; worker: boolean };
};

const names = [
  'Global Tourism Surge in Europe',
  'New Air Route to Asia Launched',
  'Travel Trends for 2025',
  'Hotels Report Record Bookings',
  'Sustainable Tourism Initiatives',
];
const categories = ['Tourism', 'Aviation', 'Travel', 'Hotels', 'Sustainability'];
const providers = ['DeepL', 'Google Cloud', 'Gemini', 'Gemini', 'Google Cloud'];
const languages = ['French', 'German', 'Spanish', 'Italian', 'Portuguese'];
const hostnames = ['ttw.fr', 'ttw.de', 'ttw.es', 'ttw.it', 'ttw.pt'];
const date = '2025-03-29T10:24:00Z';
const amount = [
  3100, 3150, 2880, 2940, 3230, 3320, 3420, 3750, 3890, 3510, 3460, 3680, 3370, 3390, 3210, 3490, 3750, 3910,
  3590, 3410, 3310, 3560, 3740, 4010, 3690, 3910, 3990, 3900, 4100, 3750,
];
const jobs = names.map((title, i) => ({
  id: 134250 - i,
  title,
  hostname: hostnames[i],
  language: languages[i],
  provider: providers[i],
  state: ['published', 'published', 'published', 'processing', 'pending'][i],
  created_at: date,
}));
const groups = [
  {
    id: 1,
    name: 'Premium Group',
    domains: 15,
    daily_limit: 100,
    provider: 'DeepL',
    fallback: 'Google Cloud',
    enabled: 1,
  },
  {
    id: 2,
    name: 'Standard Group',
    domains: 30,
    daily_limit: 50,
    provider: 'Google Cloud',
    fallback: 'Gemini',
    enabled: 1,
  },
  {
    id: 3,
    name: 'Economy Group',
    domains: 59,
    daily_limit: 25,
    provider: 'Gemini',
    fallback: 'OpenAI',
    enabled: 1,
  },
];
const costs = [
  {
    name: 'Gemini',
    adapter: '2.5 Flash-Lite',
    requests: 104230,
    characters: 412800000,
    cost: 14820,
    failures: 492,
    fallbacks: 120,
  },
  {
    name: 'Google Cloud',
    adapter: 'Translation (NMT)',
    requests: 18760,
    characters: 95300000,
    cost: 8925,
    failures: 122,
    fallbacks: 75,
  },
  {
    name: 'DeepL',
    adapter: 'API Pro',
    requests: 6940,
    characters: 32100000,
    cost: 6550,
    failures: 52,
    fallbacks: 28,
  },
  {
    name: 'OpenAI',
    adapter: 'GPT-5 mini',
    requests: 4320,
    characters: 18700000,
    cost: 2155,
    failures: 144,
    fallbacks: 60,
  },
];
const domains = hostnames.map((hostname, i) => ({
  id: i + 1,
  hostname,
  origin: 'https://' + hostname,
  language: languages[i],
  language_id: i + 1,
  code: ['fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-PT'][i],
  group_name: i < 2 ? 'Premium Group' : 'Standard Group',
  group_id: i < 2 ? 1 : 2,
  provider: providers[i],
  effective_limit: i < 2 ? 100 : 50,
  daily_limit: i < 2 ? 100 : 50,
  timezone: 'Europe/Paris',
  enabled: 1,
  sitemap_enabled: 1,
  rss_enabled: 1,
  manual_approval: 0,
}));
export const demoLists: Record<string, Row[]> = {
  articles: names.map((title, i) => ({
    id: 134250 - i,
    source_post_id: 72591 - i,
    title,
    category: categories[i],
    status: i % 2 ? 'processing' : 'publish',
    published_at: date,
  })),
  jobs,
  domains,
  groups,
  providers: [
    ...costs.map((p, i) => ({
      ...p,
      id: i + 1,
      enabled: 1,
      cost_inr_per_million: [120, 1700, 2100, 1950][i],
    })),
    { id: 5, name: 'Azure', adapter: 'Translator', enabled: 0, cost_inr_per_million: 1600 },
  ],
  languages: domains.map((d) => ({ id: d.language_id, name: d.language, code: d.code })),
  taxonomy: categories.map((category) => ({ category, articles: 1 })),
  memory: [
    {
      source_language: 'en',
      target_language: 'fr-FR',
      sample: 'Les dernières actualités du tourisme',
      created_at: date,
    },
  ],
  redirects: [
    { hostname: 'ttw.fr', old_path: '/tourism/europe', new_path: '/article/tourisme-en-europe-134250' },
  ],
  logs: [{ request_id: 'wp-article-72591-march-29', article_id: 134250, created_at: date }],
  users: [{ id: 1, email: 'admin@example.test', role: 'super_admin', enabled: 1 }],
};

export const demoOverview: Overview = {
  articles: { total: 8250 },
  domains: { total: 104 },
  jobs: [
    { state: 'published', total: 129950 },
    { state: 'processing', total: 1880 },
    { state: 'pending', total: 1210 },
    { state: 'failed', total: 810 },
    { state: 'skipped', total: 400 },
  ],
  usage: costs,
  groups,
  recent: jobs.slice(0, 4),
  activity: amount.map((value, i) => ({
    day: `2025-03-${String(i + 1).padStart(2, '0')}`,
    articles: 405 + (i * 8 + (i % 5) * 24),
    jobs: value,
  })),
  health: { api: true, mysql: true, redis: true, worker: true },
};
export const number = (value: unknown) => Number(value ?? 0).toLocaleString('en-US');
export const money = (value: unknown) =>
  '₹' + Number(value ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const dateLabel = (value: unknown) =>
  typeof value === 'string' && value
    ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
export const label = (value: string) =>
  ({
    publish: 'Published',
    published: 'Published',
    pending: 'Queued',
    review: 'Awaiting approval',
    true: 'Active',
    false: 'Disabled',
  })[value] ?? value.slice(0, 1).toUpperCase() + value.slice(1).replaceAll('_', ' ');
