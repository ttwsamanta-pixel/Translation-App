import { useEffect, useState, type FormEvent } from 'react';
import { Waypoints } from 'lucide-react';
import { Panel } from './dashboard';
import type { AdminApi } from './website';

type Option = { id: number; name: string };
type Rule = {
  id: number;
  category: string;
  domain_id: number | null;
  group_id: number | null;
  daily_limit: number;
  priority: number;
  provider_id: number | null;
  fallback_provider_id: number | null;
  enabled: boolean;
  used: number;
};
type Rules = {
  rules: Rule[];
  domains: Option[];
  groups: Option[];
  providers: Option[];
  categories: { name: string }[];
};
type DomainUsage = {
  id: number;
  hostname: string;
  timezone: string;
  daily_limit: number;
  local_day: string;
  used: number;
  remaining: number;
  published: number;
  failed: number;
};
const newRule: Rule = {
  id: 0,
  category: '',
  domain_id: null,
  group_id: null,
  daily_limit: 0,
  priority: 10,
  provider_id: null,
  fallback_provider_id: null,
  enabled: true,
  used: 0,
};

export function DistributionRules({ api, token }: { api: AdminApi; token?: string }) {
  const [data, setData] = useState<Rules>();
  const [usage, setUsage] = useState<DomainUsage[]>([]);
  const [editing, setEditing] = useState<Rule>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!token) return;
    let live = true;
    void Promise.all([
      api<Rules>('distribution/rules', token),
      api<DomainUsage[]>('distribution/usage', token),
    ])
      .then(([rules, domains]) => {
        if (live) {
          setData(rules);
          setUsage(domains);
        }
      })
      .catch((failure: Error) => {
        if (live) setError(failure.message);
      });
    return () => {
      live = false;
    };
  }, [api, token, tick]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const [type, id] = String(form.get('destination')).split(':');
    setBusy(true);
    setError('');
    try {
      await api(
        'distribution/rules' + (editing.id ? '/' + editing.id : ''),
        token,
        editing.id ? 'PATCH' : 'POST',
        {
          category: form.get('category'),
          domain_id: type === 'domain' ? Number(id) : null,
          group_id: type === 'group' ? Number(id) : null,
          daily_limit: Number(form.get('daily_limit')),
          priority: Number(form.get('priority')),
          provider_id: Number(form.get('provider_id')) || null,
          fallback_provider_id: Number(form.get('fallback_provider_id')) || null,
          enabled: form.has('enabled'),
        },
      );
      setEditing(undefined);
      setTick((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to save rule');
    } finally {
      setBusy(false);
    }
  }

  if (!token) return <p className="panel empty">Sign in to configure distribution.</p>;
  if (!data) return <p className="panel empty">{error || 'Loading distribution rules…'}</p>;
  return (
    <div className="dashboard">
      <Panel
        title="Category distribution rules"
        icon={<Waypoints />}
        action={
          <button className="primary" onClick={() => setEditing(newRule)}>
            Add rule
          </button>
        }
      >
        <div className="detail-body">
          <p>
            {data.rules.length
              ? 'Articles route only to destinations with a matching enabled rule. Lower priority numbers run first.'
              : 'Articles currently route to all eligible domains. Creating the first rule switches distribution to matching rules.'}
          </p>
          <p>
            Rule quotas count distinct articles per UTC day. Each domain also enforces its own daily limit.
          </p>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {['Category', 'Destination', 'Used today', 'Priority', 'Status', 'Actions'].map((title) => (
                    <th key={title}>{title}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.category}</td>
                    <td>
                      {
                        (rule.domain_id ? data.domains : data.groups).find(
                          (item) => item.id === (rule.domain_id ?? rule.group_id),
                        )?.name
                      }
                    </td>
                    <td>
                      {rule.used} / {rule.daily_limit}
                    </td>
                    <td>{rule.priority}</td>
                    <td>{rule.enabled ? 'Enabled' : 'Disabled'}</td>
                    <td>
                      <button className="secondary" onClick={() => setEditing(rule)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editing && (
            <form className="config-form" key={editing.id} onSubmit={(event) => void save(event)}>
              <div className="config-grid">
                <label>
                  Category name
                  <input
                    name="category"
                    required
                    maxLength={200}
                    list="distribution-categories"
                    defaultValue={editing.category}
                  />
                  <datalist id="distribution-categories">
                    {data.categories.map(({ name }) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </label>
                <label>
                  Destination
                  <select
                    name="destination"
                    required
                    defaultValue={
                      editing.domain_id
                        ? 'domain:' + editing.domain_id
                        : editing.group_id
                          ? 'group:' + editing.group_id
                          : ''
                    }
                  >
                    <option value="">Choose a domain or group</option>
                    <optgroup label="Groups">
                      {data.groups.map((group) => (
                        <option key={group.id} value={'group:' + group.id}>
                          {group.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Domains">
                      {data.domains.map((domain) => (
                        <option key={domain.id} value={'domain:' + domain.id}>
                          {domain.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>
                <label>
                  Daily article limit
                  <input
                    name="daily_limit"
                    type="number"
                    min="0"
                    max="10000"
                    required
                    defaultValue={editing.id ? editing.daily_limit : undefined}
                  />
                </label>
                <label>
                  Priority
                  <input
                    name="priority"
                    type="number"
                    min="1"
                    max="32767"
                    required
                    defaultValue={editing.priority}
                  />
                </label>
                {(['provider_id', 'fallback_provider_id'] as const).map((key) => (
                  <label key={key}>
                    {key === 'provider_id' ? 'Primary provider' : 'Fallback provider'}
                    <select name={key} defaultValue={editing[key] ?? ''}>
                      <option value="">Inherit group setting</option>
                      {data.providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label>
                  <input type="checkbox" name="enabled" defaultChecked={Boolean(editing.enabled)} /> Enabled
                </label>
              </div>
              <div className="config-section">
                <button className="primary" disabled={busy}>
                  Save rule
                </button>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing(undefined)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </Panel>
      <Panel
        title="Domain quotas"
        icon={<Waypoints />}
        action={
          <button className="secondary" onClick={() => setTick((value) => value + 1)}>
            Refresh
          </button>
        }
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {['Domain', 'Quota day', 'Used', 'Remaining', 'Published (UTC)', 'Failed (UTC)'].map(
                  (title) => (
                    <th key={title}>{title}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {usage.map((domain) => (
                <tr key={domain.id}>
                  <td>{domain.hostname}</td>
                  <td>
                    {domain.local_day} ({domain.timezone})
                  </td>
                  <td>
                    {domain.used} / {domain.daily_limit}
                  </td>
                  <td>{domain.remaining}</td>
                  <td>{domain.published}</td>
                  <td>{domain.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
