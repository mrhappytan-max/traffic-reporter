// V1.8.6.9 — GET /admin/deployment-status-view. Server-rendered HTML, no
// client-side JavaScript at all — same CSP-compatible, script-free
// convention already established by health.js and
// pipelineTraceView.js (see that file's own module comment for why: the
// existing Admin CSP is `default-src 'none'` with no script-src
// exception, and this page has no reason to be the first one to ask for
// it). Reuses the same card/pill visual language as health.js for
// consistency across this project's admin pages.
//
// This module renders ONLY — 0 KV reads, 0 upstream calls, all data
// comes from getDeploymentStatus(env) (deploymentStatus.js), which is
// itself pure/0-I/O.

import { getDeploymentStatus } from './deploymentStatus.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortSha(sha) {
  if (!sha || sha === 'unknown') return sha || '（未知）';
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function yesNoPill(ok, yesLabel = '是', noLabel = '否') {
  return `<span class="pill ${ok ? 'pill-ok' : 'pill-bad'}">${ok ? yesLabel : noLabel}</span>`;
}

function renderRow(label, valueHtml) {
  return `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${valueHtml}</span></div>`;
}

function renderPage(status) {
  const driftBanner = status.driftDetected
    ? `<div class="banner banner-bad">
        <div class="banner-title">🔴 VERSION DRIFT</div>
        <div class="banner-line">Deployed: ${escapeHtml(shortSha(status.deployedCommit))} (${escapeHtml(status.deployedBranch)})</div>
        <div class="banner-line">Expected: ${escapeHtml(shortSha(status.expectedMainCommit))} (${escapeHtml(status.expectedBranch)})</div>
        ${status.driftReasons.map((r) => `<div class="banner-reason">・${escapeHtml(r)}</div>`).join('')}
      </div>`
    : `<div class="banner banner-ok">✅ 版本正常，未偵測到漂移</div>`;

  const routesRows = status.routes
    .map((r) => renderRow(r.path, yesNoPill(r.registered, '✅ 已註冊', '❌ 未註冊')))
    .join('');

  const bindingsRows = status.bindings
    .map((b) => renderRow(`${b.name}（${b.kind}）`, yesNoPill(b.present, '✅ 存在', '❌ 缺失')))
    .join('');

  const secretsRows = status.secrets
    .map((s) => renderRow(s.name, yesNoPill(s.present, '✅ 已設定', '⚠️ 未設定')))
    .join('');

  const dashboardOnlyItems = status.dashboardOnlyChecks.map((c) => `<li>${escapeHtml(c)}</li>`).join('');

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>路況播報員 部署狀態</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; max-width: 700px; margin-left: auto; margin-right: auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    font-size: 17px; line-height: 1.5; background: #f4f5f7; color: #1a1a1a;
  }
  h1 { font-size: 21px; margin: 0 0 4px; }
  .subtitle { font-size: 14px; color: #555; margin: 0 0 16px; }
  .banner { border-radius: 12px; padding: 16px; margin-bottom: 16px; font-size: 15px; }
  .banner-ok { background: #e6f6ea; color: #1a7f37; font-weight: 700; }
  .banner-bad { background: #fdecec; color: #c31c1c; }
  .banner-title { font-size: 20px; font-weight: 800; margin-bottom: 6px; }
  .banner-line { font-size: 14px; margin: 2px 0; }
  .banner-reason { font-size: 13px; margin-top: 4px; color: #8a1f1f; }
  .card { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .card h2 { font-size: 16px; margin: 0 0 10px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid #eee; font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .row .label { color: #444; }
  .row .value { font-weight: 600; text-align: right; }
  .pill { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
  .pill-ok { background: #e6f6ea; color: #1a7f37; }
  .pill-bad { background: #fdecec; color: #c31c1c; }
  .hint { font-size: 12.5px; color: #777; margin: 8px 0 0; }
  .dashboard-only ul { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: #666; }
  .dashboard-only li { margin: 4px 0; }
  .footer { text-align: center; font-size: 13px; color: #666; margin-top: 20px; }
  .footer a { color: #1a5fb4; text-decoration: none; display: block; padding: 4px 0; }
</style>
</head>
<body>
<h1>🚀 部署狀態</h1>
<p class="subtitle">appVersion ${escapeHtml(status.appVersion)}　·　產生時間（build）${escapeHtml(status.buildTime || '（未知）')}</p>

${driftBanner}

<div class="card">
  <h2>版本身分</h2>
  ${renderRow('Production branch', `${escapeHtml(status.deployedBranch)} ${status.deployedBranch === status.expectedBranch ? '✅' : '❌'}`)}
  ${renderRow('Commit', `${escapeHtml(shortSha(status.deployedCommit))} ${status.driftDetected ? '' : '= expected ✅'}`)}
  ${renderRow('commitSource', escapeHtml(status.commitSource))}
  ${renderRow('branchSource', escapeHtml(status.branchSource))}
  ${renderRow('expectedMainCommit', escapeHtml(shortSha(status.expectedMainCommit)))}
  ${renderRow('expectedMainCommitSource', escapeHtml(status.expectedMainCommitSource))}
  <p class="hint">expectedMainCommitSource 以 "git:" 開頭才代表這是真正比對過 origin/main 的結果；"assumed-same-as-deployed" 代表該次 build 無法解析 origin/main，因此未進行比對（不是「已驗證相符」）。</p>
</div>

<div class="card">
  <h2>Routes</h2>
  ${routesRows}
</div>

<div class="card">
  <h2>Bindings</h2>
  ${bindingsRows}
  <p class="hint">只檢查 binding 是否存在於 env，不做任何外部 probe。</p>
</div>

<div class="card">
  <h2>Secrets（僅顯示是否已設定，絕不顯示內容）</h2>
  ${secretsRows}
</div>

<div class="card">
  <h2>Cron</h2>
  ${renderRow('程式期望值', `<code>${escapeHtml(status.cron.expected)}</code>`)}
  <p class="hint">${escapeHtml(status.cron.note)}</p>
</div>

<div class="card dashboard-only">
  <h2>⚠️ 僅能於 Cloudflare Dashboard 確認的項目</h2>
  <ul>${dashboardOnlyItems}</ul>
</div>

<div class="footer">
  <a href="/admin/deployment-status">查看原始 JSON → /admin/deployment-status</a>
  <a href="/version">公開版本資訊（無需登入）→ /version</a>
  <a href="/health">系統健康頁</a>
  <a href="/admin/pipeline-trace-view">Pipeline Trace 查修頁</a>
</div>
</body>
</html>`;
}

/**
 * GET /admin/deployment-status-view (Admin-Basic-Auth-gated and method-
 * restricted at the route level — see index.js). 0 upstream calls, 0 KV
 * reads.
 */
export function handleDeploymentStatusView(env) {
  const status = getDeploymentStatus(env);
  return new Response(renderPage(status), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
