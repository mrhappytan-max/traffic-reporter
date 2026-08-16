const PBS_RELAY_PROBE_BASE_URL = 'http://pbs-relay.internal';
const MAX_PREVIEW_LENGTH = 300;

function redact(value, token) {
  const text = String(value ?? '');
  const redacted = token ? text.split(token).join('[REDACTED]') : text;
  return redacted
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/Authorization/gi, '[REDACTED_HEADER]');
}

function preview(value, token) {
  return redact(value, token).slice(0, MAX_PREVIEW_LENGTH);
}

function errorPreview(error, token) {
  const name = error && typeof error.name === 'string' ? error.name : 'Error';
  const message = error && typeof error.message === 'string' ? error.message : String(error ?? 'Unknown error');
  return preview(`${name}: ${message}`, token);
}

async function probe(binding, path, token) {
  try {
    const response = await binding.fetch(`${PBS_RELAY_PROBE_BASE_URL}${path}`, {
      headers: {
        Accept: 'application/json',
        ...(path === '/pbs' ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    return {
      status: response.status,
      ok: response.ok,
      body: preview(await response.text(), token),
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      body: errorPreview(error, token),
    };
  }
}

export async function handlePbsVpcProbe(env) {
  const relayConfigured = Boolean(env.PBS_RELAY_WINDOWS && env.PBS_RELAY_TOKEN);
  if (!relayConfigured) {
    const body = 'PbsRelayNotConfigured: PBS relay binding or token is missing';
    return Response.json({
      healthStatus: null,
      healthOk: false,
      healthBody: body,
      pbsStatus: null,
      pbsOk: false,
      pbsBodyPreview: body,
      relayConfigured,
    });
  }

  const health = await probe(env.PBS_RELAY_WINDOWS, '/health', env.PBS_RELAY_TOKEN);
  const pbs = await probe(env.PBS_RELAY_WINDOWS, '/pbs', env.PBS_RELAY_TOKEN);
  return Response.json({
    healthStatus: health.status,
    healthOk: health.ok,
    healthBody: health.body,
    pbsStatus: pbs.status,
    pbsOk: pbs.ok,
    pbsBodyPreview: pbs.body,
    relayConfigured,
  });
}
