import type { Context } from "hono";
import { adminEnabled } from "../lib/admin";
import { type AppEnv } from "../lib/http";

/**
 * The operator console's shell.
 *
 * The page carries no data and no credential. It is a public empty frame: the
 * token is typed into it, kept in `sessionStorage`, and sent only on the
 * `/api/v1/admin/*` calls — so the HTML itself is not behind `requireAdmin`.
 * What it *is* behind is `adminEnabled`, for the reason spelled out in
 * lib/admin.ts: a deployment with no `ADMIN_TOKEN` should not serve a login box
 * for a console that does not exist.
 *
 * Written as one inline template rather than as a React route, and that is a
 * deliberate departure from the rest of the front end. Three reasons:
 *
 *   1. PRD 9.4 bounds the send page's bundle so it stays auditable. A console
 *      with tables, a chart and an auth flow is the largest thing in this
 *      repo's front end, and it has no business sharing a build with the page
 *      a stranger loads to send someone a file.
 *   2. Everything inline means the CSP below can refuse every external origin
 *      outright, which is the cheapest possible answer to "what if someone adds
 *      a CDN script to the admin page".
 *   3. There is exactly one reader. A console is the one screen where shipping
 *      the smallest thing that works is obviously right.
 *
 * `sessionStorage`, not `localStorage`: closing the tab should end the session.
 */
export function adminPage(c: Context<AppEnv>) {
	if (!adminEnabled(c.env)) {
		return c.json({ error: "not_found", message: "No such endpoint." }, 404);
	}
	return c.html(PAGE, 200, {
		"Cache-Control": "no-store",
		"X-Robots-Tag": "noindex, nofollow",
		"Referrer-Policy": "no-referrer",
		// Everything is inline, so nothing external needs allowing. `connect-src
		// 'self'` is what the fetches below need and the only channel open at all.
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
			"connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
	});
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Stolnk · Console</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--line:#e4e7ec;--ink:#14181f;--dim:#667085;--key:#2f5bd8;--warn:#c0362c;--good:#177245;--head:#fafbfc}
@media(prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#181c24;--line:#2a313d;--ink:#eef1f7;--dim:#98a2b3;--key:#6d8cf0;--warn:#f07168;--good:#5cc98e;--head:#141820}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 20px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
h2{font-size:13px;margin:0 0 10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.6px}
/* minmax(0,1fr), not 1fr: a grid item's default min-width is auto, so the
   devices table's min-content width would size the column and push the whole
   page wider than the viewport — taking .scroll's overflow with it. */
main{padding:20px;max-width:1100px;margin:0 auto;display:grid;gap:18px;grid-template-columns:minmax(0,1fr)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;min-width:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{background:var(--head);border:1px solid var(--line);border-radius:8px;padding:12px}
.tile b{display:block;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.4px}
.tile span{display:block;color:var(--dim);font-size:12px;margin-top:2px}
.tile.alert b{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:600;font-size:12px}
td.wrap{white-space:normal;word-break:break-word;min-width:200px}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.pill.pro{color:var(--good);border-color:var(--good)}
.pill.bad{color:var(--warn);border-color:var(--warn)}
button{font:inherit;padding:5px 11px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.key{background:var(--key);border-color:var(--key);color:#fff}
button:disabled{opacity:.5;cursor:default}
input{font:inherit;padding:7px 10px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--ink);min-width:220px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gate{max-width:400px;margin:14vh auto;text-align:center;display:grid;gap:12px}
.dim{color:var(--dim)}
.err{color:var(--warn)}
svg{display:block;width:100%;height:140px;overflow:visible}
.bar{fill:var(--key)}
@media(max-width:640px){main{padding:12px}td,th{padding:7px 6px}.scroll{overflow-x:auto}}
</style></head><body>
<div id="app"></div>
<script>
(function(){
var TOKEN = sessionStorage.getItem("stolnk.admin") || "";
var app = document.getElementById("app");

function esc(v){ return String(v == null ? "" : v).replace(/[&<>"']/g, function(ch){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]; }); }

function bytes(n){
  n = Number(n) || 0;
  var u = ["B","KB","MB","GB","TB"], i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
}
function when(ms){
  if (!ms) return "—";
  var d = Math.floor((Date.now() - ms) / 86400000);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return d + "d ago";
  return new Date(ms).toISOString().slice(0, 10);
}

async function call(path, options){
  var response = await fetch("/api/v1/admin" + path, Object.assign({
    headers: Object.assign(
      { authorization: "Bearer " + TOKEN },
      options && options.body ? { "content-type": "application/json" } : {}
    )
  }, options || {}));
  if (response.status === 401) { TOKEN = ""; sessionStorage.removeItem("stolnk.admin"); gate("That token was not accepted."); throw new Error("unauthorized"); }
  var body = await response.json().catch(function(){ return null; });
  if (!response.ok) throw new Error((body && body.message) || ("HTTP " + response.status));
  return body;
}

function gate(message){
  app.innerHTML =
    '<div class="gate"><h1>Stolnk · Console</h1>' +
    (message ? '<p class="err">' + esc(message) + "</p>" : '<p class="dim">Paste the admin token.</p>') +
    '<input id="t" type="password" autocomplete="off" placeholder="ADMIN_TOKEN">' +
    '<button class="key" id="go">Open</button></div>';
  var input = document.getElementById("t");
  var submit = function(){
    TOKEN = input.value.trim();
    if (!TOKEN) return;
    sessionStorage.setItem("stolnk.admin", TOKEN);
    load();
  };
  document.getElementById("go").onclick = submit;
  input.onkeydown = function(e){ if (e.key === "Enter") submit(); };
  input.focus();
}

function tile(value, label, alert){
  return '<div class="tile' + (alert ? " alert" : "") + '"><b>' + esc(value) + "</b><span>" + esc(label) + "</span></div>";
}

/** Bars, drawn by hand. A chart library would be the largest dependency in the repo. */
function chart(series){
  var peak = Math.max.apply(null, series.map(function(p){ return p.bytes; }).concat([1]));
  var width = 100 / series.length;
  return '<svg viewBox="0 0 100 40" preserveAspectRatio="none">' + series.map(function(p, i){
    var h = (p.bytes / peak) * 38;
    return '<rect class="bar" x="' + (i * width + width * 0.15).toFixed(3) + '" y="' + (39 - h).toFixed(3) +
      '" width="' + (width * 0.7).toFixed(3) + '" height="' + Math.max(h, p.bytes > 0 ? 0.6 : 0).toFixed(3) +
      '"><title>' + esc(p.day + " · " + p.files + " files · " + bytes(p.bytes)) + "</title></rect>";
  }).join("") + "</svg>";
}

var state = { q: "", offset: 0 };

async function load(){
  app.innerHTML = '<main><div class="card dim">Loading…</div></main>';
  var data;
  try {
    data = await Promise.all([
      call("/overview"),
      call("/usage?days=30"),
      call("/devices?limit=50&offset=" + state.offset + "&q=" + encodeURIComponent(state.q)),
      call("/billing")
    ]);
  } catch (error) {
    if (error.message !== "unauthorized") app.innerHTML = '<main><div class="card err">' + esc(error.message) + "</div></main>";
    return;
  }
  render(data[0], data[1], data[2], data[3]);
}

function render(overview, usage, devices, billing){
  var failures = overview.notification_failures;
  app.innerHTML =
    '<header><h1>Stolnk · Console</h1><div class="row">' +
      '<button id="reload">Reload</button><button id="out">Sign out</button>' +
    "</div></header><main>" +

    '<section class="card"><h2>Overview</h2><div class="tiles">' +
      tile(overview.devices.total, "devices") +
      tile(overview.devices.active_7d, "active this week") +
      tile(overview.devices.pro, "Pro") +
      tile(overview.inboxes.total + " / " + overview.inboxes.paused, "inboxes / paused") +
      tile(overview.shares.total + " / " + overview.shares.live, "links / live") +
      tile(overview.delivered.today.files + " · " + bytes(overview.delivered.today.bytes), "delivered today") +
      tile(overview.delivered.month.files + " · " + bytes(overview.delivered.month.bytes), "this month") +
      tile(bytes(overview.relay_bytes_month), "relayed this month") +
      tile(overview.waitlist, "waitlist") +
      tile(failures, "unprocessed notifications", failures > 0) +
    "</div></section>" +

    '<section class="card"><h2>Delivered, last 30 days</h2>' + chart(usage.series) +
      '<p class="dim">Peak ' + esc(bytes(Math.max.apply(null, usage.series.map(function(p){ return p.bytes; }).concat([0])))) +
      " · hover a bar for the day.</p></section>" +

    '<section class="card"><h2>Devices</h2><div class="row" style="margin-bottom:10px">' +
      '<input id="q" placeholder="filter by name" value="' + esc(state.q) + '">' +
      '<span class="dim">' + esc(devices.total) + " total</span></div>" +
      '<div class="scroll"><table><thead><tr><th>Name</th><th>Tier</th><th>Inboxes</th><th>Links</th>' +
      "<th>Relay (month)</th><th>Last seen</th><th>Joined</th><th></th></tr></thead><tbody>" +
      (devices.devices.length ? devices.devices.map(function(d){
        var granted = d.grant_status === "active";
        return "<tr><td>" + esc(d.name) + "</td>" +
          '<td><span class="pill' + (d.pro ? " pro" : "") + '">' + (d.pro ? "pro" : "free") + "</span>" +
          (granted ? ' <span class="pill" title="' + esc(d.grant_note) + '">granted</span>' : "") + "</td>" +
          "<td>" + esc(d.inboxes) + "</td><td>" + esc(d.shares) + "</td>" +
          "<td>" + esc(bytes(d.relay_bytes)) + "</td>" +
          "<td>" + esc(when(d.last_seen)) + "</td><td>" + esc(when(d.created_at)) + "</td>" +
          '<td><button data-act="' + (granted ? "revoke" : "grant") + '" data-id="' + esc(d.device_id) +
          '" data-name="' + esc(d.name) + '">' + (granted ? "Revoke" : "Grant Pro") + "</button></td></tr>";
      }).join("") : '<tr><td colspan="8" class="dim">No devices match.</td></tr>') +
      "</tbody></table></div>" +
      '<div class="row" style="margin-top:10px">' +
        '<button id="prev"' + (state.offset ? "" : " disabled") + ">Previous</button>" +
        '<button id="next"' + (state.offset + 50 < devices.total ? "" : " disabled") + ">Next</button>" +
        '<span class="dim">' + (devices.total ? (state.offset + 1) + "–" + Math.min(state.offset + 50, devices.total) : "0") + "</span>" +
      "</div></section>" +

    '<section class="card"><h2>Billing</h2><div class="tiles">' +
      billing.licenses.map(function(r){ return tile(r.n, "licences · " + r.status); }).join("") +
      billing.apple_purchases.map(function(r){ return tile(r.n, "App Store · " + r.status + " · " + r.environment); }).join("") +
      billing.admin_grants.map(function(r){ return tile(r.n, "granted · " + r.status); }).join("") +
      (billing.licenses.length || billing.apple_purchases.length || billing.admin_grants.length ? "" :
        '<div class="tile"><b>0</b><span>nothing sold yet</span></div>') +
    "</div>" +
      (billing.failed_notifications.length ?
        '<h2 style="margin-top:16px">Unprocessed App Store notifications</h2>' +
        '<p class="dim">Each of these is a refund or revocation that has not been applied.</p>' +
        '<div class="scroll"><table><thead><tr><th>Received</th><th>Type</th><th>Transaction</th><th>State</th><th>Error</th></tr></thead><tbody>' +
        billing.failed_notifications.map(function(n){
          return "<tr><td>" + esc(when(n.received_at)) + "</td>" +
            "<td>" + esc(n.notification_type) + (n.subtype ? " · " + esc(n.subtype) : "") + "</td>" +
            "<td>" + esc(n.original_transaction_id || "—") + "</td>" +
            '<td><span class="pill bad">' + esc(n.process_status) + "</span></td>" +
            '<td class="wrap">' + esc(n.last_error || "—") + "</td></tr>";
        }).join("") + "</tbody></table></div>" : "") +
    "</section></main>";

  document.getElementById("reload").onclick = load;
  document.getElementById("out").onclick = function(){
    TOKEN = ""; sessionStorage.removeItem("stolnk.admin"); gate("");
  };
  var q = document.getElementById("q");
  var timer;
  q.oninput = function(){
    clearTimeout(timer);
    timer = setTimeout(function(){ state.q = q.value.trim(); state.offset = 0; load(); }, 250);
  };
  document.getElementById("prev").onclick = function(){ state.offset = Math.max(0, state.offset - 50); load(); };
  document.getElementById("next").onclick = function(){ state.offset += 50; load(); };

  Array.prototype.forEach.call(document.querySelectorAll("button[data-act]"), function(button){
    button.onclick = async function(){
      var act = button.getAttribute("data-act");
      var name = button.getAttribute("data-name");
      var note = prompt(
        act === "grant" ? "Why is " + name + " getting Pro?" : "Why is " + name + "'s grant being taken back?"
      );
      if (note === null) return;
      note = note.trim();
      if (!note) { alert("A reason is required."); return; }
      button.disabled = true;
      try {
        await call("/devices/" + encodeURIComponent(button.getAttribute("data-id")) + "/" + act,
          { method: "POST", body: JSON.stringify({ note: note }) });
        load();
      } catch (error) {
        if (error.message !== "unauthorized") { alert(error.message); button.disabled = false; }
      }
    };
  });
}

if (TOKEN) load(); else gate("");
})();
</script></body></html>`;
