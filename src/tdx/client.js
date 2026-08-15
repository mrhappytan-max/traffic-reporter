// Thin fetch wrapper for TDX API calls. Never includes the access token
// (or anything derived from the client secret) in error messages.

export class TdxApiError extends Error {
  constructor(message, { status = null, source = null } = {}) {
    super(message);
    this.name = 'TdxApiError';
    this.status = status;
    this.source = source;
  }
}

export async function fetchTdxJson(url, accessToken, { source } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
    });
  } catch (err) {
    throw new TdxApiError(`Network error calling ${source}: ${err.message}`, { source });
  }

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      // ignore — body isn't required for the error to be useful
    }
    const suffix = bodySnippet ? `: ${bodySnippet}` : '';
    throw new TdxApiError(
      `TDX API "${source}" responded with HTTP ${response.status} ${response.statusText}${suffix}`,
      { status: response.status, source }
    );
  }

  try {
    return await response.json();
  } catch (err) {
    throw new TdxApiError(`Failed to parse JSON from "${source}": ${err.message}`, { source });
  }
}
