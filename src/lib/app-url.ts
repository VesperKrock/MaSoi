function normalizeBasePath(basePath: string): string {
  const withLeadingSlash = basePath.startsWith('/') ? basePath : `/${basePath}`
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`
}

export function appUrl(
  query = '',
  basePath: string = import.meta.env.BASE_URL,
): string {
  const normalizedQuery = query && !query.startsWith('?') ? `?${query}` : query
  return `${normalizeBasePath(basePath)}${normalizedQuery}`
}

export function publicAssetUrl(
  path: string,
  basePath: string = import.meta.env.BASE_URL,
): string {
  return `${normalizeBasePath(basePath)}${path.replace(/^\/+/, '')}`
}
