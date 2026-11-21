import { useEffect, useState, FormEvent } from 'react';
import {
  Activity,
  Bell,
  Bot,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  FileText,
  GitFork,
  Globe2,
  House,
  Languages,
  Layers,
  LogIn,
  Menu,
  Plus,
  Radio,
  Search,
  Settings,
  Shield,
  Tag,
  Users,
  Waypoints,
  X,
} from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { Badge, Dashboard, Panel, Table, Usage } from './dashboard';
import { dateLabel, demoLists, demoOverview, label, money, number, Overview, Row } from './data';
import './style.css';

const navigation = [
  ['dashboard', 'Dashboard', House],
  ['articles', 'Articles', FileText],
  ['jobs', 'Translation Jobs', ClipboardList],
  ['domains', 'Domains', Globe2],
  ['groups', 'Translation Groups', Waypoints],
  ['providers', 'Providers (APIs)', Bot],
  ['languages', 'Languages', Languages],
  ['memory', 'Translation Memory', Layers],
  ['taxonomy', 'Categories & Tags', Tag],
  ['redirects', 'Redirects', GitFork],
  ['seo', 'SEO & Sitemaps', Activity],
  ['rss', 'RSS Feeds', Radio],
  ['usage', 'Usage & Cost', Activity],
  ['logs', 'Webhook Logs', ClipboardList],
  ['users', 'Users & Roles', Users],
  ['settings', 'Settings', Settings],
] as const;
const subtitles: Record<string, string> = {
  dashboard: 'Central Translation & Multilingual Publishing Platform',
  articles: 'Manage source articles and localized content',
  jobs: 'Monitor translation processing and publishing',
  domains: 'Configure publishing domains and language settings',
  groups: 'Review distribution limits and provider routing',
  providers: 'View translation providers and estimated pricing',
  usage: 'Track provider usage and estimated translation costs',
  seo: 'Review sitemap and indexing settings',
  rss: 'Open localized feeds for publishing domains',
  settings: 'Manage your dashboard session',
};

type Session = { token: string; email: string; role: string };
type ArticleDetail = {
  source: { current_hash?: string; payload?: Record<string, string> };
  translations: Row[];
  jobs: Row[];
};
const columns: Record<string, [string, string][]> = {
  articles: [
    ['id', 'ID'],
    ['title', 'Title'],
    ['category', 'Category'],
    ['status', 'Status'],
    ['published_at', 'Published'],
  ],
  jobs: [
    ['id', 'Job ID'],
    ['title', 'Article'],
    ['language', 'Language'],
    ['provider', 'Provider'],
    ['state', 'Status'],
    ['created_at', 'Created'],
    ['error_code', 'Error'],
  ],
  domains: [
    ['hostname', 'Domain'],
    ['language', 'Language'],
    ['group_name', 'Group'],
    ['provider', 'Provider'],
    ['effective_limit', 'Daily limit'],
    ['enabled', 'Status'],
  ],
  groups: [
    ['name', 'Group'],
    ['domains', 'Domains'],
    ['daily_limit', 'Daily limit per domain'],
    ['provider', 'Primary provider'],
    ['fallback', 'Fallback'],
    ['enabled', 'Status'],
  ],
  providers: [
    ['name', 'Provider'],
    ['adapter', 'Model / Type'],
    ['cost_inr_per_million', 'INR / million characters'],
    ['has_stored_key', 'API key'],
    ['enabled', 'Status'],
  ],
  languages: [
    ['name', 'Language'],
    ['code', 'Locale'],
  ],
  memory: [
    ['source_language', 'Source'],
    ['target_language', 'Target'],
    ['sample', 'Translation'],
    ['created_at', 'Created'],
  ],
  taxonomy: [
    ['category', 'Source category'],
    ['articles', 'Articles'],
  ],
  redirects: [
    ['hostname', 'Domain'],
    ['old_path', 'Old path'],
    ['new_path', 'New path'],
  ],
  logs: [
    ['request_id', 'Request ID'],
    ['article_id', 'Article ID'],
    ['created_at', 'Received'],
  ],
  users: [
    ['email', 'Email'],
    ['role', 'Role'],
    ['enabled', 'Status'],
  ],
};
const jobStates = [
  'pending',
  'processing',
  'retrying',
  'review',
  'published',
  'failed',
  'cancelled',
  'skipped',
];

async function api<T>(path: string, token?: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch('/api/v1/' + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      Array.isArray(error.message)
        ? error.message.join(', ')
        : (error.message ?? `Request failed (${response.status})`),
    );
  }
  return response.json();
}

function savedSession() {
  try {
    return JSON.parse(sessionStorage.getItem('ttw-session') ?? 'null') as Session | null;
  } catch {
    return null;
  }
}

function App() {
  const [session, setSession] = useState(savedSession);
  const [demo, setDemo] = useState(import.meta.env.DEV && !savedSession());
  const [page, setPage] = useState('dashboard');
  const [menu, setMenu] = useState(false);
  const [banner, setBanner] = useState('');
  const [popover, setPopover] = useState('');
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const [login, setLogin] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [previewLists, setPreviewLists] = useState(demoLists);
  const token = session?.token;

  useEffect(() => {
    if (!token || demo) return;
    let active = true;
    const load = () =>
      api<Overview>('overview?days=' + days, token)
        .then((data) => {
          if (active) {
            setOverview(data);
            setError('');
          }
        })
        .catch((err) => {
          if (active) setError(err.message);
        });
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [token, demo, days, refresh]);

  function navigate(next: string) {
    setPage(next);
    setMenu(false);
    setPopover('');
    setBanner('');
  }
  function signOut() {
    sessionStorage.removeItem('ttw-session');
    setSession(null);
    setOverview(undefined);
    setDemo(import.meta.env.DEV);
    setLogin(false);
    navigate('dashboard');
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      const result = await api<Session>('auth/login', undefined, 'POST', Object.fromEntries(form));
      sessionStorage.setItem('ttw-session', JSON.stringify(result));
      setSession(result);
      setDemo(false);
      setLogin(false);
      navigate('dashboard');
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const data = demo ? preview(days) : overview;
  const signedIn = Boolean(session || demo);
  const title = page === 'dashboard' ? 'Admin Dashboard' : navigation.find(([id]) => id === page)?.[1];
  const notice = (message: string) => {
    setBanner(message);
    setRefresh((n) => n + 1);
  };

  return (
    <div className={`shell ${menu ? 'menu-open' : ''}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('dashboard')}>
          <i className="brand-mark" />
          <span>
            <b>TTW</b>
            <small>Translation Platform</small>
          </span>
        </button>
        {signedIn && (
          <nav aria-label="Main navigation">
            {navigation.map(([id, name, Icon]) => (
              <button
                key={id}
                onClick={() => navigate(id)}
                className={page === id ? 'selected' : ''}
                aria-current={page === id ? 'page' : undefined}
              >
                <Icon size={19} />
                <span>{name}</span>
                {id === 'domains' && data && <small>{data.domains.total}</small>}
              </button>
            ))}
          </nav>
        )}
        {data && (
          <div className="sidebar-health">
            <strong>
              <i style={{ background: Object.values(data.health).every(Boolean) ? '#56c936' : '#f49c24' }} />
              {Object.values(data.health).every(Boolean) ? 'System healthy' : 'Service degraded'}
            </strong>
            <small>
              {demo
                ? '4 providers active · 8 workers online'
                : `Translation worker ${data.health.worker ? 'online' : 'offline'}`}
            </small>
          </div>
        )}
      </aside>
      {menu && <button className="scrim" aria-label="Close navigation" onClick={() => setMenu(false)} />}
      <div className="workspace">
        <header className="top">
          <button
            className="icon-button menu-toggle"
            onClick={() => setMenu(!menu)}
            aria-label="Toggle navigation"
          >
            <Menu size={25} />
          </button>
          <div className="page-title">
            <h1>{title}</h1>
            <p>{subtitles[page]}</p>
          </div>
          {signedIn && (
            <div className="top-actions">
              {['dashboard', 'usage'].includes(page) && (
                <label className="period">
                  <CalendarDays size={18} />
                  <select
                    aria-label="Date range"
                    value={days}
                    onChange={(event) => setDays(Number(event.target.value))}
                  >
                    {[7, 30, 90].map((day) => (
                      <option key={day} value={day}>
                        Last {day} days
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </label>
              )}
              <button
                className="icon-button top-bell"
                aria-label="Notifications"
                onClick={() => setPopover(popover === 'alerts' ? '' : 'alerts')}
              >
                <Bell size={22} />
                {(demo || data?.jobs.some((item) => item.state === 'failed')) && <i />}
              </button>
              <button
                className="icon-button help"
                aria-label="Help"
                onClick={() => setPopover(popover === 'help' ? '' : 'help')}
              >
                <CircleHelp size={23} />
              </button>
              <button className="profile" onClick={() => setPopover(popover === 'profile' ? '' : 'profile')}>
                <span className="avatar">
                  <Users size={18} />
                </span>
                <span>
                  <b>{demo ? 'Admin' : session?.email.split('@')[0]}</b>
                  <small>{demo ? 'Super Admin' : label(session?.role ?? '')}</small>
                </span>
                <ChevronDown size={14} />
              </button>
            </div>
          )}
          {popover && (
            <div className="popover">
              <strong>
                {popover === 'profile' ? 'Account' : popover === 'help' ? 'Platform help' : 'Notifications'}
              </strong>
              {popover === 'profile' && (
                <button
                  className="secondary"
                  onClick={() => {
                    setPopover('');
                    if (demo) setLogin(true);
                    else signOut();
                  }}
                >
                  {demo ? 'Sign in to live platform' : 'Sign out'}
                </button>
              )}
              {popover === 'help' && (
                <p>
                  Use Articles to review the source and Jobs to monitor publishing. Domains controls localized
                  sites.
                </p>
              )}
              {popover === 'alerts' && (
                <p>
                  {data?.jobs.some((item) => item.state === 'failed')
                    ? 'Some translations failed. Review the failed jobs in Translation Jobs.'
                    : 'No failed jobs in the selected period.'}
                </p>
              )}
            </div>
          )}
        </header>
        <main className="content">
          {demo && (
            <div className="demo-notice">
              <span>
                <Shield size={14} /> Sample data preview
              </span>
              <button onClick={() => setLogin(true)}>
                Connect to live data <LogIn size={14} />
              </button>
            </div>
          )}
          {banner && (
            <div className="notice">
              {banner}
              <button className="icon-button" onClick={() => setBanner('')} aria-label="Dismiss message">
                <X size={17} />
              </button>
            </div>
          )}
          {!signedIn ? (
            <Login onSubmit={signIn} error={error} />
          ) : (
            <>
              {error && !login && (
                <p role="alert" className="notice error">
                  {error}
                </p>
              )}
              {page === 'dashboard' &&
                (data ? (
                  <Dashboard data={data} demo={demo} navigate={navigate} days={days} />
                ) : (
                  <p className="panel empty">Loading dashboard…</p>
                ))}
              {page === 'usage' && data && (
                <div className="dashboard">
                  <div className="metric-grid usage-metrics">
                    {[
                      ['Requests', number(data.usage.reduce((a, r) => a + Number(r.requests), 0))],
                      ['Characters', number(data.usage.reduce((a, r) => a + Number(r.characters), 0))],
                      ['Estimated cost', money(data.usage.reduce((a, r) => a + Number(r.cost), 0))],
                      ['Failed requests', number(data.usage.reduce((a, r) => a + Number(r.failures), 0))],
                    ].map(([name, value]) => (
                      <div className="panel report-metric" key={name}>
                        <small>{name}</small>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>
                  <Panel title="Cost by provider" icon={<Bot />}>
                    <Usage data={data.usage} />
                  </Panel>
                </div>
              )}
              {page === 'settings' && (
                <Panel title="Account" icon={<Settings />}>
                  <div className="detail-body">
                    <p>{demo ? 'Sample data preview' : session?.email}</p>
                    <button className="primary" onClick={() => (demo ? setLogin(true) : signOut())}>
                      {demo ? 'Sign in' : 'Sign out'}
                    </button>
                  </div>
                </Panel>
              )}
              {!['dashboard', 'usage', 'settings'].includes(page) && (
                <Catalog
                  key={page}
                  page={page}
                  demo={demo}
                  session={session}
                  notice={notice}
                  previewLists={previewLists}
                  savePreview={(resource, row) =>
                    setPreviewLists((all) => ({
                      ...all,
                      [resource]: savePreviewRow(all[resource] ?? [], row),
                    }))
                  }
                />
              )}
            </>
          )}
        </main>
      </div>
      {login && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-label="Sign in">
            <button
              className="dialog-close icon-button"
              onClick={() => {
                setLogin(false);
                setError('');
              }}
              aria-label="Close"
            >
              <X />
            </button>
            <Login onSubmit={signIn} error={error} />
          </div>
        </div>
      )}
    </div>
  );
}

function preview(days: number): Overview {
  if (days === 30) return demoOverview;
  const activity = days === 7 ? demoOverview.activity.slice(-7) : demoOverview.activity;
  const ratio = activity.length / 30;
  return {
    ...demoOverview,
    activity,
    articles: { total: Math.round(demoOverview.articles.total * ratio) },
    jobs: demoOverview.jobs.map((item) => ({ ...item, total: Math.round(item.total * ratio) })),
    usage: demoOverview.usage.map((row) => ({
      ...row,
      requests: Math.round(Number(row.requests) * ratio),
      characters: Math.round(Number(row.characters) * ratio),
      cost: Math.round(Number(row.cost) * ratio),
    })),
  };
}

function Login({
  onSubmit,
  error,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  error: string;
}) {
  return (
    <section className="login panel">
      <h2>Sign in to the translation platform</h2>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input type="email" name="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" name="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit">
          Sign in
        </button>
      </form>
    </section>
  );
}

function Catalog({
  page,
  demo,
  session,
  notice,
  previewLists,
  savePreview,
}: {
  page: string;
  demo: boolean;
  session: Session | null;
  notice: (message: string) => void;
  previewLists: Record<string, Row[]>;
  savePreview: (resource: string, row: Row) => void;
}) {
  const source = ['seo', 'rss'].includes(page) ? 'domains' : page;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(1);
  const [items, setItems] = useState<Row[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [domain, setDomain] = useState<Row>();
  const [addingLanguage, setAddingLanguage] = useState(false);
  const [configuration, setConfiguration] = useState<Row>();
  const [article, setArticle] = useState<Row>();
  const [tick, setTick] = useState(0);
  const canManage = demo || ['super_admin', 'admin', 'translation_manager'].includes(session?.role ?? '');
  const canEdit = canManage || session?.role === 'editor';
  useEffect(() => {
    if (demo) {
      const records = previewLists[source] ?? [];
      setItems(
        records.filter(
          (row) =>
            (!status || String(row.status ?? row.state ?? Number(Boolean(row.enabled))) === status) &&
            Object.values(row).some((value) => String(value).toLowerCase().includes(query.toLowerCase())),
        ),
      );
      setMore(false);
      return;
    }
    let active = true;
    api<{ items: Row[]; more: boolean }>(
      `catalog/${source}?` + new URLSearchParams({ q: query, status, page: String(offset) }),
      session?.token,
    )
      .then((data) => {
        if (active) {
          setItems(data.items);
          setMore(data.more);
          setError('');
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [source, demo, session, query, status, offset, tick, previewLists]);

  async function jobAction(row: Row, action: string) {
    try {
      if (demo) {
        const state = (
          { retry: 'pending', cancel: 'cancelled', approve: 'published', unpublish: 'cancelled' } as Row
        )[action];
        savePreview('jobs', { ...row, state });
      } else {
        const result = await api<{ changed: boolean }>(`jobs/${row.id}`, session?.token, 'PATCH', { action });
        if (!result.changed) throw new Error('The job is no longer eligible for this action.');
      }
      notice(demo ? 'Sample job updated for this preview.' : 'Translation job updated.');
      setTick((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  if (article)
    return (
      <Detail
        row={article}
        demo={demo}
        session={session}
        canEdit={canEdit}
        onBack={() => setArticle(undefined)}
        notice={notice}
      />
    );
  const fields =
    page === 'seo'
      ? [
          ['hostname', 'Domain'],
          ['language', 'Language'],
          ['sitemap_enabled', 'Sitemap'],
        ]
      : page === 'rss'
        ? [
            ['hostname', 'Domain'],
            ['language', 'Language'],
            ['rss_enabled', 'RSS'],
          ]
        : columns[page];
  const statuses =
    page === 'jobs'
      ? jobStates
      : page === 'articles'
        ? ['publish', 'withdrawn']
        : ['domains', 'groups', 'providers'].includes(page)
          ? ['1', '0']
          : [];
  const format = (key: string, row: Row) => {
    const value = row[key];
    if (['status', 'state'].includes(key)) return <Badge state={String(value)} />;
    if (key.endsWith('enabled')) return <Badge state={String(Boolean(value))} />;
    if (key.endsWith('_at')) return dateLabel(value);
    if (key === 'cost_inr_per_million') return money(value);
    if (key === 'has_stored_key') return row.adapter === 'deepl' ? (value ? 'Saved' : 'No key saved') : '—';
    if (key === 'role') return label(String(value));
    if (key === 'title' && page === 'articles')
      return (
        <button className="text-button" onClick={() => setArticle(row)}>
          {value}
        </button>
      );
    if (key === 'id') return '#' + value;
    return value ?? '—';
  };
  const actions = (row: Row) => {
    if (page === 'domains' && canManage)
      return (
        <button className="text-button" onClick={() => setDomain(row)}>
          Edit
        </button>
      );
    if (['groups', 'providers'].includes(page) && canManage)
      return (
        <button className="text-button" onClick={() => setConfiguration(row)}>
          Edit
        </button>
      );
    if (page === 'rss' || page === 'seo') {
      const enabled = page === 'rss' ? row.rss_enabled : row.sitemap_enabled;
      return enabled && row.enabled && !demo ? (
        <a
          className="text-button"
          href={String(row.origin) + (page === 'rss' ? '/feed/' : '/sitemap.xml')}
          target="_blank"
          rel="noreferrer"
        >
          Open XML
        </a>
      ) : (
        '—'
      );
    }
    const action = (
      {
        failed: 'retry',
        cancelled: 'retry',
        skipped: 'retry',
        pending: 'cancel',
        processing: 'cancel',
        retrying: 'cancel',
        review: 'approve',
        published: 'unpublish',
      } as Record<string, string>
    )[String(row.state)];
    return action ? (
      <button className="text-button" onClick={() => void jobAction(row, action)}>
        {label(action)}
      </button>
    ) : (
      '—'
    );
  };
  const showActions =
    (['domains', 'groups', 'providers'].includes(page) && canManage) ||
    (page === 'jobs' && canEdit) ||
    ['seo', 'rss'].includes(page);
  return (
    <section className="panel catalog">
      <div className="catalog-tools">
        <label className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(1);
            }}
            placeholder={page === 'domains' ? 'Search domains…' : 'Search…'}
            aria-label="Search records"
          />
        </label>
        {statuses.length > 0 && (
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(1);
            }}
          >
            <option value="">All statuses</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {label(value === '1' ? 'true' : value === '0' ? 'false' : value)}
              </option>
            ))}
          </select>
        )}
        {page === 'domains' && canManage && (
          <button className="primary add" onClick={() => setDomain({})}>
            <Plus size={16} />
            Add domain
          </button>
        )}
        {page === 'groups' && canManage && (
          <button className="primary add" onClick={() => setConfiguration({})}>
            <Plus size={16} />
            Add group
          </button>
        )}
        {page === 'languages' && canManage && (
          <button className="primary add" onClick={() => setAddingLanguage(true)}>
            <Plus size={16} />
            Add language
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <Table
        headings={[...fields.map(([, heading]) => heading), ...(showActions ? ['Actions'] : [])]}
        rows={items.map((row) => [
          ...fields.map(([key]) => format(key, row)),
          ...(showActions ? [actions(row)] : []),
        ])}
      />
      {(more || offset > 1) && (
        <div className="pagination">
          <button className="secondary" disabled={offset === 1} onClick={() => setOffset((n) => n - 1)}>
            Previous
          </button>
          <span>Page {offset}</span>
          <button className="secondary" disabled={!more} onClick={() => setOffset((n) => n + 1)}>
            Next
          </button>
        </div>
      )}
      {domain && (
        <DomainForm
          row={domain}
          demo={demo}
          previewLists={previewLists}
          token={session?.token}
          onClose={() => setDomain(undefined)}
          onSave={(record) => {
            if (demo) savePreview('domains', record);
            setDomain(undefined);
            setTick((n) => n + 1);
            notice(demo ? 'Domain updated in this preview.' : 'Domain configuration saved.');
          }}
        />
      )}
      {addingLanguage && (
        <LanguageForm
          demo={demo}
          token={session?.token}
          onClose={() => setAddingLanguage(false)}
          onSave={(record) => {
            if (demo) savePreview('languages', record);
            setAddingLanguage(false);
            setQuery('');
            setOffset(1);
            setTick((n) => n + 1);
            notice('Language added. You can now select it when adding a domain.');
          }}
        />
      )}
      {configuration && (
        <ConfigurationForm
          row={configuration}
          kind={page === 'groups' ? 'groups' : 'providers'}
          demo={demo}
          allowCredential={['super_admin', 'admin'].includes(session?.role ?? '')}
          token={session?.token}
          onClose={() => setConfiguration(undefined)}
          onSave={(record) => {
            if (demo) savePreview(source, record);
            setConfiguration(undefined);
            setTick((n) => n + 1);
            notice(demo ? 'Configuration updated in this preview.' : 'Configuration saved.');
          }}
        />
      )}
    </section>
  );
}

function savePreviewRow(all: Row[], record: Row) {
  if (record.id) return all.map((item) => (item.id === record.id ? record : item));
  return [...all, { ...record, id: Math.max(0, ...all.map((row) => Number(row.id))) + 1 }];
}

function LanguageForm({
  demo,
  token,
  onClose,
  onSave,
}: {
  demo: boolean;
  token?: string;
  onClose: () => void;
  onSave: (record: Row) => void;
}) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSaving(true);
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name')).trim();
    try {
      const code = Intl.getCanonicalLocales(String(values.get('code')).trim())[0];
      if (!demo) await api('languages', token, 'POST', { name, code });
      onSave({ name, code });
    } catch (error) {
      setError(
        error instanceof RangeError
          ? 'Enter a language code such as fr-FR or zh-Hans.'
          : (error as Error).message,
      );
      setSaving(false);
    }
  }

  return (
    <div className="overlay">
      <section className="dialog panel" role="dialog" aria-labelledby="language-title">
        <header className="panel-heading">
          <Languages />
          <h2 id="language-title">Add language</h2>
          <button className="dialog-close icon-button" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </header>
        <form className="domain-form" onSubmit={save}>
          <label>
            Language name
            <input name="name" placeholder="Chinese (Simplified)" maxLength={80} required />
          </label>
          <label>
            Locale
            <input name="code" placeholder="zh-Hans" maxLength={16} required />
          </label>
          {error && (
            <p className="form-error wide" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions wide">
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={saving}>
              Add language
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ConfigurationForm({
  row,
  kind,
  demo,
  allowCredential,
  token,
  onClose,
  onSave,
}: {
  row: Row;
  kind: 'groups' | 'providers';
  demo: boolean;
  allowCredential: boolean;
  token?: string;
  onClose: () => void;
  onSave: (value: Row) => void;
}) {
  const isGroup = kind === 'groups';
  const canSaveKey = !isGroup && row.adapter === 'deepl' && allowCredential;
  const [providers, setProviders] = useState<Row[]>(demo ? demoLists.providers : []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!isGroup || demo) return;
    api<{ items: Row[] }>('catalog/providers', token)
      .then((result) => setProviders(result.items))
      .catch((err) => setError(err.message));
  }, [demo, isGroup, token]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSaving(true);
    const form = new FormData(event.currentTarget);
    const enabled = form.has('enabled');
    const value: Row = isGroup
      ? {
          name: String(form.get('name')).trim(),
          description: String(form.get('description')),
          daily_limit: Number(form.get('daily_limit')),
          priority: Number(form.get('priority')),
          enabled,
          provider_id: Number(form.get('provider_id')),
          fallback_provider_id: Number(form.get('fallback_provider_id')) || null,
        }
      : { enabled, cost_inr_per_million: Number(form.get('cost_inr_per_million')) };
    try {
      if ('provider_id' in value && value.provider_id === value.fallback_provider_id)
        throw new Error('Choose a different fallback provider.');
      const apiKey = canSaveKey ? String(form.get('api_key') ?? '').trim() : '';
      if (!demo) {
        await api(row.id ? `${kind}/${row.id}` : kind, token, row.id ? 'PATCH' : 'POST', {
          ...value,
          ...(apiKey ? { api_key: apiKey } : {}),
        });
      }
      const names: Row = isGroup
        ? {
            provider: providers.find((item) => item.id === value.provider_id)?.name ?? '',
            fallback: providers.find((item) => item.id === value.fallback_provider_id)?.name ?? null,
            domains: row.domains ?? 0,
          }
        : {};
      onSave({ ...row, ...value, ...names, enabled: enabled ? 1 : 0 });
    } catch (err) {
      setSaving(false);
      setError((err as Error).message);
    }
  }
  const options = providers.map((provider) => (
    <option key={String(provider.id)} value={String(provider.id)}>
      {provider.name}
    </option>
  ));
  return (
    <div className="overlay">
      <section className="panel dialog" role="dialog" aria-labelledby="config-title">
        <header className="panel-heading">
          {isGroup ? <Waypoints /> : <Bot />}
          <h2 id="config-title">{isGroup ? (row.id ? 'Edit group' : 'Add group') : `Edit ${row.name}`}</h2>
          <button className="dialog-close icon-button" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </header>
        <form className="domain-form" onSubmit={save}>
          {isGroup ? (
            <>
              <label>
                Group name
                <input name="name" defaultValue={String(row.name ?? '')} maxLength={100} required />
              </label>
              <label>
                Description
                <input name="description" defaultValue={String(row.description ?? '')} maxLength={500} />
              </label>
              <label>
                Daily limit per domain
                <input
                  name="daily_limit"
                  type="number"
                  min="0"
                  max="10000"
                  defaultValue={String(row.daily_limit ?? 100)}
                  required
                />
              </label>
              <label>
                Queue priority
                <input
                  name="priority"
                  type="number"
                  min="1"
                  max="32767"
                  defaultValue={String(row.priority ?? 10)}
                  required
                />
              </label>
              <label>
                Primary provider
                <select
                  key={providers.length}
                  name="provider_id"
                  defaultValue={String(
                    row.provider_id ?? providers.find((item) => item.name === row.provider)?.id ?? '',
                  )}
                  required
                >
                  <option value="">Select a provider</option>
                  {options}
                </select>
              </label>
              <label>
                Fallback provider
                <select
                  key={providers.length}
                  name="fallback_provider_id"
                  defaultValue={String(
                    row.fallback_provider_id ??
                      providers.find((item) => item.name === row.fallback)?.id ??
                      '',
                  )}
                >
                  <option value="">None</option>
                  {options}
                </select>
              </label>
            </>
          ) : (
            <label className="wide">
              Estimated INR / million characters
              <input
                name="cost_inr_per_million"
                type="number"
                min="0"
                step=".0001"
                max="9999999"
                required
                defaultValue={String(row.cost_inr_per_million ?? 0)}
              />
            </label>
          )}
          <label className="check wide">
            <input type="checkbox" name="enabled" defaultChecked={Boolean(row.enabled ?? true)} />
            Enabled
          </label>
          {canSaveKey && (
            <label className="wide">
              DeepL API key
              <input
                name="api_key"
                type="password"
                autoComplete="new-password"
                maxLength={512}
                placeholder={
                  row.has_stored_key ? 'Enter a new key to replace the saved key' : 'Paste your DeepL API key'
                }
              />
            </label>
          )}
          {error && (
            <p className="form-error wide" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions wide">
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={saving}>
              Save changes
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DomainForm({
  row,
  demo,
  previewLists,
  token,
  onClose,
  onSave,
}: {
  row: Row;
  demo: boolean;
  previewLists: Record<string, Row[]>;
  token?: string;
  onClose: () => void;
  onSave: (value: Row) => void;
}) {
  const [languages, setLanguages] = useState<Row[]>(demo ? previewLists.languages : []);
  const [groups, setGroups] = useState<Row[]>(demo ? previewLists.groups : []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (demo) return;
    api<{ languages: Row[]; groups: Row[] }>('domain-options', token)
      .then((data) => {
        setLanguages(data.languages);
        setGroups(data.groups);
      })
      .catch((err) => setError(err.message));
  }, [demo, token]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const num = (name: string) => Number(form.get(name));
    const value = {
      hostname: String(form.get('hostname')).trim(),
      origin: String(form.get('origin')).trim(),
      language_id: num('language_id'),
      group_id: num('group_id'),
      daily_limit: form.get('daily_limit') === '' ? null : num('daily_limit'),
      timezone: String(form.get('timezone')),
      enabled: form.has('enabled'),
      sitemap_enabled: form.has('sitemap_enabled'),
      rss_enabled: form.has('rss_enabled'),
      manual_approval: form.has('manual_approval'),
    };
    try {
      if (!demo) await api(row.id ? `domains/${row.id}` : 'domains', token, row.id ? 'PATCH' : 'POST', value);
      const language = languages.find((item) => item.id === value.language_id);
      const group = groups.find((item) => item.id === value.group_id);
      onSave({
        ...row,
        ...value,
        language: language?.name ?? '',
        group_name: group?.name ?? '',
        provider: group?.provider ?? '',
        effective_limit: value.daily_limit ?? group?.daily_limit ?? 0,
      });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <div className="overlay">
      <section className="panel dialog domain-dialog" role="dialog" aria-labelledby="domain-title">
        <header className="panel-heading">
          <Globe2 />
          <h2 id="domain-title">{row.id ? 'Edit domain' : 'Add domain'}</h2>
          <button className="dialog-close icon-button" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </header>
        <form onSubmit={save} className="domain-form">
          <label>
            Hostname
            <input
              name="hostname"
              placeholder="fr.example.com"
              defaultValue={String(row.hostname ?? '')}
              required
            />
          </label>
          <label>
            Public origin
            <input
              name="origin"
              type="url"
              placeholder="https://fr.example.com"
              defaultValue={String(row.origin ?? '')}
              required
            />
          </label>
          <label>
            Language
            <select
              key={languages.length}
              name="language_id"
              defaultValue={String(row.language_id ?? '')}
              required
            >
              <option value="">Select language</option>
              {languages.map((item) => (
                <option key={String(item.id)} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Group
            <select key={groups.length} name="group_id" defaultValue={String(row.group_id ?? '')} required>
              <option value="">Select group</option>
              {groups.map((item) => (
                <option key={String(item.id)} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Daily article limit
            <input
              name="daily_limit"
              type="number"
              min="0"
              max="10000"
              placeholder="Use group limit"
              defaultValue={String(row.daily_limit ?? '')}
            />
          </label>
          <label>
            Timezone
            <input name="timezone" defaultValue={String(row.timezone ?? 'UTC')} required />
          </label>
          {(
            [
              ['enabled', 'Enabled', true],
              ['sitemap_enabled', 'Generate sitemap', true],
              ['rss_enabled', 'Enable RSS feed', true],
              ['manual_approval', 'Require manual approval', false],
            ] as const
          ).map(([key, name, fallback]) => (
            <label className="check" key={key}>
              <input type="checkbox" name={key} defaultChecked={Boolean(row[key] ?? fallback)} />
              {name}
            </label>
          ))}
          {error && (
            <p role="alert" className="form-error wide">
              {error}
            </p>
          )}
          <div className="form-actions wide">
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={saving}>
              Save changes
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Detail({
  row,
  demo,
  session,
  canEdit,
  onBack,
  notice,
}: {
  row: Row;
  demo: boolean;
  session: Session | null;
  canEdit: boolean;
  onBack: () => void;
  notice: (message: string) => void;
}) {
  const [tab, setTab] = useState('Overview');
  const [detail, setDetail] = useState<ArticleDetail>();
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (demo) {
      const translations = demoLists.domains.map((domain) => ({
        ...domain,
        state: 'published',
        updated_at: row.published_at,
      }));
      setDetail({
        source: {
          ...row,
          payload: {
            author: 'TTW Desk',
            seoTitle: String(row.title),
            seoDescription: 'Travel industry news from Travel and Tour World.',
          },
        },
        translations,
        jobs: demoLists.jobs.filter((job) => job.id === row.id),
      });
    } else {
      let active = true;
      api<ArticleDetail>('articles/' + row.id, session?.token)
        .then((result) => {
          if (active) setDetail(result);
        })
        .catch((err) => {
          if (active) setError(err.message);
        });
      return () => {
        active = false;
      };
    }
  }, [row, demo, session]);
  async function translate() {
    setWorking(true);
    setError('');
    try {
      const result = demo
        ? { created: 0 }
        : await api<{ created: number }>('articles/' + row.id + '/translate', session?.token, 'POST', {});
      notice(
        demo
          ? 'Sample translations are already available.'
          : `${result.created} new translation jobs allocated.`,
      );
      if (!demo) setDetail(await api<ArticleDetail>('articles/' + row.id, session?.token));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="panel detail">
      <header className="panel-heading">
        <FileText />
        <h2>{row.title}</h2>
        <div className="panel-action">
          <button className="secondary" onClick={onBack}>
            Back to articles
          </button>
        </div>
      </header>
      <div className="detail-body">
        <div className="detail-meta">
          <span>Source #{row.source_post_id}</span>
          <Badge state={String(row.status)} />
        </div>
        <div className="tabs">
          {['Overview', 'Translations', 'SEO', 'Jobs & Logs'].map((name) => (
            <button key={name} onClick={() => setTab(name)} className={tab === name ? 'current' : ''}>
              {name}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {!detail ? (
          <p>Loading article…</p>
        ) : tab === 'Overview' ? (
          <div className="article-summary">
            <dl>
              {[
                ['Category', row.category],
                ['Author', detail.source.payload?.author],
                ['Published', dateLabel(row.published_at)],
                ['Modified', dateLabel(row.modified_at)],
                ['Content hash', detail.source.current_hash],
              ].map(([name, value]) => (
                <div key={String(name)}>
                  <dt>{name}</dt>
                  <dd>{value || '—'}</dd>
                </div>
              ))}
            </dl>
            {canEdit && (
              <button className="primary" onClick={() => void translate()} disabled={working}>
                Translate now
              </button>
            )}
          </div>
        ) : tab === 'Translations' ? (
          <Table
            headings={['Language', 'Domain', 'Status', 'Updated', 'Page']}
            rows={detail.translations.map((item) => [
              item.language,
              item.hostname,
              <Badge state={String(item.state)} />,
              dateLabel(item.updated_at),
              !demo && item.state === 'published' ? (
                <a
                  className="text-button"
                  href={String(item.origin) + '/article/' + encodeURIComponent(String(item.slug))}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </a>
              ) : (
                '—'
              ),
            ])}
          />
        ) : tab === 'SEO' ? (
          <div className="article-summary">
            <dl>
              {[
                ['SEO title', detail.source.payload?.seoTitle],
                ['Description', detail.source.payload?.seoDescription],
                ['Source canonical', detail.source.payload?.canonical],
              ].map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value || '—'}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <Table
            headings={['Job', 'Domain', 'Provider', 'State', 'Error']}
            rows={detail.jobs.map((item) => [
              item.id,
              item.hostname,
              item.provider,
              <Badge state={String(item.state)} />,
              item.error_code ?? '—',
            ])}
          />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
