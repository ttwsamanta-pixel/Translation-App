export function normalizeHost(value: string) {
  return value.toLowerCase().trim().replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
}
