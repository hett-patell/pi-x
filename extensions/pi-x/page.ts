/**
 * Code that runs INSIDE the logged-in x.com page (via `agent-browser eval`).
 * Keep it plain ES5-ish JS in a String.raw literal: no "${", no backticks.
 * It discovers query IDs / feature flags / bearer from x.com's own main bundle,
 * calls X's internal API with the page's cookies, and offers DOM fallbacks.
 */

export type DomFn = "classify" | "tweets" | "trends" | "count";

export type PageRequest =
	| { kind: "graphql"; op: string; vars: Record<string, unknown>; method?: "GET" | "POST" }
	| { kind: "rest"; path: string }
	| { kind: "discover"; refresh?: boolean }
	| { kind: "dom"; fn: DomFn };

export interface RateLimit {
	limit: number;
	remaining: number;
	reset: number;
}

export interface PageResponse {
	ok: boolean;
	status: number;
	data?: unknown;
	error?: string;
	rateLimit?: RateLimit | null;
}

export interface Classify {
	url: string;
	wall: boolean;
	locked: boolean;
	app: boolean;
	loggedIn: boolean;
}

export interface DiscoverInfo {
	ops: string[];
	bearer: boolean;
	ct0: boolean;
	error: string | null;
}

export const PAGE_RUNTIME = String.raw`async function (req) {
  var W = window;
  function strs(s) { return (s.match(/"([^"]+)"/g) || []).map(function (x) { return x.slice(1, -1); }); }
  function ct0() { var m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/); return m ? m[1] : null; }
  function hasTwid() { return /(?:^|;\s*)twid=/.test(document.cookie); }
  async function discover(force) {
    if (W.__pix && !force) return W.__pix;
    var srcs = [].slice.call(document.scripts).map(function (s) { return s.src || ""; });
    var main = srcs.filter(function (s) { return /\/main\.[^\/]*\.js/.test(s); })[0];
    if (!main) return { ops: {}, bearer: null, error: "main bundle script not found" };
    var js = await (await fetch(main)).text();
    var ops = {}, m;
    var re = /queryId:"([^"]+)",operationName:"([^"]+)",operationType:"(\w+)",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]/g;
    while ((m = re.exec(js))) ops[m[2]] = { id: m[1], type: m[3], features: strs(m[4]), toggles: strs(m[5]) };
    var b = js.match(/"(AAAAAAAAAAAAAAAAAAAAA[^"]+)"/);
    var res = { ops: ops, bearer: b ? decodeURIComponent(b[1]) : null, error: null };
    if (Object.keys(ops).length) W.__pix = res;
    return res;
  }
  async function api(path, method, body) {
    var d = await discover(false);
    var t = ct0();
    if (!t) return { ok: false, status: 0, error: "not_logged_in: no ct0 cookie in this browser profile" };
    if (!d.bearer) return { ok: false, status: 0, error: "api_changed: bearer token not found in main bundle" };
    var h = { authorization: "Bearer " + d.bearer, "x-csrf-token": t, "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes", "x-twitter-client-language": document.documentElement.lang || "en" };
    if (body) h["content-type"] = "application/json";
    var r = await fetch(path, { method: method, headers: h, body: body, credentials: "include" });
    var text = await r.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    var rem = r.headers.get("x-rate-limit-remaining");
    return { ok: r.ok, status: r.status, data: data, error: r.ok ? undefined : String(text || "").slice(0, 300),
      rateLimit: rem == null ? null : { limit: Number(r.headers.get("x-rate-limit-limit")), remaining: Number(rem), reset: Number(r.headers.get("x-rate-limit-reset")) } };
  }
  function flags(keys, v) { var o = {}; keys.forEach(function (k) { o[k] = v; }); return o; }
  function callOp(o, op, vars, method) {
    var f = flags(o.features, true), t = flags(o.toggles, false);
    var path = "/i/api/graphql/" + o.id + "/" + op;
    if ((method || (o.type === "mutation" ? "POST" : "GET")) === "POST")
      return api(path, "POST", JSON.stringify({ variables: vars, features: f, fieldToggles: t, queryId: o.id }));
    return api(path + "?variables=" + encodeURIComponent(JSON.stringify(vars)) + "&features=" + encodeURIComponent(JSON.stringify(f)) +
      "&fieldToggles=" + encodeURIComponent(JSON.stringify(t)), "GET");
  }
  async function graphql(op, vars, method) {
    var d = await discover(false);
    var o = d.ops[op];
    if (!o) { d = await discover(true); o = d.ops[op]; }
    if (!o) return { ok: false, status: 0, error: "api_changed: operation " + op + " not found in main bundle" };
    var res = await callOp(o, op, vars, method);
    if (res.status === 404) {
      d = await discover(true); o = d.ops[op];
      if (o) res = await callOp(o, op, vars, method);
    }
    return res;
  }
  var DOM = {
    classify: function () {
      var p = location.pathname || "";
      return { url: location.href, wall: /^\/(login|i\/flow\/login|account\/access)/.test(p), locked: /^\/account\/access/.test(p),
        app: !!document.querySelector("#react-root"), loggedIn: hasTwid() && !!ct0() };
    },
    count: function () { return document.querySelectorAll('article[data-testid="tweet"]').length; },
    tweets: function () {
      var out = [];
      document.querySelectorAll('article[data-testid="tweet"]').forEach(function (a) {
        var timeEl = a.querySelector("time");
        var link = timeEl && timeEl.closest ? timeEl.closest("a") : null;
        if (!link) link = a.querySelector('a[href*="/status/"]');
        var mm = (link ? link.getAttribute("href") || "" : "").match(/^\/([^\/]+)\/status\/(\d+)/);
        if (!mm) return;
        function label(id) { var el = a.querySelector('[data-testid="' + id + '"]'); return el ? (el.getAttribute("aria-label") || el.textContent || "") : ""; }
        var views = a.querySelector('a[href$="/analytics"]');
        var textEl = a.querySelector('[data-testid="tweetText"]');
        var media = [];
        a.querySelectorAll('img[src*="/media/"]').forEach(function (i) { media.push(i.getAttribute("src")); });
        out.push({ id: mm[2], handle: mm[1], text: textEl ? textEl.innerText : "", lang: textEl ? textEl.getAttribute("lang") : null,
          time: timeEl ? timeEl.getAttribute("datetime") : null, verified: !!a.querySelector('[data-testid="icon-verified"]'),
          labels: { reply: label("reply"), retweet: label("retweet") || label("unretweet"), like: label("like") || label("unlike"),
            bookmark: label("bookmark") || label("removeBookmark"), views: views ? views.getAttribute("aria-label") || "" : "" },
          media: media });
      });
      return out;
    },
    trends: function () {
      var out = [];
      document.querySelectorAll('[data-testid="trend"]').forEach(function (c) {
        out.push(String(c.innerText || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean));
      });
      return out;
    }
  };
  try {
    if (req.kind === "discover") {
      var d0 = await discover(!!req.refresh);
      return { ok: !!d0.bearer && Object.keys(d0.ops).length > 0, status: 200,
        data: { ops: Object.keys(d0.ops), bearer: !!d0.bearer, ct0: !!ct0(), error: d0.error } };
    }
    if (req.kind === "graphql") return await graphql(req.op, req.vars, req.method);
    if (req.kind === "rest") return await api(req.path, "GET");
    if (req.kind === "dom") return { ok: true, status: 200, data: DOM[req.fn]() };
    return { ok: false, status: 0, error: "invalid_input: unknown request kind" };
  } catch (e) {
    return { ok: false, status: 0, error: "network: " + (e && e.message ? e.message : String(e)) };
  }
}`;

export function pageScript(req: PageRequest): string {
	return `(${PAGE_RUNTIME})(${JSON.stringify(req)})`;
}
