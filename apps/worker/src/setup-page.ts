import { styles } from "./setup-styles";
import type { UserInstallation } from "@sherpa/github";
import type { GatewayStatus } from "./billing";

const cloudflare = "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway";
const tokens = "https://dash.cloudflare.com/profile/api-tokens";
const accountHelp =
  "https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/";
const billingHelp = "https://developers.cloudflare.com/ai-gateway/features/unified-billing/";
const arrow = '<span aria-hidden="true">↗</span>';
const mark = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m3 25 10-18 6 11 4-7 7 14H3Z" fill="currentColor"/><path d="m10 13 3-6 4 7-4-2-3 1Z" fill="#fff"/></svg>`;
export type GatewayFormValues = { accountId: string; gatewayId: string };
export type GatewayFormErrors = Partial<Record<"accountId" | "gatewayId" | "apiToken", string>>;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function external(url: string, label: string, className = "text-link"): string {
  return `<a class="${className}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label} ${arrow}<span class="sr-only"> (opens in a new tab)</span></a>`;
}
function progress(current: number): string {
  return `<nav aria-label="Setup progress"><ol class="progress">${["GitHub account", "AI billing", "First review"].map((label, index) => `<li class="${index + 1 < current ? "done" : index + 1 === current ? "current" : ""}"${index + 1 === current ? ' aria-current="step"' : ""}><span class="step-number" aria-hidden="true">${index + 1 < current ? "✓" : index + 1}</span><span>${label}</span>${index + 1 < current ? '<span class="sr-only"> completed</span>' : ""}</li>`).join("")}</ol></nav>`;
}
function accountContext(installation: UserInstallation): string {
  return `<div class="account-context"><span class="avatar" aria-hidden="true">${escapeHtml(installation.accountLogin.slice(0, 1).toUpperCase())}</span><div><span class="eyebrow">GitHub account</span><strong>${escapeHtml(installation.accountLogin)}</strong></div><a href="/setup">Change account</a></div>`;
}
function hidden(installation: UserInstallation, csrf: string): string {
  return `<input type="hidden" name="installation_id" value="${installation.id}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

export function installationList(
  installations: UserInstallation[],
  login: string,
  installUrl?: string,
): Response {
  const install = installUrl
    ? external(installUrl, "Install Sherpa on GitHub", "button primary")
    : external(
        "https://github.com/settings/installations",
        "Open GitHub app settings",
        "button secondary",
      );
  const body = installations.length
    ? `
    <div class="intro"><p class="eyebrow">Step 1 of 3</p><h1>Where should Sherpa review?</h1><p>Choose the GitHub account or organization that owns your repositories.</p></div>
    <section class="card account-picker" aria-label="Available GitHub accounts">
      <ul class="account-list">${installations.map((item) => `<li><a class="account-option" href="/setup?installation_id=${item.id}"><span class="avatar" aria-hidden="true">${escapeHtml(item.accountLogin.slice(0, 1).toUpperCase())}</span><span class="account-name"><strong>${escapeHtml(item.accountLogin)}</strong><span>${item.accountType === "Organization" ? "Organization" : "Personal account"}</span></span><span class="continue">Continue <span aria-hidden="true">→</span></span></a></li>`).join("")}</ul>
      <p class="card-note">Next, you’ll connect Cloudflare to pay for AI reviews on this account.</p>
    </section>
    <details class="help"><summary>Don’t see the account you need?</summary><p>Install Sherpa on that account and give it access to the repositories you want reviewed. An organization owner may need to approve the installation.</p><div class="actions">${install}<a class="button secondary" href="/setup">Refresh accounts</a></div><p class="small">Signed in to the wrong GitHub account? Switch accounts on GitHub, then <a href="/setup?sign_in=1">sign in to Sherpa again</a>.</p></details>
  `
    : `
    <div class="intro"><p class="eyebrow">Step 1 of 3</p><h1>Let’s connect your repositories.</h1><p>You’re signed in. Now give Sherpa access to the code you’d like reviewed.</p></div>
    <section class="card empty-state"><div class="illustration" aria-hidden="true">${mark}</div><h2>Install Sherpa to get started</h2><p>No GitHub accounts with Sherpa installed are available to this sign-in yet.</p>
      <ol class="instructions"><li>Open Sherpa’s installation page on GitHub.</li><li>Choose your account or organization, select your repositories, and click <strong>Install</strong>.</li><li>Return to this tab and refresh your accounts.</li></ol>
      ${!installUrl ? '<p class="notice">Ask the person hosting Sherpa for the app’s installation link. If you already installed it, check its repository access in GitHub app settings.</p>' : ""}
      <div class="actions">${install}<a class="button secondary" href="/setup">I’ve installed it · Refresh</a></div>
    </section>
    <details class="help"><summary>Already installed, but your account is missing?</summary><p>Check that you’re signed in to the GitHub account that has access to the installation. For an organization, ask an owner to approve any pending installation request.</p><p><a href="/setup?sign_in=1">Sign in to Sherpa again</a> after switching accounts on GitHub.</p></details>
  `;
  return html(body, 200, [], { login, step: 1 });
}

export function gatewayForm(
  installation: UserInstallation,
  status: GatewayStatus,
  csrf: string,
  login: string,
  message?: string,
  errors: GatewayFormErrors = {},
  values?: GatewayFormValues,
): Response {
  const hasErrors = Object.keys(errors).length > 0;
  const configured = status.configured;
  const accountId = values?.accountId ?? status.accountId ?? "";
  const gatewayId = values?.gatewayId ?? status.gatewayId ?? "";
  const fieldError = (key: keyof GatewayFormErrors, id: string) =>
    errors[key] ? `<p class="field-error" id="${id}-error">${escapeHtml(errors[key]!)}</p>` : "";
  const attrs = (key: keyof GatewayFormErrors, id: string) =>
    `aria-describedby="${id}-help${errors[key] ? ` ${id}-error` : ""}"${errors[key] ? ' aria-invalid="true"' : ""}`;
  const form = `
    <form method="post" action="/setup/gateway" class="gateway-form">
      ${hidden(installation, csrf)}
      ${hasErrors ? `<div class="notice error" role="alert"><strong>Check the highlighted fields.</strong><p>Your account ID and gateway name are still here. Please paste the token again before saving.</p></div>` : ""}
      <section class="form-section" aria-labelledby="create-gateway"><div class="section-heading"><span class="mini-step">1</span><h2 id="create-gateway">Create your AI Gateway</h2></div>
        <p>Cloudflare’s AI Gateway handles billing for your reviews. Open it in a new tab and choose <strong>Create Gateway</strong>. Name it <code>sherpa</code>, or use an existing gateway.</p>
        <div class="actions">${external(cloudflare, "Open AI Gateway", "button secondary")}</div>
        <details class="help compact" open><summary>Set up billing before your first review</summary><p>Turn on gateway authentication and add prepaid credits under <strong>Unified Billing</strong>. If you use Workers AI models, select <strong>Unified billing</strong> for Workers AI Billing too.</p><p>${external(billingHelp, "Follow Cloudflare’s billing guide")}</p></details>
      </section>
      <section class="form-section" aria-labelledby="gateway-details"><div class="section-heading"><span class="mini-step">2</span><h2 id="gateway-details">Copy your gateway details</h2></div>
        <div class="field"><label for="account-id">Cloudflare account ID</label><p class="field-help" id="account-id-help">The 32-character account ID from your Cloudflare dashboard. ${external(accountHelp, "Find my account ID")}</p>
          <input id="account-id" name="account_id" required maxlength="32" pattern="[a-fA-F0-9]{32}" title="Enter the 32-character Cloudflare account ID using letters a–f and numbers." autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Paste your 32-character account ID" value="${escapeHtml(accountId)}" ${attrs("accountId", "account-id")}>
          ${fieldError("accountId", "account-id")}</div>
        <div class="field"><label for="gateway-id">AI Gateway name</label><p class="field-help" id="gateway-id-help">Copy the gateway name exactly as it appears in Cloudflare. Use lowercase letters, numbers, hyphens, or underscores.</p>
          <input id="gateway-id" name="gateway_id" required maxlength="64" pattern="[a-z0-9][a-z0-9_\\-]{0,63}" title="Start with a lowercase letter or number; use up to 64 lowercase letters, numbers, hyphens, or underscores." autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. sherpa" value="${escapeHtml(gatewayId)}" ${attrs("gatewayId", "gateway-id")}>
          ${fieldError("gatewayId", "gateway-id")}</div>
      </section>
      <section class="form-section" aria-labelledby="create-token"><div class="section-heading"><span class="mini-step">3</span><h2 id="create-token">Create an API token</h2></div>
        <p>In Cloudflare, select <strong>Create Token → Create Custom Token</strong>. Give it a name such as <code>Sherpa reviews</code> and use these settings:</p>
        <dl class="token-settings"><div><dt>Permission</dt><dd>Account → Workers AI → Read</dd></div><div><dt>Account resources</dt><dd>Include → Specific account → your gateway’s account</dd></div></dl>
        <p class="small">Continue to the summary, create the token, and copy it.</p>
        <div class="actions">${external(tokens, "Create a Cloudflare token", "button secondary")}</div>
        <div class="field"><label for="api-token">Cloudflare API token</label><p class="field-help" id="api-token-help">Paste the token you just created. ${configured ? "To update these settings, paste a new token or re-enter the current one. " : ""}Saved tokens are never displayed.</p>
          <input id="api-token" name="api_token" type="password" required maxlength="4096" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Paste your API token" ${attrs("apiToken", "api-token")}>
          ${fieldError("apiToken", "api-token")}</div>
      </section>
      <div class="form-footer"><button class="button primary" type="submit">${configured ? "Save changes" : "Save gateway & continue"} <span aria-hidden="true">→</span></button><p class="small">This saves your settings. Your first review will confirm that the gateway and token work.</p></div>
    </form>`;
  const repoUrl =
    installation.accountType === "Organization"
      ? `https://github.com/orgs/${encodeURIComponent(installation.accountLogin)}/repositories`
      : `https://github.com/${encodeURIComponent(installation.accountLogin)}?tab=repositories`;
  const saved =
    configured && !hasErrors
      ? `
    <section class="card next-review"><span class="status-badge">✓ Gateway saved</span><h2>Start your first review</h2><ol class="instructions"><li>Open a repository where you installed Sherpa.</li><li>Create a pull request with a code change and make sure it’s ready for review, not a draft.</li><li>Sherpa posts its progress and review directly on the pull request.</li></ol><div class="actions">${external(repoUrl, "Open GitHub repositories", "button primary")}</div><p class="small">Retrying an incomplete review? Open the pull request’s Checks tab and choose Re-run on the Sherpa check, or push a new commit. Saving a gateway does not rerun an earlier review.</p></section>
    <section class="card saved-details" aria-label="Saved gateway"><div class="section-heading"><h2>Your saved gateway</h2><span class="quiet-badge">Token hidden</span></div><dl class="saved-values"><div><dt>Cloudflare account</dt><dd><code>${escapeHtml(status.accountId ?? "")}</code></dd></div><div><dt>Gateway name</dt><dd>${escapeHtml(status.gatewayId ?? "")}</dd></div></dl><p class="small">Settings are saved. Access and billing will be checked when a review runs.</p></section>
  `
      : "";
  return html(
    `
    <div class="intro"><p class="eyebrow">Step ${configured && !hasErrors ? "3" : "2"} of 3</p><h1>${hasErrors ? "Let’s fix your gateway details." : configured ? "Your next step: a pull request." : "Set up AI billing."}</h1><p>${hasErrors ? "Check the fields below, then save again." : configured ? "Your gateway details are saved. Let’s put Sherpa to work." : "Connect Cloudflare once to pay for AI reviews on your GitHub account."}</p></div>
    ${accountContext(installation)}
    ${message ? `<div class="notice success" role="status">${escapeHtml(message)}</div>` : ""}
    <div class="setup-grid"><div class="main-column">${saved}${configured ? `<details class="card edit-settings"${hasErrors ? " open" : ""}><summary>Update gateway or replace token</summary>${form}</details>` : `<div class="card">${form}</div>`}
      ${configured ? `<details class="help disconnect"><summary>Remove saved gateway</summary><p>Future reviews for <strong>${escapeHtml(installation.accountLogin)}</strong> will pause until you save a gateway again. This does not delete anything in Cloudflare or stop reviews already running.</p><form method="post" action="/setup/gateway">${hidden(installation, csrf)}<input type="hidden" name="action" value="clear"><button class="button danger" type="submit">Remove gateway from Sherpa</button></form></details>` : ""}
    </div><aside aria-label="About AI billing"><div class="sidebar-note"><span class="eyebrow">One setup. Every repository.</span><h2>Reviews stay in GitHub.</h2><p>This gateway pays for AI reviews across the repositories connected to Sherpa under <strong>${escapeHtml(installation.accountLogin)}</strong>.</p><hr><h3>You control AI spending</h3><p>Model usage is charged through your Cloudflare gateway. Manage your credits and usage in Cloudflare.</p><p>${external(billingHelp, "How AI billing works")}</p><hr><h3>Keep this tab open</h3><p>Cloudflare links open in a new tab, so you can copy each detail and come right back.</p></div></aside></div>
  `,
    hasErrors ? 400 : 200,
    [],
    { login, step: configured && !hasErrors ? 3 : 2 },
  );
}

export function html(
  body: string,
  status = 200,
  extraCookies: string[] = [],
  context: { login?: string; step?: number } = {},
): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  for (const value of extraCookies) headers.append("set-cookie", value);
  const content =
    status >= 400 && !context.step
      ? `<section class="card error-page">${body}<p>Return to setup to try again. If the problem continues, contact the person hosting Sherpa.</p><a href="/setup" class="button primary">Return to setup <span aria-hidden="true">→</span></a></section>`
      : body;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${context.step === 1 ? "Choose your GitHub account" : context.step === 2 ? "Set up AI billing" : context.step === 3 ? "Start your first review" : "Setup"} · Sherpa</title><style>${styles}</style></head><body><a class="skip-link" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="/setup" aria-label="Sherpa setup"><span class="brand-mark">${mark}</span>Sherpa<span class="brand-divider"></span><span class="brand-caption">Setup</span></a>${context.login ? `<div class="signed-in"><span class="online-dot" aria-hidden="true"></span><span>Signed in as <strong>${escapeHtml(context.login)}</strong></span></div>` : ""}</header><main id="main">${context.step ? progress(context.step) : ""}${content}</main><footer class="site-footer"><span>Sherpa · Thoughtful reviews, right in GitHub.</span><span>Powered by your Cloudflare AI Gateway</span></footer></body></html>`,
    { status, headers },
  );
}
