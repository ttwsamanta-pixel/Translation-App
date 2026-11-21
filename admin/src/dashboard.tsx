import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  ClipboardList,
  Crown,
  FileText,
  Globe2,
  Layers,
  Leaf,
  Languages,
  Server,
  Wallet,
} from 'lucide-react';
import { ReactNode } from 'react';
import { dateLabel, label, money, number, Overview, Row } from './data';

export function Panel({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-heading">
        {icon}
        <h2>{title}</h2>
        {action && <div className="panel-action">{action}</div>}
      </header>
      {children}
    </section>
  );
}

export function Badge({ state }: { state: string }) {
  return (
    <span className={`badge badge-${state}`}>
      <span />
      {label(state)}
    </span>
  );
}

export function Table({ headings, rows }: { headings: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th key={heading}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, cell) => (
                <td key={cell}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty">No records to display.</p>}
    </div>
  );
}

const states = [
  ['published', 'Published', '#1ead50'],
  ['processing', 'Processing', '#1683f8'],
  ['pending', 'Queued', '#ff970c'],
  ['failed', 'Failed', '#f04450'],
  ['skipped', 'Skipped', '#9745ed'],
];
const shades = ['#7651fa', '#ff970c', '#ffcb43', '#0088f7'];
const initials = ['✦', '☁', '◆', '◎'];

function Chart({ points }: { points: Overview['activity'] }) {
  const max = Math.max(5, ...points.flatMap((point) => [Number(point.jobs), Number(point.articles)]));
  const step = 10 ** Math.floor(Math.log10(max / 5));
  const ceiling = Math.ceil(max / (5 * step)) * 5 * step;
  const ticks = Array.from({ length: 6 }, (_, i) => Math.round((ceiling * (5 - i)) / 5));
  const coords = (field: 'jobs' | 'articles') =>
    points.map((point, i) => [
      54 + (i * 640) / Math.max(1, points.length - 1),
      150 - (Number(point[field]) * 126) / ceiling,
    ]);
  const jobs = coords('jobs');
  const articles = coords('articles');
  return (
    <div className="chart">
      <div className="legend">
        <span>
          <i style={{ background: '#1683f8' }} />
          Articles
        </span>
        <span>
          <i style={{ background: '#9346f2' }} />
          Translations
        </span>
      </div>
      {points.length ? (
        <svg viewBox="0 0 730 181" role="img" aria-label="Daily source articles and translation jobs">
          <defs>
            <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
              <stop stopColor="#aa69f0" stopOpacity=".44" />
              <stop offset="1" stopColor="#aa69f0" stopOpacity=".04" />
            </linearGradient>
          </defs>
          {ticks.map((tick, i) => (
            <g key={i}>
              <path d={`M54 ${24 + i * 25.2}H694`} stroke="#dce4f0" />
              <text x="42" y={28 + i * 25.2} textAnchor="end">
                {number(tick)}
              </text>
            </g>
          ))}
          <polygon
            points={`54,150 ${jobs.map((p) => p.join(',')).join(' ')} ${jobs.at(-1)?.[0]},150`}
            fill="url(#area)"
          />
          {[jobs, articles].map((line, i) => (
            <g key={i} stroke={i ? '#087bff' : '#9828f3'}>
              <polyline points={line.map((p) => p.join(',')).join(' ')} fill="none" strokeWidth="2.3" />
              {line.map(([x, y], j) => (
                <circle key={j} cx={x} cy={y} r="2.9" fill="#fff" strokeWidth="1.8">
                  <title>
                    {points[j].day} · {i ? points[j].articles : points[j].jobs}
                  </title>
                </circle>
              ))}
            </g>
          ))}
          {points.map(
            (point, i) =>
              i % Math.max(1, Math.ceil(points.length / 8)) === 0 && (
                <text key={point.day} x={jobs[i][0]} y="174" textAnchor={i === 0 ? 'start' : 'middle'}>
                  {new Date(point.day + 'T00:00:00Z').toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })}
                </text>
              ),
          )}
        </svg>
      ) : (
        <p className="chart-empty">Daily activity will appear after the first article arrives.</p>
      )}
    </div>
  );
}

function JobStatus({ data }: { data: Overview['jobs'] }) {
  const ordered = [
    ...states,
    ...data
      .filter((item) => !states.some(([state]) => state === item.state))
      .map((item) => [item.state, label(item.state), '#7087a8']),
  ];
  const total = data.reduce((sum, item) => sum + Number(item.total), 0);
  let offset = 0;
  const entries = ordered.map(([state, title, color]) => {
    const count = Number(data.find((item) => item.state === state)?.total ?? 0);
    const pct = total ? (count / total) * 100 : 0;
    const start = offset;
    offset += pct;
    return { state, title, color, count, pct, start };
  });
  const gradient = entries
    .filter((item) => item.count)
    .map((item) => `${item.color} ${item.start}% ${item.start + item.pct}%`)
    .join(',');
  return (
    <div className="job-content">
      <div className="donut" style={{ background: gradient ? `conic-gradient(${gradient})` : '#e3eaf5' }}>
        <div>
          <strong>{number(total)}</strong>
          <span>Total jobs</span>
        </div>
      </div>
      <div className="status-list">
        {entries.map((item) => (
          <div key={item.state}>
            <i style={{ background: item.color }} />
            <strong>{item.title}</strong>
            <span>{item.pct.toFixed(1)}%</span>
            <span>{number(item.count)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Usage({ data }: { data: Row[] }) {
  const sum = data.reduce((total, row) => total + Number(row.cost), 0);
  return (
    <Table
      headings={['Provider', 'Model / Type', 'Requests', 'Characters', 'Cost (₹)', 'Usage']}
      rows={data.map((row, i) => {
        const split = sum ? Math.round((Number(row.cost) / sum) * 100) : 0;
        return [
          <strong className="provider">
            <span style={{ color: shades[i % shades.length] }}>{initials[i % initials.length]}</span>
            {row.name}
          </strong>,
          row.adapter,
          number(row.requests),
          Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
            Number(row.characters),
          ),
          money(row.cost),
          <div className="usage">
            <progress max="100" value={split} />
            <span>{split}%</span>
          </div>,
        ];
      })}
    />
  );
}

export function Dashboard({
  data,
  demo,
  navigate,
  days,
}: {
  data: Overview;
  demo: boolean;
  navigate: (page: string) => void;
  days: number;
}) {
  const jobs = data.jobs.reduce((sum, row) => sum + Number(row.total), 0);
  const published = Number(data.jobs.find((item) => item.state === 'published')?.total ?? 0);
  const cost = data.usage.reduce((sum, row) => sum + Number(row.cost), 0);
  const metric = [
    {
      icon: FileText,
      color: 'purple',
      value: number(data.articles.total),
      title: 'Source Articles',
      note: demo ? '↑ 12% vs previous period' : `Last ${days} days`,
    },
    {
      icon: Languages,
      color: 'cyan',
      value: number(demo ? jobs : published),
      title: 'Translations',
      note: demo ? '↑ 18% vs previous period' : 'Published jobs',
    },
    {
      icon: Globe2,
      color: 'green',
      value: number(data.domains.total),
      title: 'Active Domains',
      note: demo ? '✓ All online' : 'Enabled domains',
    },
    {
      icon: Layers,
      color: 'orange',
      value: number(demo ? 4320 : jobs),
      title: 'Translation Jobs',
      note: demo ? '↑ 98.6% success' : `${jobs ? Math.round((published / jobs) * 100) : 0}% published`,
    },
    {
      icon: Wallet,
      color: 'pink',
      value: money(cost),
      title: 'Estimated API Cost',
      note: demo ? '54% of ₹60,000 budget' : `Last ${days} days · INR`,
    },
  ];
  const link = (title: string, page: string) => (
    <button className="text-button" onClick={() => navigate(page)}>
      {title}
      <ArrowRight size={15} />
    </button>
  );
  return (
    <div className="dashboard">
      <div className="metric-grid">
        {metric.map(({ icon: Icon, ...item }) => (
          <div className="metric panel" key={item.title}>
            <div className={`metric-icon ${item.color}`}>
              <Icon size={34} strokeWidth={2} />
            </div>
            <div>
              <strong>{item.value}</strong>
              <span>{item.title}</span>
              <small className={demo ? 'positive' : ''}>{item.note}</small>
              {demo && item.color === 'pink' && <progress max="100" value="54" />}
            </div>
          </div>
        ))}
      </div>
      <div className="dashboard-row hero-row">
        <Panel title="Translation Activity" icon={<Activity />}>
          <Chart points={data.activity} />
        </Panel>
        <Panel
          title="Job Status"
          icon={<Layers />}
          action={<small className="muted">Last {days} days</small>}
        >
          <JobStatus data={data.jobs} />
        </Panel>
      </div>
      <div className="dashboard-row middle-row">
        <Panel
          title="API Provider Usage & Cost"
          icon={<Bot />}
          action={link('Manage providers', 'providers')}
        >
          <Usage data={data.usage} />
          <div className="total-line">
            <strong>Total</strong>
            <strong>{number(data.usage.reduce((sum, row) => sum + Number(row.requests), 0))} requests</strong>
            <strong>{money(cost)}</strong>
          </div>
        </Panel>
        <Panel title="Domains by Group" icon={<Globe2 />} action={link('Manage groups', 'groups')}>
          {data.groups.length ? (
            <div className="group-list">
              {data.groups.map((row, i) => {
                const Icon = [Crown, Layers, Leaf][i % 3];
                return (
                  <div key={String(row.name)}>
                    <Icon color={['#f5a300', '#fa5b12', '#2ba844'][i % 3]} size={21} />
                    <strong>{row.name}</strong>
                    <span>{row.domains} domains</span>
                    <span>{row.daily_limit} articles/day</span>
                    <Badge state={String(Boolean(row.enabled))} />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="empty">No translation groups configured.</p>
          )}
        </Panel>
      </div>
      <div className="dashboard-row bottom-row">
        <Panel title="Recent Translation Jobs" icon={<ClipboardList />} action={link('View all', 'jobs')}>
          <Table
            headings={['#', 'Article', 'Domain', 'Provider', 'Status', 'Time']}
            rows={data.recent.map((row, i) => [
              `#${row.id}`,
              row.title,
              row.hostname,
              row.provider,
              <Badge state={String(row.state)} />,
              demo ? `${i + 2} min ago` : dateLabel(row.created_at),
            ])}
          />
        </Panel>
        <Panel title="System Status" icon={<Server />}>
          <div className="system">
            <div className="services">
              {Object.entries(data.health)
                .sort(
                  ([a], [b]) =>
                    ['api', 'mysql', 'redis', 'worker'].indexOf(a) -
                    ['api', 'mysql', 'redis', 'worker'].indexOf(b),
                )
                .map(([key, on]) => (
                  <div key={key}>
                    {on ? <Check size={15} /> : <CircleAlert size={15} />}
                    <span>
                      {
                        {
                          api: 'API (NestJS)',
                          mysql: 'Database (MySQL 8)',
                          redis: 'Queue (Redis / BullMQ)',
                          worker: 'Translation worker',
                        }[key]
                      }
                    </span>
                    <strong>{on ? 'Online' : 'Offline'}</strong>
                  </div>
                ))}
            </div>
            {demo && (
              <div className="resources">
                {[
                  ['Disk Usage', 36],
                  ['Memory Usage', 62],
                  ['CPU Usage', 18],
                ].map(([name, percent]) => (
                  <div key={name}>
                    <span>
                      {name}
                      <strong>{percent}%</strong>
                    </span>
                    <progress max="100" value={percent} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
