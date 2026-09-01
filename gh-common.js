/* ══════════════════════════════════════════════════════════════════════════
   gh-common.js - shared foundation for Bart's UIs.

   Loaded as a plain classic script before each dashboard's own inline script,
   so everything declared here is a global the page can use directly. No build
   step, no modules: these are static files on GitHub Pages.

   Owns:
     - storage that degrades instead of throwing
     - one token, one token screen, one sign-in flow for every dashboard
     - the GitHub API layer (paging, retry, timeouts)
     - shared repo/branch lookups with a session cache
     - the Combobox
     - escaping and formatting helpers

   Anything page-specific stays in the page.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   Storage

   Storage access throws outright in a sandboxed iframe and under some
   enterprise privacy settings - not just on write, but on the very first
   property access. Every read and write goes through here so that a blocked
   Storage degrades to an in-memory map for the tab instead of taking the
   whole page down on the first line of init.
   ══════════════════════════════════════════════════════════════════════════ */
const memStore = { local: {}, session: {} };
const store = {
  _area(session) {
    /* Touching the property is itself what throws, so it has to be guarded. */
    try { return (session ? window.sessionStorage : window.localStorage) || null; }
    catch (e) { return null; }
  },
  get(k, session = false) {
    /* The in-memory copy wins when it exists.

       A key only lands in `memStore` because a write to the real Storage
       failed, so it is by definition newer than whatever is still sitting in
       that Storage. Reading the area first looked equivalent and was not: when
       Storage is present but over quota, `setItem` throws and the value goes to
       memory, while `getItem` keeps happily returning the older value it
       already held. The fallback was write-only, so the tab would read stale
       data for the rest of its life and every attempt to replace it would
       appear to do nothing. */
    const m = session ? memStore.session : memStore.local;
    if (Object.prototype.hasOwnProperty.call(m, k)) return m[k];
    const a = this._area(session);
    if (a) { try { return a.getItem(k); } catch (e) { /* fall through */ } }
    return null;
  },
  set(k, v, session = false) {
    const a = this._area(session);
    if (a) {
      try {
        a.setItem(k, v);
        /* Persisted, so any shadow copy from an earlier failed write is now
           stale and has to go, or `get` would keep preferring it. */
        delete (session ? memStore.session : memStore.local)[k];
        return true;
      } catch (e) { /* quota or blocked */ }
    }
    (session ? memStore.session : memStore.local)[k] = v;
    return false;                       // caller may want to know it did not persist
  },
  del(k, session = false) {
    const a = this._area(session);
    if (a) { try { a.removeItem(k); } catch (e) { /* ignore */ } }
    delete (session ? memStore.session : memStore.local)[k];
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════════════ */

/* The only safe way to put untrusted text into an innerHTML template. Applies
   to anything that came off the network: commit messages, branch names, PR
   titles, label names, and any org/repo that arrived via a shared link. */
function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Single-quote a value for POSIX sh. Branch and repository names may contain
   $, backticks, quotes and semicolons - all legal in a git ref - and the
   generated scripts are meant to be pasted into a shell. */
function shellQuote(v) {
  return "'" + String(v === null || v === undefined ? '' : v).replace(/'/g, `'\\''`) + "'";
}

/* GitHub path segments. Owner/repo/branch are never interpolated raw. */
function seg(v) { return encodeURIComponent(String(v === null || v === undefined ? '' : v)); }

/* Owner and repository names as GitHub actually defines them. Used to reject
   anything arriving from a shared link before it reaches a DOM sink. */
const GH_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
function isGhName(v) { return GH_NAME_RE.test(String(v === null || v === undefined ? '' : v)); }

/* base64 <-> UTF-8. `atob` alone yields a binary string, which mangles any
   non-ASCII character; `escape`/`unescape` are deprecated. */
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function b64DecodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* Titles often carry a trailing "(#1234)" that the UI shows separately. */
function stripPrSuffix(title) {
  return String(title || '').replace(/(\s*\(#\d+\))+\s*$/, '').trim() || String(title || '');
}

function relTime(iso) {
  if (!iso) return 'unknown';
  const then = new Date(iso).getTime();
  if (!then) return 'unknown';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}d ago`;
  const months = Math.round(days / 30.44);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

/* ── CSV ──────────────────────────────────────────────────────────────────
   RFC 4180 quoting, plus formula-injection neutralisation.

   Excel, LibreOffice and Google Sheets all evaluate a cell beginning with =, +,
   -, @, tab or CR as a formula, and quoting does not prevent it: the parser
   strips the quotes first. Everything these dashboards export came off the
   network - pull request titles, label names, commit subjects, logins - and a
   pull request title is controlled by anyone who can open one against a watched
   repository. `=WEBSERVICE(...)` in Excel and `=IMPORTXML(...)` in Sheets both
   fetch a URL, which would turn "export the board" into an exfiltration step.

   The leading apostrophe is the standard defence: spreadsheets treat the rest of
   the cell as literal text and do not display the apostrophe itself. */
function csvCell(value) {
  let v = String(value === null || value === undefined ? '' : value);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/* Rows of cells to a CSV Blob. The BOM is what makes Excel read it as UTF-8
   rather than as the local codepage. */
function toCsvBlob(rows) {
  return new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')],
                  { type: 'text/csv;charset=utf-8' });
}

/* Save a Blob under a filename, without leaking the object URL. */
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/* Bound a number arriving from stored config or a shared link. Anything that is
   not a finite number becomes the fallback rather than 0, so a missing field and
   a deliberate zero stay distinguishable. */
function clampInt(v, lo, hi, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    ok ? resolve() : reject(new Error('copy failed'));
  });
}

let _toastTimer = null;
function toast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.remove(), 3200);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════════════════
   Shared app state

   Declared here rather than in each page, so both dashboards agree on what
   "signed in" means. Pages are free to hang their own fields off `app`.
   ══════════════════════════════════════════════════════════════════════════ */
const app = {
  token: '',
  username: '',
  orgs: [],
  remember: false,
  connecting: false,      // a cached view may be up before sign-in finishes
};

/* ══════════════════════════════════════════════════════════════════════════
   GitHub API

   No attempt is made to track how much of the rate limit is left. GitHub
   reports it per resource, browser and CDN caching mean a request is not
   always a charge, and responses from concurrent requests arrive out of the
   order they were counted in - so any single number shown to the user was
   more often misleading than useful. What remains is per-response handling:
   a 403 or 429 that says how long to wait is retried once, and anything else
   surfaces as an error on the row that caused it.
   ══════════════════════════════════════════════════════════════════════════ */
const GH_API = 'https://api.github.com';

/* A request that never settles is worse than one that fails: the caller's
   await never returns, so any loop around it stalls forever. Navigating away
   and coming back through the back/forward cache produces exactly that. */
const REQUEST_TIMEOUT_MS = 30000;

/* Aborting via AbortController only helps if fetch honours the signal. A
   frozen or restored page can leave a request that never settles at all, so
   the timeout races the promise directly: the await is guaranteed to finish
   one way or the other, and the abort is still fired to release the socket. */
function withTimeout(promise, ms, ctl, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (ctl) { try { ctl.abort(); } catch (e) { /* already gone */ } }
      const err = new Error(`Timed out after ${Math.round(ms / 1000)}s waiting for GitHub${what ? ' (' + what + ')' : ''}.`);
      err.status = 0;
      err.timeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* How long to wait before one retry, or null if retrying is pointless. */
function retryDelayMs(res) {
  const ra = res.headers.get('retry-after');
  if (ra !== null) {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return Math.min(s, 60) * 1000;
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset)) {
      const ms = reset * 1000 - Date.now();
      if (ms > 0 && ms <= 60000) return ms;
    }
  }
  return null;
}

async function ghGet(token, path, params = {}) {
  const url = new URL(GH_API + path);
  /* per_page first so an explicit caller value still wins. */
  Object.entries({ per_page: 100, ...params }).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    let r, body;
    try {
      r = await withTimeout(fetch(url, {
        /* GitHub sends `cache-control: public, max-age=60`, so without this
           the browser answers a repeat request from its own cache and a
           Refresh can hand back data up to a minute old. Pressing Refresh
           should mean refresh. `no-cache` still allows a conditional request,
           so the body is only re-sent when it actually changed. */
        cache: 'no-cache',
        signal: ctl.signal,
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }), REQUEST_TIMEOUT_MS, ctl, path);
      if (r.ok) return await withTimeout(r.json(), REQUEST_TIMEOUT_MS, ctl, path);
      body = await withTimeout(r.json(), REQUEST_TIMEOUT_MS, ctl, path).catch(() => ({}));
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const err = new Error('Request was aborted.');
        err.status = 0; err.timeout = true;
        throw err;
      }
      throw e;
    }

    /* 403 and 429 are how GitHub signals both primary and secondary rate
       limits. One bounded retry, only when it tells us how long to wait. */
    if ((r.status === 403 || r.status === 429) && attempt < 1) {
      const wait = retryDelayMs(r);
      if (wait !== null) { await sleep(wait); continue; }
    }

    const err = new Error(body.message || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
}

/* Marks the returned array with a non-enumerable `truncated` flag when paging
   stopped at maxPages rather than at the end of the data, so callers can say
   so instead of silently presenting a partial answer as a complete one. */
function markTruncated(arr, truncated) {
  Object.defineProperty(arr, 'truncated', { value: truncated, enumerable: false, configurable: true });
  return arr;
}

/* `onPage(pageNumber, itemsSoFar)` fires after each page so a caller can show
   progress. Paging through a long history is the slowest thing either
   dashboard does, and it is the part users most need feedback on. */
async function ghGetAll(token, path, params = {}, maxPages = 10, onPage = null) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await ghGet(token, path, { ...params, page });
    if (!Array.isArray(d)) return markTruncated(all, false);
    all.push(...d);
    if (onPage) onPage(page, all.length);
    if (d.length < 100) return markTruncated(all, false);
  }
  return markTruncated(all, true);
}

/* Search API: results live under `.items`, and GitHub caps the total at 1,000
   however many pages are requested.

   `sort` and `order` matter more than they look. The endpoint defaults to
   best-match relevance, and for a query made entirely of qualifiers - no
   free-text term at all, which is every query this suite sends - relevance is
   not a defined order. A result set that then stops at `maxPages` keeps an
   arbitrary slice rather than the newest one, while the caller goes on to sort
   what it received by date and present it as "the most recent N". Asking for the
   ordering explicitly is what makes that claim true. */
async function ghSearchIssues(token, q, maxPages = 10, onPage = null,
                              sort = 'created', order = 'desc') {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await ghGet(token, '/search/issues',
                          { q, page, advanced_search: 'true', sort, order });
    const items = d.items || [];
    all.push(...items);
    /* total_count is the whole match set, so it doubles as a denominator. */
    if (onPage) onPage(page, all.length, typeof d.total_count === 'number' ? d.total_count : null);
    if (items.length < 100) return markTruncated(all, false);
    if (typeof d.total_count === 'number' && all.length >= d.total_count) return markTruncated(all, false);
  }
  return markTruncated(all, true);
}

/* Bounded-concurrency map, so a large refresh doesn't fire every request at
   once and trip the secondary rate limiter. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* GraphQL, for the few things the REST API does not expose. It draws on its
   own budget, separate from the REST one. Errors are the caller's to handle:
   every current use is best-effort enrichment that must not fail a refresh. */
async function ghGraphQL(token, query, variables = {}) {
  const ctl = new AbortController();
  let r;
  try {
    r = await withTimeout(fetch(GH_API + '/graphql', {
      method: 'POST',
      cache: 'no-store',
      signal: ctl.signal,
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ query, variables }),
    }), REQUEST_TIMEOUT_MS, ctl, 'graphql');
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Request was aborted.');
    throw e;
  }
  const body = await withTimeout(r.json(), REQUEST_TIMEOUT_MS, ctl, 'graphql').catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.message || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  if (body.errors && body.errors.length) {
    throw new Error(body.errors.map(x => x.message).filter(Boolean).join('; ') || 'GraphQL error');
  }
  return body.data;
}


/* ══════════════════════════════════════════════════════════════════════════
   Repository and branch lookups

   Cached per session and shared across dashboards and across rows, because
   both tools ask the same questions repeatedly and these lists are large.
   ══════════════════════════════════════════════════════════════════════════ */
const repoCache = new Map();     // org        -> Promise<string[]>
const branchCache = new Map();   // org/repo   -> Promise<string[]>

async function fetchRepoNames(org) {
  /* `affiliation=owner` matters: the default also returns organization-owned
     repositories, whose names are then unreachable under the user's own
     namespace and 404 the moment one is picked. */
  if (org === app.username) {
    const d = await ghGetAll(app.token, '/user/repos', { affiliation: 'owner' }, 10);
    return d.map(r => r.name);
  }
  try {
    const d = await ghGetAll(app.token, `/orgs/${seg(org)}/repos`, { type: 'all' }, 10);
    return d.map(r => r.name);
  } catch (e) {
    if (e.status !== 404) throw e;
    /* Not an organization - it may be another user's account. */
    const d = await ghGetAll(app.token, `/users/${seg(org)}/repos`, { type: 'all' }, 10);
    return d.map(r => r.name);
  }
}

function listRepos(org) {
  if (!app.token) return Promise.reject(new Error('Not signed in yet.'));
  if (!repoCache.has(org)) {
    const p = fetchRepoNames(org).then(names => names.sort((a, b) => a.localeCompare(b)));
    p.catch(() => {});                       // a rejection is handled by the caller
    repoCache.set(org, p);
  }
  return repoCache.get(org);
}

function listBranches(org, repo) {
  if (!app.token) return Promise.reject(new Error('Not signed in yet.'));
  const key = `${org}/${repo}`;
  if (!branchCache.has(key)) {
    const p = ghGetAll(app.token, `/repos/${seg(org)}/${seg(repo)}/branches`, {}, 10)
      .then(d => d.map(b => b.name).sort((a, b) => a.localeCompare(b)));
    p.catch(() => {});
    branchCache.set(key, p);
  }
  return branchCache.get(key);
}

function clearLookupCaches() { repoCache.clear(); branchCache.clear(); }

/* ══════════════════════════════════════════════════════════════════════════
   Combobox

   Free-text friendly: a restrictive fine-grained token often cannot enumerate
   organizations or repositories, and typing an exact name has to keep working
   when the dropdown is empty.
   ══════════════════════════════════════════════════════════════════════════ */
let _comboSeq = 0;

class Combobox {
  constructor({ onChange, placeholder = '', disabled = false, allowFree = true, label = '' } = {}) {
    this.onChange  = onChange || (() => {});
    this.allowFree = allowFree;
    this._options  = [];
    this._value    = '';
    this._open     = false;
    this._active   = -1;
    this._id       = 'ghcb' + (++_comboSeq);

    this.wrap = document.createElement('div');
    this.wrap.className = 'gh-combo';

    this.input = document.createElement('input');
    this.input.className = 'gh-combo-input';
    this.input.type = 'text';
    this.input.placeholder = placeholder;
    this.input.disabled = disabled;
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-controls', this._id);
    if (label) this.input.setAttribute('aria-label', label);

    this.dropdown = document.createElement('ul');
    this.dropdown.className = 'gh-combo-list';
    this.dropdown.id = this._id;
    this.dropdown.setAttribute('role', 'listbox');

    this.wrap.append(this.input, this.dropdown);

    /* Kept as a field so destroy() can take it off the document again. */
    this._onDocDown = e => {
      if (!this.wrap.contains(e.target)) this._close();
    };
    document.addEventListener('mousedown', this._onDocDown);
    this._bind();
  }

  get el() { return this.wrap; }

  setOptions(opts) { this._options = opts || []; if (this._open) this._render(); }
  setValue(v)      { this._value = v || ''; this.input.value = v || ''; }
  getValue()       { return this._value; }
  setPlaceholder(p) { this.input.placeholder = p; }
  setDisabled(d) {
    this.input.disabled = d;
    if (d) this._close();
  }

  /* Every instance holds a document-level listener; a component that is
     thrown away without this leaks both the listener and the detached
     subtree it closes over. */
  destroy() {
    document.removeEventListener('mousedown', this._onDocDown);
    this._close();
    this.wrap.remove();
  }

  _close() {
    this._open = false;
    this._active = -1;
    this.dropdown.style.display = 'none';
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  _filtered() {
    const t = this.input.value.trim().toLowerCase();
    return t ? this._options.filter(o => o.toLowerCase().includes(t)) : this._options;
  }

  _render() {
    this.dropdown.innerHTML = '';
    const items = this._filtered().slice(0, 300);
    if (!items.length || !this._open) { this._close(); return; }
    if (this._active >= items.length) this._active = items.length - 1;
    items.forEach((opt, i) => {
      const li = document.createElement('li');
      li.className = 'gh-combo-opt' + (i === this._active ? ' active' : '');
      li.id = `${this._id}-o${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', opt === this._value ? 'true' : 'false');
      li.textContent = opt;
      li.addEventListener('mousedown', e => { e.preventDefault(); this._pick(opt); });
      this.dropdown.appendChild(li);
    });
    this.dropdown.style.display = 'block';
    this.input.setAttribute('aria-expanded', 'true');
    if (this._active >= 0) {
      this.input.setAttribute('aria-activedescendant', `${this._id}-o${this._active}`);
      const el = this.dropdown.children[this._active];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  _pick(opt) {
    this._value = opt;
    this.input.value = opt;
    this._close();
    this.onChange(opt);
  }

  /* Commit whatever was typed, even when it matches no option. */
  _commitFree() {
    const raw = this.input.value.trim();
    if (!this.allowFree || raw === this._value) return;
    this._value = raw;
    this.onChange(raw);
  }

  _bind() {
    const open = () => { this._open = true; this._render(); };
    this.input.addEventListener('focus', open);
    this.input.addEventListener('click', open);
    this.input.addEventListener('input', () => { this._open = true; this._active = -1; this._render(); });
    this.input.addEventListener('blur', () => { this._close(); this._commitFree(); });
    this.input.addEventListener('keydown', e => {
      const items = this._filtered().slice(0, 300);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!this._open) { this._open = true; }
        if (items.length) { this._active = (this._active + 1) % items.length; this._render(); }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) { this._active = (this._active - 1 + items.length) % items.length; this._render(); }
        return;
      }
      if (e.key === 'Enter') {
        if (this._active >= 0 && items[this._active]) { this._pick(items[this._active]); return; }
        const exact = items.find(o => o.toLowerCase() === this.input.value.trim().toLowerCase());
        if (exact) this._pick(exact);
        else if (this.allowFree) { this._close(); this._commitFree(); }
        else if (items[0]) this._pick(items[0]);
        return;
      }
      if (e.key === 'Escape') { this._close(); }
    });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Authentication

   One token for the whole suite. Signing in to any dashboard signs you in to
   the others, which is the point of hosting them together.

   The token is kept in sessionStorage by default and only reaches
   localStorage when the viewer explicitly opts in, because the realistic bad
   day is a shared or lab machine rather than a network attacker.
   ══════════════════════════════════════════════════════════════════════════ */
const PAT_KEY      = 'gh_uis_pat';
const REMEMBER_KEY = 'gh_uis_remember';

/* Per-dashboard keys that predate the shared one. */
const LEGACY_PAT_KEYS = ['gh_pr_tracker_pat', 'gh_branch_compare_pat'];

/* Everything this suite writes. "Forget token" clears all of it, not just the
   credential: the caches hold private repository names, unreleased branch
   names, reviewer logins and their verdicts. */
const OWNED_KEYS = [
  PAT_KEY, REMEMBER_KEY,
  ...LEGACY_PAT_KEYS, 'gh_pr_tracker_remember',
  'gh_pr_tracker_config',
  'gh_pr_tracker_review_cache_v1',
  'gh_pr_tracker_reviews_v2',
  'gh_pr_tracker_commit_dates_v1',
  'gh_pr_tracker_results_v1',
  'gh_pr_tracker_imported_hash',
  /* The comparator's remembered selection. It lives in sessionStorage and its
     own sign-out clears it, but this list is the inventory of everything the
     suite writes, and a selection names a private repository and branch - which
     is exactly the kind of thing "erase data" is for. */
  'gh_branch_compare_selection',
];

/* Adopt a token saved by either dashboard under its old key, once. A token in
   localStorage was, by definition, being remembered. */
function migrateLegacyToken() {
  if (store.get(PAT_KEY) || store.get(PAT_KEY, true)) { dropLegacyKeys(); return; }
  for (const k of LEGACY_PAT_KEYS) {
    const v = store.get(k);
    if (v) { store.set(PAT_KEY, v); store.set(REMEMBER_KEY, '1'); dropLegacyKeys(); return; }
  }
  for (const k of LEGACY_PAT_KEYS) {
    const v = store.get(k, true);
    if (v) { store.set(PAT_KEY, v, true); dropLegacyKeys(); return; }
  }
  dropLegacyKeys();
}
function dropLegacyKeys() {
  LEGACY_PAT_KEYS.forEach(k => { store.del(k); store.del(k, true); });
  store.del('gh_pr_tracker_remember');
}

/* Identifies the current sign-in attempt. Bumped by every `connect` and by
   every `disconnect`, so an attempt that has been superseded (signed out
   mid-flight, or a second token entered before the first resolved) can tell
   that it no longer speaks for the page. */
let authGen = 0;

const GHAuth = {
  icon: '🔗',
  title: 'GitHub dashboard',
  blurb: '',
  onConnected: null,      // () => void
  onDisconnected: null,   // (forget) => void
  onRestore: null,        // () => boolean - painted something from cache?

  configure(opts) { Object.assign(this, opts); },

  start() {
    migrateLegacyToken();
    const root = document.getElementById('app');
    const saved = store.get(PAT_KEY) || store.get(PAT_KEY, true);
    const remembered = store.get(REMEMBER_KEY) === '1';
    if (!saved) { root.appendChild(buildTokenScreen()); return; }

    /* Signing in costs a round trip to /user and another to /user/orgs, and
       until now nothing at all was on screen for the whole of it. Anything the
       page can draw from local storage needs no token, so give it the chance
       to draw first and let the sign-in finish behind it. */
    app.connecting = true;
    let painted = false;
    if (this.onRestore) {
      try { painted = !!this.onRestore(); }
      catch (e) { console.error('onRestore failed', e); }
    }
    if (!painted) {
      root.innerHTML = '<div class="connecting-splash">Connecting…</div>';
    }

    const attempt = this.connect(saved, remembered);
    /* `connect` bumps `authGen` synchronously, before its first await, so
       reading it here gives this attempt's generation. A failure that arrives
       after the viewer has already signed out must not repaint over them. */
    const myGen = authGen;
    attempt.catch(e => {
      if (myGen !== authGen) return;
      app.connecting = false;
      /* Only a 401 means the token is actually bad. An offline browser, a
         captive portal, a proxy hiccup, a 5xx, a spent rate limit and the
         30-second timeout all land here too, and none of them is a reason to
         throw the credential away: GitHub never shows an existing token again,
         so deleting it costs the viewer a trip to go and mint a new one. Keep
         it, and say what actually happened instead of blaming GitHub. */
      const rejected = e.status === 401;
      if (rejected) { store.del(PAT_KEY); store.del(PAT_KEY, true); }
      root.innerHTML = '';
      root.appendChild(buildTokenScreen(rejected
        ? 'GitHub rejected the saved token (' + e.message + '). Enter a new one.'
        : 'Could not reach GitHub (' + e.message + '). Your saved token is untouched, ' +
          'so reload to try again, or enter a different one below.'));
    });
  },

  async connect(t, remember) {
    const myGen = ++authGen;
    const user = await ghGet(t, '/user');
    /* Signing in is two round trips, and on a slow link there is time to click
       Sign out in the middle of them. Without this check the resolving sign-in
       then writes the token back to storage, sets `app.token` and repaints the
       board over the token screen: the viewer asked to be signed out and ends
       up signed in, with the credential restored to disk. Everything below is
       only correct if this is still the current attempt. */
    if (myGen !== authGen) return;

    app.token = t;
    app.username = user.login;
    app.remember = !!remember;

    /* The organization list only feeds the dropdowns. Fine-grained tokens
       routinely cannot read it, and that must not block signing in. */
    app.orgs = [user.login];
    try {
      const orgData = await ghGetAll(t, '/user/orgs', {}, 5);
      if (myGen !== authGen) return;
      app.orgs = [user.login, ...orgData.map(o => o.login)].sort((a, b) => a.localeCompare(b));
    } catch (e) { /* best effort */ }
    if (myGen !== authGen) return;

    if (remember) { store.set(PAT_KEY, t); store.set(REMEMBER_KEY, '1'); store.del(PAT_KEY, true); }
    else          { store.set(PAT_KEY, t, true); store.del(PAT_KEY); store.del(REMEMBER_KEY); }

    clearLookupCaches();
    app.connecting = false;
    if (this.onConnected) this.onConnected();
  },

  disconnect(forget) {
    authGen++;                        // abandon any sign-in still in flight
    if (this.onDisconnected) this.onDisconnected(!!forget);
    app.token = ''; app.username = ''; app.orgs = []; app.remember = false;
    clearLookupCaches();
    /* Both copies, always. Dropping only the session copy is not a disconnect:
       the remembered one signs you straight back in on the next load, and the
       token screen hands it back in an input in the meantime. What `forget`
       adds is the cached board and review data, not the credential itself.

       REMEMBER_KEY deliberately survives. It is a preference, not a secret, so
       the checkbox stays where the viewer left it for the next sign-in. */
    store.del(PAT_KEY, true);
    store.del(PAT_KEY);
    if (forget) OWNED_KEYS.forEach(k => { store.del(k); store.del(k, true); });
    const root = document.getElementById('app');
    root.innerHTML = '';
    root.appendChild(buildTokenScreen());
    if (forget) toast('Token and all cached data removed from this browser.');
  },
};

function buildTokenScreen(initialError) {
  const div = document.createElement('div');
  div.className = 'token-screen';
  div.innerHTML = `
    <div class="token-box">
      <div class="token-icon">${escapeHtml(GHAuth.icon)}</div>
      <h1>${escapeHtml(GHAuth.title)}</h1>
      <p class="mb-sm">${escapeHtml(GHAuth.blurb)}</p>
      <p>A GitHub token that can read the repositories you want to look at is required.
         A <strong class="t-dim">fine-grained</strong> token needs
         <code>Metadata: Read</code>, <code>Contents: Read</code> and
         <code>Pull requests: Read</code> - all read-only. A
         <strong class="t-dim">classic</strong> token works too, but
         <code>repo</code> grants write access as well, so prefer fine-grained.</p>
      <p>Your token stays in this browser and is sent only to <code>api.github.com</code>.
         Private repositories stay private: the API returns nothing for repos your token
         can't read. One token covers every dashboard here.</p>
      <div class="token-row">
        <input class="token-input" type="password" placeholder="github_pat_… or ghp_…"
               id="pat-input" autocomplete="off" aria-label="GitHub token" />
        <button class="btn-connect" id="btn-connect">Connect</button>
      </div>
      <div class="check-row">
        <input type="checkbox" id="remember" />
        <label for="remember">Remember this token on this device</label>
      </div>
      <p class="scope-note">Leave unchecked on shared machines - the token is then kept
         only for this browser tab.</p>
      <div id="auth-err" class="err-text" role="alert"></div>
    </div>`;

  const input = div.querySelector('#pat-input');
  const btn   = div.querySelector('#btn-connect');
  const errEl = div.querySelector('#auth-err');
  const rem   = div.querySelector('#remember');

  rem.checked = store.get(REMEMBER_KEY) === '1';
  /* Pre-fill only to let the viewer correct or retry a token that has just
     failed. Unconditionally, it would hand a stored credential back to whoever
     is sitting at the machine, which is the thing "Disconnect" is supposed to
     prevent. `type="password"` hides it from a shoulder, not from the DOM. */
  if (initialError) {
    const saved = store.get(PAT_KEY) || store.get(PAT_KEY, true);
    if (saved) input.value = saved;
    errEl.textContent = '⚠ ' + initialError;
  }
  /* The only control on the screen; put the caret in it. */
  setTimeout(() => { try { input.focus(); } catch (e) { /* not attached yet */ } }, 0);

  const doConnect = () => {
    const t = input.value.trim();
    if (!t) return;
    btn.disabled = true; btn.textContent = 'Connecting…'; errEl.textContent = '';
    GHAuth.connect(t, rem.checked).catch(e => {
      errEl.textContent = '⚠ ' + e.message;
      btn.disabled = false; btn.textContent = 'Connect';
    });
  };
  btn.addEventListener('click', doConnect);
  /* Bound on the box rather than the input: after ticking "Remember" the focus
     is on the checkbox, and Enter there used to do nothing at all. Enter
     anywhere on this screen can only mean one thing. */
  div.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !btn.disabled) { e.preventDefault(); doConnect(); }
  });
  return div;
}

/* The right-hand end of every dashboard header: who you are, and the two ways
   out. Both now remove the token; "Forget token" additionally erases everything
   the suite has cached, and the labels say so. */
function ghHeaderTailHtml() {
  return `<span class="muted" id="gh-identity"></span>
    <button class="btn-sm" id="gh-disconnect" title="Remove the token from this browser and return to the sign-in screen">Sign out</button>
    <button class="btn-sm" id="gh-forget" title="Sign out, and also erase every cached board, review and repository name this suite has stored in this browser">Sign out &amp; erase data</button>`;
}

/* The header is built before the username is known when a cached board is
   painted first, so who you are is filled in separately. */
function paintHeaderIdentity(root) {
  /* Scoped lookup: the header is wired before it is in the document, so
     getElementById would find nothing on the first pass. */
  const el = (root || document).querySelector('#gh-identity');
  if (!el) return;
  el.innerHTML = app.username
    ? `Signed in as <strong class="t-mute">${escapeHtml(app.username)}</strong>`
    : 'Signing in…';
}

function wireHeaderTail(headerEl) {
  paintHeaderIdentity(headerEl);
  const d = headerEl.querySelector('#gh-disconnect');
  const f = headerEl.querySelector('#gh-forget');
  if (d) d.addEventListener('click', () => GHAuth.disconnect(false));
  if (f) f.addEventListener('click', () => GHAuth.disconnect(true));
}

/* A link back to the suite index, so the dashboards feel like one product. */
function ghHomeLinkHtml() {
  return `<a class="btn-sm no-underline" href="index.html" title="All tools">← All tools</a>`;
}
