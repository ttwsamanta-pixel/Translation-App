import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Globe2, Languages } from 'lucide-react';
import {
  defaultWebsite,
  englishLabels,
  labelKeys,
  websiteSchema,
  type Localization,
  type Website,
  type WebsiteOverride,
} from '../../packages/shared/src/website';
import { publicLabels } from '../../apps/web/src/locale';
import { adSlot, renderPage, type TemplateContext } from '../../apps/web/src/template';
import { escape } from '../../apps/web/src/seo';
import { Panel } from './dashboard';

export type AdminApi = <T>(path: string, token?: string, method?: string, data?: unknown) => Promise<T>;
type Choice = { id: number; name: string };
type WebsiteRecord = {
  publishedVersion: number | null;
  design: Website;
  versions: { id: number; created_at: string }[];
  domains: (Choice & { language_id: number; origin: string })[];
  languages: (Choice & { code: string })[];
  overrides: { domain_id: number; configuration: WebsiteOverride }[];
  translations: { language_id: number; translations: Localization }[];
};

const collections = ['navigation', 'footer', 'pages', 'videos', 'magazines', 'ads'] as const;
const collectionLabels = {
  navigation: 'Navigation links',
  footer: 'Footer links',
  pages: 'Static pages',
  videos: 'Videos',
  magazines: 'Magazine issues',
  ads: 'Advertisements',
};
const collectionHints = {
  navigation: 'Leave empty to use the localized default navigation.',
  footer: '',
  pages: 'Add /page/your-slug to navigation or the footer to link to a page.',
  videos: '',
  magazines: '',
  ads: 'Each placement supports one ad.',
};
const fields = {
  navigation: { label: 'Label', href: 'Link' },
  footer: { label: 'Label', href: 'Link' },
  pages: { slug: 'Page slug', title: 'Title', content: 'Page content' },
  videos: { title: 'Title', url: 'Video URL', image: 'Image URL (optional)' },
  magazines: { title: 'Title', url: 'Magazine URL', image: 'Image URL (optional)' },
  ads: { slot: 'Placement', label: 'Image description', image: 'Image URL', url: 'Destination URL' },
};

function TemplateCollection({
  kind,
  values,
  onChange,
}: {
  kind: (typeof collections)[number];
  values: Record<string, string>[];
  onChange: (value: Record<string, string>[]) => void;
}) {
  const columns = Object.entries(fields[kind]);
  const max = { navigation: 20, footer: 20, pages: 40, videos: 40, magazines: 40, ads: 2 }[kind];
  return (
    <fieldset>
      <legend>{collectionLabels[kind]}</legend>
      {collectionHints[kind] && <p>{collectionHints[kind]}</p>}
      {values.map((row, index) => {
        const update = (field: string, value: string) => {
          const next = { ...row, [field]: value };
          if (!value && field === 'image' && (kind === 'videos' || kind === 'magazines')) delete next.image;
          onChange(values.map((entry, i) => (i === index ? next : entry)));
        };
        return (
          <div className="config-section" key={index}>
            {columns.map(([field, label]) => (
              <label key={field}>
                {label}
                {field === 'slot' ? (
                  <select value={row[field] ?? ''} onChange={(event) => update(field, event.target.value)}>
                    <option value="">Choose placement</option>
                    <option value="home-top">Homepage</option>
                    <option value="article-top">Article</option>
                  </select>
                ) : field === 'content' ? (
                  <textarea
                    rows={3}
                    value={row[field] ?? ''}
                    onChange={(event) => update(field, event.target.value)}
                  />
                ) : (
                  <input value={row[field] ?? ''} onChange={(event) => update(field, event.target.value)} />
                )}
              </label>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="secondary"
        disabled={values.length >= max}
        onClick={() => onChange([...values, {}])}
      >
        Add item
      </button>
    </fieldset>
  );
}

export function WebsiteEditor({
  api,
  token,
  view,
}: {
  api: AdminApi;
  token?: string;
  view: 'website' | 'localization';
}) {
  const [data, setData] = useState<WebsiteRecord>();
  const [preview, setPreview] = useState('');
  const [previewPage, setPreviewPage] = useState('home');
  const [revision, setRevision] = useState<number | null>(null);
  const [draft, setDraft] = useState(defaultWebsite);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [domainId, setDomainId] = useState(0);
  const [languageId, setLanguageId] = useState(0);
  const [tick, setTick] = useState(0);
  const initialized = useRef(false);
  useEffect(() => {
    if (!token) return;
    let live = true;
    void api<WebsiteRecord>('website', token)
      .then((result) => {
        if (!live) return;
        setData(result);
        if (!initialized.current) {
          initialized.current = true;
          setDraft(result.design);
          setRevision(result.publishedVersion);
        }
      })
      .catch((failure: Error) => {
        if (live) setError(failure.message);
      });
    return () => {
      live = false;
    };
  }, [api, token, tick]);

  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to save settings');
    } finally {
      setBusy(false);
    }
  }

  function readDesign(form: HTMLFormElement) {
    const values = new FormData(form);
    const result = websiteSchema.safeParse({
      ...draft,
      name: values.get('name'),
      logo: values.get('logo') || null,
      primary: values.get('primary'),
      accent: values.get('accent'),
      font: values.get('font'),
      sharing: values.has('sharing'),
      popularLanguages: String(values.get('popularLanguages') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    });
    if (!result.success)
      throw new Error(
        result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('. '),
      );
    return result.data;
  }

  async function loadVersion(id: number) {
    await perform(async () => {
      const result = id
        ? await api<{ configuration: Website }>('website/versions/' + id, token)
        : { configuration: defaultWebsite };
      setPreview('');
      setDraft(result.configuration);
      setRevision(id || null);
      setDirty(false);
    });
  }

  const selectedLanguage = data?.languages.find((item) => item.id === languageId);
  const localization = data?.translations.find((item) => item.language_id === languageId)?.translations;
  const selectedDomain = data?.domains.find((item) => item.id === domainId);
  const domainOverride = data?.overrides.find((item) => item.domain_id === domainId)?.configuration;

  function makePreview(design: Website) {
    const language = data?.languages.find((item) => item.id === selectedDomain?.language_id);
    const code = language?.code ?? 'en';
    const labels = publicLabels(
      code,
      data?.translations.find((item) => item.language_id === language?.id)?.translations.labels,
    );
    const context: TemplateContext = {
      code,
      labels,
      design: { ...design, ...domainOverride },
      rss: true,
      editions:
        data?.domains.map((item) => {
          const locale = data.languages.find((language) => language.id === item.language_id);
          return {
            name: locale?.name ?? item.name,
            code: locale?.code ?? 'en',
            url: item.origin,
            current: item.id === domainId,
          };
        }) ?? [],
    };
    const title =
      previewPage === 'home'
        ? context.design.name
        : previewPage === 'article'
          ? labels.latest
          : labels.categories;
    const card = (title: string) =>
      `<div class="grid"><section class="card"><div><h3>${escape(title)}</h3></div></section></div>`;
    const namedMedia = (items: Website['videos']) =>
      items
        .map(
          (item) =>
            `<section class="card">${item.image ? `<img src="${escape(item.image)}" alt="">` : ''}<div><h3>${escape(item.title)}</h3></div></section>`,
        )
        .join('');
    const content =
      previewPage === 'article'
        ? `${adSlot(context, 'article-top')}<article class="story"><h1>${escape(title)}</h1><p>${escape(labels.demo)}</p></article>`
        : previewPage === 'category'
          ? `<h1 class="heading">${escape(title)}</h1>${card(labels.demo)}`
          : `<h1>${escape(title)}</h1>${adSlot(context, 'home-top')}${context.design.sections
              .filter((section) => section.visible)
              .map(
                ({ key, limit }) =>
                  `<section class="block"><h2 class="heading">${escape(labels[key])}</h2>${
                    key === 'videos' || key === 'magazine'
                      ? `<div class="grid">${namedMedia((key === 'videos' ? context.design.videos : context.design.magazines).slice(0, limit))}</div>`
                      : card(labels.demo)
                  }</section>`,
              )
              .join('')}`;
    setPreview(renderPage(context, title, content, '<meta name="robots" content="noindex">'));
  }

  if (!token) return <p className="panel empty">Sign in to manage your website.</p>;
  if (!data)
    return <p className={'panel empty' + (error ? ' error' : '')}>{error || 'Loading website settings…'}</p>;
  return (
    <div className="dashboard">
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {view === 'localization' ? (
        <Panel title="Stored interface translations" icon={<Languages />}>
          <div className="detail-body">
            <label>
              Language{' '}
              <select
                value={languageId || ''}
                onChange={(event) => setLanguageId(Number(event.target.value))}
              >
                <option value="">Choose language</option>
                {data.languages.map((language) => (
                  <option key={language.id} value={language.id}>
                    {language.name} ({language.code})
                  </option>
                ))}
              </select>
            </label>
            {selectedLanguage && (
              <form
                className="config-form"
                key={languageId + ':' + tick}
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  void perform(async () => {
                    const labels = Object.fromEntries(
                      labelKeys
                        .map((key) => [key, String(values.get(key) ?? '').trim()])
                        .filter(([, value]) => value),
                    );
                    const categories = JSON.parse(String(values.get('categories')));
                    await api('website/translations/' + languageId, token, 'PUT', { labels, categories });
                    setNotice('Interface translations saved.');
                    setTick((value) => value + 1);
                  });
                }}
              >
                <p>
                  Stored values are shared by domains using this language. Blank fields use the built-in
                  labels.
                </p>
                <div className="config-grid">
                  {labelKeys.map((key) => (
                    <label key={key}>
                      {englishLabels[key]}
                      <input
                        name={key}
                        maxLength={190}
                        placeholder={publicLabels(selectedLanguage.code)[key]}
                        defaultValue={localization?.labels[key] ?? ''}
                      />
                    </label>
                  ))}
                </div>
                <label>
                  Category labels
                  <small>Enter the source category name and its localized label as JSON.</small>
                  <textarea
                    name="categories"
                    rows={5}
                    spellCheck={false}
                    defaultValue={JSON.stringify(localization?.categories ?? {}, null, 2)}
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Save translations
                </button>
              </form>
            )}
          </div>
        </Panel>
      ) : (
        <>
          <Panel title="Shared template" icon={<Globe2 />}>
            <div className="detail-body">
              <p>
                Published version {data.publishedVersion ? '#' + data.publishedVersion : 'Built-in design'}
              </p>
              <label>
                Load version{' '}
                <select
                  disabled={busy}
                  value={revision ?? 0}
                  onChange={(event) => void loadVersion(Number(event.target.value))}
                >
                  <option value={0}>Built-in design</option>
                  {data.versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      #{version.id} · {new Date(version.created_at).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              <form
                className="config-form"
                key={String(revision) + ':' + tick}
                onChange={() => setDirty(true)}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  void perform(async () => {
                    const design = readDesign(form);
                    const saved = await api<{ id: number }>('website/versions', token, 'POST', design);
                    setDraft(design);
                    setRevision(saved.id);
                    setData(
                      (record) =>
                        record && {
                          ...record,
                          versions: [
                            { id: saved.id, created_at: new Date().toISOString() },
                            ...record.versions,
                          ],
                        },
                    );
                    setDirty(false);
                    setNotice('Draft saved. Publish this version when ready.');
                  });
                }}
              >
                <div className="config-grid">
                  <label>
                    Site name
                    <input name="name" defaultValue={draft.name} required maxLength={180} />
                  </label>
                  <label>
                    Logo URL
                    <input name="logo" type="url" defaultValue={draft.logo ?? ''} />
                  </label>
                  <label>
                    Primary color
                    <input name="primary" type="color" defaultValue={draft.primary} />
                  </label>
                  <label>
                    Accent color
                    <input name="accent" type="color" defaultValue={draft.accent} />
                  </label>
                  <label>
                    Font
                    <select name="font" defaultValue={draft.font}>
                      <option value="system">System</option>
                      <option value="serif">Serif</option>
                      <option value="sans">Sans serif</option>
                    </select>
                  </label>
                  <label>
                    Popular language codes
                    <input
                      name="popularLanguages"
                      placeholder="fr-FR, hy-AM"
                      defaultValue={(draft.popularLanguages ?? []).join(', ')}
                    />
                  </label>
                  <label>
                    <input type="checkbox" name="sharing" defaultChecked={draft.sharing} /> Article sharing
                  </label>
                </div>
                <fieldset>
                  <legend>Homepage sections</legend>
                  {draft.sections.map((section, index) => (
                    <div className="config-section" key={section.key}>
                      <label>
                        <input
                          type="checkbox"
                          checked={section.visible}
                          onChange={(event) => {
                            const visible = event.target.checked;
                            setDraft({
                              ...draft,
                              sections: draft.sections.map((item) =>
                                item.key === section.key ? { ...item, visible } : item,
                              ),
                            });
                          }}
                        />{' '}
                        {englishLabels[section.key]}
                      </label>
                      <label>
                        Items{' '}
                        <input
                          type="number"
                          min="1"
                          max="40"
                          value={section.limit}
                          onChange={(event) => {
                            const limit = Number(event.target.value);
                            setDraft({
                              ...draft,
                              sections: draft.sections.map((item) =>
                                item.key === section.key ? { ...item, limit } : item,
                              ),
                            });
                          }}
                        />
                      </label>
                      {[-1, 1].map((direction) => (
                        <button
                          type="button"
                          className="secondary"
                          key={direction}
                          disabled={!draft.sections[index + direction]}
                          onClick={() => {
                            const sections = [...draft.sections];
                            sections.splice(index, 1);
                            sections.splice(index + direction, 0, section);
                            setDraft({ ...draft, sections });
                            setDirty(true);
                          }}
                        >
                          {direction < 0 ? 'Move up' : 'Move down'}
                        </button>
                      ))}
                    </div>
                  ))}
                </fieldset>
                {collections.map((key) => (
                  <TemplateCollection
                    key={key}
                    kind={key}
                    values={draft[key]}
                    onChange={(items) => {
                      setDraft((current) => ({ ...current, [key]: items }));
                      setDirty(true);
                    }}
                  />
                ))}
                <div className="config-section">
                  <label>
                    Preview page{' '}
                    <select value={previewPage} onChange={(event) => setPreviewPage(event.target.value)}>
                      <option value="home">Homepage</option>
                      <option value="article">Article</option>
                      <option value="category">Category</option>
                    </select>
                  </label>
                  <label>
                    Preview edition{' '}
                    <select
                      value={domainId || ''}
                      onChange={(event) => setDomainId(Number(event.target.value))}
                    >
                      <option value="">Default</option>
                      {data.domains.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    onClick={(event) => {
                      const form = event.currentTarget.form;
                      if (form) void perform(async () => makePreview(readDesign(form)));
                    }}
                  >
                    Preview
                  </button>
                </div>
                <div className="config-section">
                  <button className="primary" disabled={busy}>
                    Save as draft
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || dirty || !revision || revision === data.publishedVersion}
                    onClick={() => {
                      if (!window.confirm('Publish this template version to all editions?')) return;
                      void perform(async () => {
                        await api(`website/versions/${revision}/publish`, token, 'POST');
                        setNotice('Template published.');
                        setTick((value) => value + 1);
                      });
                    }}
                  >
                    Publish selected version
                  </button>
                </div>
              </form>
              {preview && (
                <iframe
                  className="website-preview"
                  title="Template preview with sample content"
                  srcDoc={preview}
                  sandbox=""
                />
              )}
            </div>
          </Panel>
          <Panel title="Edition overrides" icon={<Globe2 />}>
            <div className="detail-body">
              <label>
                Domain{' '}
                <select value={domainId || ''} onChange={(event) => setDomainId(Number(event.target.value))}>
                  <option value="">Choose a domain</option>
                  {data.domains.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedDomain && (
                <form
                  className="config-form"
                  key={domainId + ':' + tick}
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    const raw = String(new FormData(event.currentTarget).get('configuration'));
                    void perform(async () => {
                      await api('website/overrides/' + domainId, token, 'PUT', JSON.parse(raw));
                      setNotice('Edition overrides saved.');
                      setTick((value) => value + 1);
                    });
                  }}
                >
                  <label>
                    Override configuration
                    <small>
                      Enter only the template fields to override. Use an empty object to inherit the shared
                      design.
                    </small>
                    <textarea
                      name="configuration"
                      rows={8}
                      spellCheck={false}
                      defaultValue={JSON.stringify(domainOverride ?? {}, null, 2)}
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    Save domain overrides
                  </button>
                </form>
              )}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
