export const roles = [
  'super_admin',
  'admin',
  'translation_manager',
  'content_manager',
  'domain_manager',
  'seo_manager',
  'viewer',
  'editor',
  'technical',
] as const;
export const accountManagers = ['super_admin', 'admin'];
export const translationManagers = [...accountManagers, 'translation_manager'];
export const domainManagers = [...translationManagers, 'domain_manager'];
export const siteManagers = [...translationManagers, 'seo_manager'];
export const contentEditors = [...translationManagers, 'editor', 'content_manager'];
