// The authorize pages (comprehensive desk design section 4): email, code,
// consent and message, as plain HTML in the workspace's email look
// (src/server/email/layout.ts), so they render the same in every chat app's
// sign-in window. Every dynamic value is escaped; the consent page shows
// what the MCP spec asks for: the app's name (verified domain, or
// "not verified"), where access is sent, a warning for local apps, the
// workspace and the role. Headers: no-store, never framed, a strict CSP
// whose form-action also allows the app's redirect origin (Chrome applies
// form-action to the redirect after the consent form). Relative imports
// only.

import { roleLabel } from "../../lib/roles";
import type { AiClient } from "../../lib/via";
import { escapeHtml as e } from "../../server/email/escape";
import type { Look } from "../../server/email/layout";
import { GRANT_TTL_DAYS } from "../constants";
import type { ConnectableWorkspace } from "./access";

export type PageContext = { look: Look; clientLabel: string; action: string };

export type ConsentFacts = {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  client: AiClient;
};

function css(look: Look): string {
  return `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: ${look.background}; color: ${look.ink}; font-family: ${look.bodyFont}; font-size: 16px; line-height: 1.5; display: flex; justify-content: center; align-items: flex-start; padding: 48px 16px; }
.card { width: 100%; max-width: 440px; background: #ffffff; border: 1px solid ${look.line}; border-radius: ${look.cardRadius}px; padding: 28px 24px; }
.brand { margin: 0 0 20px; font-family: ${look.headingFont}; font-weight: 700; font-size: 18px; }
.brand img { display: block; height: 32px; width: auto; max-width: 100%; }
h1 { font-family: ${look.headingFont}; font-size: 22px; line-height: 1.25; margin: 0 0 10px; }
p { margin: 0 0 14px; }
.muted { color: ${look.muted}; font-size: 14px; }
.error { color: #b42318; font-weight: 600; }
.warn { border-left: 4px solid #b54708; padding: 8px 12px; background: #fffaeb; color: #7a2e0e; border-radius: 4px; }
label { display: block; font-weight: 600; margin: 0 0 6px; }
input[type=email], input[type=text], select { width: 100%; min-height: 44px; font-size: 16px; padding: 10px 12px; border: 1px solid ${look.muted}; border-radius: 8px; background: #ffffff; color: ${look.ink}; font-family: inherit; }
input[inputmode=numeric] { letter-spacing: 6px; font-size: 22px; font-family: ui-monospace, Menlo, Consolas, monospace; }
fieldset { border: 0; padding: 0; margin: 16px 0; }
legend { padding: 0; margin: 0 0 8px; }
.choice { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; min-height: 44px; margin: 0 0 6px; }
.choice input { width: 20px; height: 20px; margin: 2px 0 0; flex: none; }
ul { margin: 0 0 14px; padding-left: 20px; }
li { margin: 0 0 6px; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
button { min-height: 44px; padding: 10px 20px; font-size: 16px; font-weight: 700; border-radius: ${look.buttonRadius}px; border: 1px solid transparent; cursor: pointer; font-family: inherit; }
.primary { background: ${look.primary}; color: ${look.buttonText}; }
.secondary { background: transparent; color: ${look.ink}; border-color: ${look.muted}; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid ${look.ink}; outline-offset: 2px; }
a { color: inherit; }
@media (prefers-color-scheme: dark) {
  body { background: #0f1214; color: #eef1ef; }
  .card { background: #171b1f; border-color: #2c3339; }
  .muted { color: #b9c1c7; }
  .error { color: #ffa198; }
  .warn { background: #2b2111; color: #ffd8a8; border-left-color: #f79009; }
  input[type=email], input[type=text], select { background: #0f1214; color: #eef1ef; border-color: #5b656e; }
  .secondary { color: #eef1ef; border-color: #5b656e; }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline-color: #eef1ef; }
}`;
}

function layout(look: Look, title: string, body: string): string {
  const brand = look.logoUrl ? `<img src="${e(look.logoUrl)}" alt="${e(look.name)}">` : e(look.name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)}</title><style>${css(look)}</style></head><body><main class="card"><div class="brand">${brand}</div>${body}</main></body></html>`;
}

function errorLine(error: string | undefined): string {
  return error ? `<p class="error" role="alert">${e(error)}</p>` : "";
}

export function emailPage(ctx: PageContext, opts: { error?: string; email?: string } = {}): string {
  const title = `Connect ${ctx.clientLabel} to ${ctx.look.name}`;
  return layout(
    ctx.look,
    title,
    `<h1>${e(title)}</h1>
<p>Enter the email you use for Ordering Desk. We will send you a 6-digit code.</p>
${errorLine(opts.error)}
<form method="post" action="${e(ctx.action)}">
<input type="hidden" name="step" value="email">
<label for="email">Work email</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="254" required autofocus value="${e(opts.email ?? "")}">
<div class="actions"><button class="primary" type="submit">Send code</button></div>
</form>
<p class="muted">New to Ordering Desk? Sign in to the website once first.</p>`,
  );
}

export function codePage(ctx: PageContext, opts: { handle: string; email: string; error?: string }): string {
  return layout(
    ctx.look,
    "Enter your code",
    `<h1>Enter your code</h1>
<p>If ${e(opts.email)} can use Ordering Desk here, a 6-digit code is on its way. It expires in 10 minutes.</p>
${errorLine(opts.error)}
<form method="post" action="${e(ctx.action)}">
<input type="hidden" name="step" value="code">
<input type="hidden" name="handle" value="${e(opts.handle)}">
<input type="hidden" name="email" value="${e(opts.email)}">
<label for="code">Code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
<div class="actions"><button class="primary" type="submit">Continue</button></div>
</form>
<p class="muted"><a href="${e(ctx.action)}">Use a different email</a></p>`,
  );
}

function workspacePart(workspaces: ConnectableWorkspace[], everyWorkspace: boolean): string {
  if (everyWorkspace) {
    const names = workspaces.map((entry) => e(entry.name)).join(", ");
    return `<p>Workspaces: <strong>every workspace with AI connections on</strong>, now ${names}, and any turned on later. You connect as <strong>Platform admin</strong> in each, with the same rules as in the app. Each request names the workspace; a workspace with AI connections off is refused.</p>`;
  }
  if (workspaces.length === 1) {
    const only = workspaces[0];
    return `<input type="hidden" name="workspace" value="${e(only.id)}">
<p>Workspace: <strong>${e(only.name)}</strong>. You connect as <strong>${e(roleLabel(only.role))}</strong>, with the same rules as in the app.</p>`;
  }
  const options = workspaces.map((entry) => `<option value="${e(entry.id)}">${e(entry.name)} (${e(roleLabel(entry.role))})</option>`).join("");
  return `<label for="workspace">Workspace</label>
<select id="workspace" name="workspace" required>${options}</select>
<p class="muted">You connect with your role in that workspace, with the same rules as in the app. For another workspace, connect again.</p>`;
}

export function consentPage(
  ctx: PageContext,
  opts: { handle: string; signin: string; consent: ConsentFacts; workspaces: ConnectableWorkspace[]; everyWorkspace?: boolean },
): string {
  const { consent } = opts;
  const label = e(ctx.clientLabel);
  const publisher = consent.clientDomain
    ? `Published by <strong>${e(consent.clientDomain)}</strong>.`
    : `This app registered itself as "${e(consent.clientName.slice(0, 80))}"; that name is not verified.`;
  const local = consent.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on this computer. Continue only if you just started connecting from it.</p>`
    : "";
  return layout(
    ctx.look,
    `Allow ${ctx.clientLabel}?`,
    `<h1>Allow ${label} to work in Ordering Desk as you?</h1>
<p>${publisher} Access will be sent to <strong>${e(consent.redirectHost)}</strong>.</p>
${local}
<form method="post" action="${e(ctx.action)}">
<input type="hidden" name="step" value="consent">
<input type="hidden" name="handle" value="${e(opts.handle)}">
<input type="hidden" name="signin" value="${e(opts.signin)}">
${workspacePart(opts.workspaces, opts.everyWorkspace ?? false)}
<fieldset><legend><strong>What ${label} may do</strong></legend>
<label class="choice"><input type="radio" name="access" value="change" checked><span>Look things up and make changes. Every change is shown to you first and happens only when you confirm it in the chat.</span></label>
<label class="choice"><input type="radio" name="access" value="read"><span>Look things up only.</span></label>
</fieldset>
<ul>
<li>It can find requests, orders, people and locations.</li>
<li>Changes follow your role: staff change statuses and add notes; managers also approve, reject, cancel, edit and place requests.</li>
<li>Every change says "via ${label}" in the timeline, and daily limits apply.</li>
<li>This connection lasts ${GRANT_TTL_DAYS} days, then you connect again. You can revoke it any time in Settings &gt; AI connections.</li>
</ul>
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Allow</button><button class="secondary" type="submit" name="decision" value="deny">Deny</button></div>
</form>`,
  );
}

export function messagePage(look: Look, opts: { title: string; message: string }): string {
  return layout(look, opts.title, `<h1>${e(opts.title)}</h1><p>${e(opts.message)}</p><p class="muted">You can close this window.</p>`);
}

export function pageHeaders(opts: { formTargets: string[]; imageOrigin: string | null; base?: Headers }): Headers {
  const headers = new Headers(opts.base);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  const images = opts.imageOrigin ? ` ${opts.imageOrigin}` : "";
  const targets = opts.formTargets.length > 0 ? ` ${opts.formTargets.join(" ")}` : "";
  // append, not set: a policy the OAuth library sent stays in force too.
  headers.append(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'${images}; form-action 'self'${targets}; frame-ancestors 'none'; base-uri 'none'`,
  );
  return headers;
}
