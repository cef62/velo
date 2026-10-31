const RELEASES = 'https://github.com/cef62/velo/releases';

export interface ReleaseLinks {
  version?: string;
  mac: string;
  linux: string;
  windows: string;
  deb?: string;
}

// Latest PUBLISHED release (the API never returns drafts). Any failure falls back to the
// unversioned /releases/latest page so the build never breaks or links to a missing asset.
export async function getRelease(): Promise<ReleaseLinks> {
  const latest = `${RELEASES}/latest`;
  const fallback = { mac: latest, linux: latest, windows: latest };
  try {
    const token = process.env.GITHUB_TOKEN;
    const res = await fetch(process.env.RELEASE_API_URL ?? 'https://api.github.com/repos/cef62/velo/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return fallback;
    const rel = await res.json();
    const urls: string[] = (rel.assets ?? []).map((a: { browser_download_url: string }) => a.browser_download_url);
    const find = (suffix: string) => urls.find((u) => u.endsWith(suffix));
    return {
      version: String(rel.tag_name).replace(/^v/, ''),
      mac: find('_aarch64.dmg') ?? latest,
      linux: find('_amd64.AppImage') ?? latest,
      windows: find('_x64-setup.exe') ?? latest,
      deb: find('_amd64.deb'),
    };
  } catch {
    return fallback;
  }
}
