'use strict';

const DEFAULTS = {
  enabled: false,
  clientId: '',
  clientSecret: '',          // only needed for Confidential Client (Web App) type X apps
  tokens: null,              // { accessToken, refreshToken, expiresAt } or null
  userId: '',                // resolved from /2/users/me after connect
  handle: '',                // cached @username
  vaultFolder: 'X Bookmarks',
  folderSelection: { mode: 'all', ids: [] },  // mode: 'all' | 'selected'
  availableFolders: [],      // [{ id, name }] cached from last listFolders
  foldersSupported: null,    // null=unknown, true/false set after first folder-list attempt
  syncFrequencyHours: 24,
  lastFetchIso: '',
  lastSeenTweetId: '',       // since_id cursor
  autoFetchOnLoad: true,
  failureCount: 0,
  nextRetryAt: 0,            // ms epoch
  fetchLog: [],              // [{ tsIso, ok, count, error? }] ring buffer cap 20
  tagOnImport: '',           // opt-in: when set, tag applied to all imported bookmarks
  organizeByFolder: true,    // store bookmarks in <vaultFolder>/<slug>/ when folder is known
  tagByFolder: true,         // add <slug> tag to YAML frontmatter when folder is known
  allModeFetchPerFolder: false,
};

const obsidian = require('obsidian');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugifyFolderName(name) {
  if (!name) return '';
  const ascii = name.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Fetch full article content for X native articles via Jina AI reader.
 * r.jina.ai renders the JS page and returns clean markdown including the full body.
 * Returns {} on failure, { rateLimited: true } on 429.
 */
async function fetchXArticleViaJina(tweetUrl) {
  try {
    const jinaUrl = `https://r.jina.ai/${tweetUrl}`;
    const resp = await obsidian.requestUrl({ url: jinaUrl, method: 'GET',
      headers: { 'Accept': 'text/plain', 'User-Agent': 'Mozilla/5.0 (compatible; ObsidianXBookmarks/1.0)' } });
    const md = (resp.text || '').trim();
    if (!md || md.includes('page doesn') || md.includes('Log in') || md.length < 100) return {};
    const mcMatch = md.match(/^Markdown Content:\s*\n([\s\S]+)/im);
    const body = mcMatch ? mcMatch[1].trim() : md;
    const h1Match = body.match(/^#\s+(.+)/m);
    let title = h1Match ? h1Match[1].trim() : null;
    if (!title) {
      const titleLine = md.match(/^Title:\s*(.+)/m);
      if (titleLine) {
        let raw = titleLine[1].trim();
        const quoted = raw.match(/"([^"]{10,})"/);
        title = quoted ? quoted[1] : raw.replace(/\s*\/\s*X\s*$/, '').trim();
      }
    }
    return { title, description: title, content: body.length > 50 ? body : null };
  } catch (e) {
    if (e.message?.includes('429')) return { rateLimited: true };
    console.warn('X Bookmarks: fetchXArticleViaJina failed', tweetUrl, e.message);
    return {};
  }
}

/**
 * Fetch a URL and extract article metadata (title, description, body text).
 * Returns {} on failure — callers should treat all fields as optional.
 * Note: regex-based HTML scraping; returns {} for JS-rendered pages.
 */
async function fetchArticleMetadata(url) {
  try {
    const resp = await obsidian.requestUrl({ url, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ObsidianXBookmarks/1.0)' } });
    const html = resp.text || '';
    if (!html) return {};

    const getMeta = (...patterns) => {
      for (const p of patterns) { const m = html.match(p); if (m?.[1]?.trim()) return m[1].trim(); }
      return null;
    };

    const title = getMeta(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["']/i,
      /<title[^>]*>([^<]+)<\/title>/i,
    );

    const description = getMeta(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    );

    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');

    const articleMatch =
      cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
      cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    let contentHtml = articleMatch ? articleMatch[1] : cleaned;

    const htmlToText = s => s
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, __, inner) => '\n\n' + inner.replace(/<[^>]+>/g, '').trim() + '\n')
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => '\n\n' + inner.replace(/<[^>]+>/g, '').trim())
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => '\n- ' + inner.replace(/<[^>]+>/g, '').trim())
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const content = htmlToText(contentHtml);
    return { title, description, content: content.length > 100 ? content : null };
  } catch (e) {
    console.warn('X Bookmarks: fetchArticleMetadata failed', url, e.message);
    return {};
  }
}

// ─── XClient ──────────────────────────────────────────────────────────────────

class XClient {
  constructor(plugin) {
    this.plugin = plugin;
    this._pendingVerifier = null;
    this._pendingState = null;
    this._pendingStartedAt = 0;
    this._refreshInFlight = null;
    this._syncInFlight = false;
    this._rerender = null;
  }

  get _s() { return this.plugin.settings; }

  isConnected() { return !!(this._s?.tokens?.accessToken); }

  _b64url(bytes) {
    let str = '';
    bytes.forEach(b => str += String.fromCharCode(b));
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async _generatePkce() {
    const verifierBytes = new Uint8Array(64);
    crypto.getRandomValues(verifierBytes);
    const verifier = this._b64url(verifierBytes);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = this._b64url(new Uint8Array(digest));
    return { verifier, challenge };
  }

  async beginAuthFlow() {
    const s = this._s;
    if (!s.clientId) { new obsidian.Notice('X Bookmarks: set a Client ID in plugin settings first.'); return; }
    const { verifier, challenge } = await this._generatePkce();
    this._pendingVerifier = verifier;
    this._pendingStartedAt = Date.now();
    const stateBytes = new Uint8Array(16);
    crypto.getRandomValues(stateBytes);
    this._pendingState = this._b64url(stateBytes);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: s.clientId,
      redirect_uri: 'obsidian://x-bookmarks-auth',
      scope: 'tweet.read users.read bookmark.read offline.access',
      state: this._pendingState,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    window.open(`https://x.com/i/oauth2/authorize?${params}`);
    new obsidian.Notice('Authorise X Bookmarks in your browser, then return to Obsidian.');
  }

  async handleAuthCallback(params) {
    if (params.error) { new obsidian.Notice(`X Bookmarks: ${params.error}`); return; }
    if (!params.code || !this._pendingVerifier) return;
    if (params.state !== this._pendingState) {
      this._pendingVerifier = null; this._pendingState = null;
      new obsidian.Notice('X Bookmarks: state mismatch — try connecting again.');
      return;
    }
    if (Date.now() - this._pendingStartedAt > 10 * 60 * 1000) {
      this._pendingVerifier = null; this._pendingState = null;
      new obsidian.Notice('X Bookmarks: authorisation expired, try again.');
      return;
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: 'obsidian://x-bookmarks-auth',
      client_id: this._s.clientId,
      code_verifier: this._pendingVerifier,
    });
    this._pendingVerifier = null; this._pendingState = null;
    try {
      const xHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (this._s.clientSecret) {
        xHeaders['Authorization'] = 'Basic ' + btoa(`${this._s.clientId}:${this._s.clientSecret}`);
      }
      const res = await obsidian.requestUrl({
        url: 'https://api.x.com/2/oauth2/token',
        method: 'POST',
        headers: xHeaders,
        body: body.toString(),
        throw: false,
      });
      if (res.status !== 200) {
        new obsidian.Notice('X Bookmarks: token exchange failed. Check Client ID and Redirect URI.');
        console.error('X Bookmarks: token exchange', res.status, res.text);
        return;
      }
      const data = res.json;
      this._s.tokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
      };
      await this.plugin.saveSettings();
      await this._fetchUserProfile();
      await this.listFolders();
      new obsidian.Notice('X connected.');
      this._rerender?.();
    } catch (e) {
      console.error('X Bookmarks: auth callback error', e);
      new obsidian.Notice('X Bookmarks: connection failed. See console for details.');
    }
  }

  disconnect() {
    const s = this._s;
    s.tokens = null; s.userId = ''; s.handle = '';
    s.availableFolders = []; s.foldersSupported = null;
    s.folderSelection = { mode: 'all', ids: [] };
    s.lastFetchIso = ''; s.lastSeenTweetId = '';
    s.failureCount = 0; s.nextRetryAt = 0;
    this.plugin.saveSettings();
    this._rerender?.();
  }

  async _fetchUserProfile() {
    try {
      const data = await this._withFreshToken(async (tok) => {
        const res = await obsidian.requestUrl({
          url: 'https://api.x.com/2/users/me?user.fields=username,name',
          method: 'GET',
          headers: { 'Authorization': `Bearer ${tok}` },
          throw: false,
        });
        if (res.status !== 200) throw new Error(`users/me: ${res.status}`);
        return res.json;
      });
      this._s.userId = data.data?.id || '';
      this._s.handle = data.data?.username || '';
      await this.plugin.saveSettings();
    } catch (e) { console.warn('X Bookmarks: failed to fetch user profile', e); }
  }

  async _refreshToken() {
    if (this._refreshInFlight) return this._refreshInFlight;
    this._refreshInFlight = (async () => {
      const s = this._s;
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: s.tokens.refreshToken,
        client_id: s.clientId,
      });
      const refreshHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (s.clientSecret) {
        refreshHeaders['Authorization'] = 'Basic ' + btoa(`${s.clientId}:${s.clientSecret}`);
      }
      const res = await obsidian.requestUrl({
        url: 'https://api.x.com/2/oauth2/token',
        method: 'POST',
        headers: refreshHeaders,
        body: body.toString(),
        throw: false,
      });
      if (res.status !== 200) {
        s.tokens = null;
        await this.plugin.saveSettings();
        this._rerender?.();
        throw new Error(`X token refresh failed: ${res.status}`);
      }
      const data = res.json;
      s.tokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || s.tokens.refreshToken,
        expiresAt: Date.now() + (data.expires_in * 1000),
      };
      await this.plugin.saveSettings();
    })();
    try { await this._refreshInFlight; }
    finally { this._refreshInFlight = null; }
  }

  async _withFreshToken(fn) {
    const s = this._s;
    if (!s.tokens) throw new Error('X Bookmarks: not connected');
    if (s.tokens.expiresAt - Date.now() < 60000) await this._refreshToken();
    return fn(s.tokens.accessToken);
  }

  async _apiGet(path, params = {}) {
    const url = new URL(path.startsWith('https://') ? path : `https://api.x.com${path}`);
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, String(v)); });
    return this._withFreshToken(async (tok) => {
      const res = await obsidian.requestUrl({
        url: url.toString(),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${tok}` },
        throw: false,
      });
      if (res.status === 429) {
        const retryAfterSec = parseInt(res.headers?.['x-rate-limit-reset'] || '0', 10);
        const err = new Error('X Bookmarks: rate limited');
        err.isRateLimit = true; err.retryAfterSec = retryAfterSec;
        throw err;
      }
      if (res.status === 401) {
        const err = new Error('X Bookmarks: unauthorized'); err.isUnauthorized = true; throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        const body = (() => { try { return JSON.stringify(res.json); } catch { return res.text || ''; } })();
        const err = new Error(`X API error ${res.status}${body ? ': ' + body : ''}`); err.status = res.status; throw err;
      }
      return res.json;
    });
  }

  async listFolders() {
    const s = this._s;
    if (!s.userId) return [];
    try {
      const data = await this._apiGet(`/2/users/${s.userId}/bookmarks/folders`);
      s.availableFolders = (data.data || []).map(f => ({ id: f.id, name: f.name || f.id }));
      s.foldersSupported = true;
      await this.plugin.saveSettings();
      return s.availableFolders;
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        s.foldersSupported = false;
        await this.plugin.saveSettings();
        return [];
      }
      console.warn('X Bookmarks: listFolders failed', e);
      return [];
    }
  }

  async listFolderTweetIds(folderId) {
    const s = this._s;
    if (!s.userId) return [];
    const data = await this._apiGet(`/2/users/${s.userId}/bookmarks/folders/${folderId}`, {});
    return (data.data || []).map(t => t.id);
  }

  // Feed is ordered by bookmark-time desc. Once a full page is entirely known IDs, all
  // older pages are also known — pass knownIds to enable early-stop.
  async listBookmarks(knownIds) {
    const s = this._s;
    if (!s.userId) return [];
    const results = [];
    let paginationToken;
    let pageCount = 0;
    const MAX_PAGES = 8; // X caps total bookmarks at 800 (8 pages × 100)
    do {
      const params = {
        max_results: 100,
        expansions: 'author_id,attachments.media_keys',
        'tweet.fields': 'created_at,text,entities',
        'user.fields': 'username,name',
      };
      if (paginationToken) params.pagination_token = paginationToken;
      const data = await this._apiGet(`/2/users/${s.userId}/bookmarks`, params);
      const tweets = data.data || [];
      if (tweets.length === 0) break;
      const userMap = {};
      (data.includes?.users || []).forEach(u => { userMap[u.id] = u; });
      let pageHasNew = false;
      for (const tweet of tweets) {
        results.push({
          tweet,
          author: userMap[tweet.author_id] || { username: 'unknown', name: 'Unknown' },
        });
        if (knownIds && !knownIds.has(tweet.id)) pageHasNew = true;
      }
      paginationToken = data.meta?.next_token;
      pageCount++;
      if (knownIds && !pageHasNew) break;
    } while (paginationToken && pageCount < MAX_PAGES);
    return results;
  }

  async syncNow({ reason = 'manual' } = {}) {
    if (this._syncInFlight) { new obsidian.Notice('X Bookmarks: sync already in progress.'); return; }
    const s = this._s;
    if (!s.enabled || !s.tokens) {
      new obsidian.Notice('X Bookmarks: not connected. Configure X in plugin settings.');
      return;
    }
    this._syncInFlight = true;
    this._rerender?.();
    let totalNew = 0; let errorMsg = null;
    try {
      await this._ensureVaultFolder(s.vaultFolder);
      const foldersSupported = s.foldersSupported === true;
      const selectedMode = s.folderSelection.mode === 'selected';
      const shouldFetchPerFolder = foldersSupported && (selectedMode || s.allModeFetchPerFolder);

      const rootFolder = (s.vaultFolder || 'X Bookmarks').replace(/\/$/, '');
      this._seenTweetIds = new Set();
      this._jinaRateLimited = false;
      for (const f of this.plugin.app.vault.getMarkdownFiles()) {
        if (!f.path.startsWith(rootFolder + '/') && f.path !== rootFolder + '.md') continue;
        const idFromName = f.basename.match(/^(\d{15,})$/) || f.basename.match(/\((\d{15,})\)$/);
        if (idFromName) { this._seenTweetIds.add(idFromName[1]); continue; }
        const cache = this.plugin.app.metadataCache.getFileCache(f);
        const fmId = cache?.frontmatter?.tweet_id;
        if (fmId) this._seenTweetIds.add(String(fmId));
      }
      // Catch moved/renamed files: scan tweet_id frontmatter vault-wide outside rootFolder.
      for (const f of this.plugin.app.vault.getMarkdownFiles()) {
        if (f.path.startsWith(rootFolder + '/') || f.path === rootFolder + '.md') continue;
        const cache = this.plugin.app.metadataCache.getFileCache(f);
        const fmId = cache?.frontmatter?.tweet_id;
        if (fmId) this._seenTweetIds.add(String(fmId));
      }

      let allBookmarks;
      if (shouldFetchPerFolder) {
        const folders = selectedMode
          ? (s.availableFolders || []).filter(f => s.folderSelection.ids.includes(f.id))
          : (s.availableFolders || []);
        const folderIdBatches = await Promise.all(
          folders.map(f => this.listFolderTweetIds(f.id).then(ids => ({ ids, folderName: f.name })))
        );
        const folderMap = {};
        for (const { ids, folderName } of folderIdBatches) {
          for (const id of ids) { if (!folderMap[id]) folderMap[id] = folderName; }
        }
        let bulkBatch;
        if (selectedMode && Object.keys(folderMap).every(id => this._seenTweetIds.has(id))) {
          bulkBatch = [];
        } else {
          bulkBatch = await this.listBookmarks(this._seenTweetIds);
        }
        allBookmarks = bulkBatch.map(item => ({
          ...item,
          folderName: folderMap[item.tweet.id] || null,
        }));
      } else {
        allBookmarks = await this.listBookmarks(this._seenTweetIds);
      }

      const addQueueTag = !!s.tagOnImport;
      let maxSeenId = s.lastSeenTweetId;
      for (let i = 0; i < allBookmarks.length; i++) {
        const { tweet, author, folderName } = allBookmarks[i];
        if (await this._materializeBookmark(tweet, author, folderName, { addQueueTag })) totalNew++;
        if (!maxSeenId || tweet.id > maxSeenId) maxSeenId = tweet.id;
      }
      s.lastSeenTweetId = maxSeenId;
      s.lastFetchIso = new Date().toISOString();
      s.failureCount = 0; s.nextRetryAt = 0;
      this._appendFetchLog({ ok: true, count: totalNew });
      await this.plugin.saveSettings();
      new obsidian.Notice(`X Bookmarks: synced ${totalNew} new bookmark${totalNew === 1 ? '' : 's'}.`);
      if (s.foldersSupported !== false) this.listFolders().catch(() => {});
    } catch (e) {
      errorMsg = e.message || 'unknown error';
      if (e.isRateLimit) {
        s.nextRetryAt = e.retryAfterSec ? e.retryAfterSec * 1000 : Date.now() + 15 * 60 * 1000;
        s.failureCount++;
        const retryAt = s.nextRetryAt ? new Date(s.nextRetryAt).toLocaleTimeString() : '';
        new obsidian.Notice(`X Bookmarks: rate limited.${retryAt ? ` Retry after ${retryAt}.` : ''}`, 6000);
      } else if (e.isUnauthorized) {
        this.disconnect();
        new obsidian.Notice('X Bookmarks: session expired — reconnect in Settings → X Bookmarks.', 6000);
        return;
      } else {
        s.failureCount++;
        s.nextRetryAt = Date.now() + Math.min(Math.pow(2, s.failureCount) * 5 * 60 * 1000, 24 * 60 * 60 * 1000);
        new obsidian.Notice(`X Bookmarks: sync failed — ${errorMsg}`, 6000);
        console.error('X Bookmarks: syncNow failed', e);
      }
      this._appendFetchLog({ ok: false, count: totalNew, error: errorMsg });
      await this.plugin.saveSettings();
    } finally {
      this._syncInFlight = false;
      this._seenTweetIds = null;
      this._jinaRateLimited = false;
      this._rerender?.();
    }
  }

  async _materializeBookmark(tweet, author, folderName, { addQueueTag = false } = {}) {
    const s = this._s;
    const rootFolder = (s.vaultFolder || 'X Bookmarks').replace(/\/$/, '');
    const slug = (folderName && s.organizeByFolder !== false) ? slugifyFolderName(folderName) : '';
    const folderPath = slug ? `${rootFolder}/${slug}` : rootFolder;

    if (this._seenTweetIds?.has(tweet.id)) return false;

    if (slug) await this._ensureVaultFolder(folderPath);

    const urlEntities = (tweet.entities && tweet.entities.urls) || [];
    const articleEntity = urlEntities.length > 0 ? urlEntities[urlEntities.length - 1] : null;

    let fetchedMeta = null;
    const expandedUrl = articleEntity?.expanded_url || '';
    const isXNativeArticle = expandedUrl.includes('x.com/i/article') || expandedUrl.includes('twitter.com/i/article');
    const isShortUrl = expandedUrl.includes('t.co/');
    const tweetStatusUrl = `https://x.com/${author.username || 'unknown'}/status/${tweet.id}`;

    if (articleEntity && (!articleEntity.title || !articleEntity.description)) {
      if (isXNativeArticle) {
        if (!this._jinaRateLimited) {
          fetchedMeta = await fetchXArticleViaJina(tweetStatusUrl);
          if (fetchedMeta?.rateLimited) { this._jinaRateLimited = true; fetchedMeta = null; }
        }
      } else if (!isShortUrl && !expandedUrl.includes('x.com/') && !expandedUrl.includes('twitter.com')) {
        fetchedMeta = await fetchArticleMetadata(expandedUrl);
      }
    }

    const articleTitle = articleEntity?.title || fetchedMeta?.title;
    const tweetTextClean = (tweet.text || '').replace(/\s+/g, ' ').trim();
    const tweetIsJustUrl = /^https?:\/\/\S+$/.test(tweetTextClean);
    const displayName = author.name || author.username || 'unknown';
    let baseTitle = articleTitle;
    if (!baseTitle && !tweetIsJustUrl) {
      baseTitle = tweetTextClean.length > 80
        ? tweetTextClean.slice(0, tweetTextClean.lastIndexOf(' ', 80) || 80) + '…'
        : tweetTextClean;
    }
    if (!baseTitle) baseTitle = isXNativeArticle ? `Article by ${displayName}` : null;
    let baseName = tweet.id;
    if (baseTitle) {
      baseName = baseTitle.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || tweet.id;
    }
    let path = `${folderPath}/${baseName}.md`;
    if (this.plugin.app.vault.getAbstractFileByPath(path) && baseName !== tweet.id) {
      path = `${folderPath}/${baseName} (${tweet.id}).md`;
    }
    if (this.plugin.app.vault.getAbstractFileByPath(path)) return false;
    const legacyPath = `${folderPath}/${tweet.id}.md`;
    if (this.plugin.app.vault.getAbstractFileByPath(legacyPath)) return false;
    if (slug) {
      if (this.plugin.app.vault.getAbstractFileByPath(`${rootFolder}/${baseName}.md`)) return false;
      if (baseName !== tweet.id && this.plugin.app.vault.getAbstractFileByPath(`${rootFolder}/${baseName} (${tweet.id}).md`)) return false;
      if (this.plugin.app.vault.getAbstractFileByPath(`${rootFolder}/${tweet.id}.md`)) return false;
    }
    try {
      await this.plugin.app.vault.create(path, this._buildNoteContent(tweet, author, folderName, fetchedMeta, { addQueueTag }));
      this._seenTweetIds?.add(tweet.id);
      return true;
    } catch (e) { console.warn('X Bookmarks: failed to create note', path, e); return false; }
  }

  _buildNoteContent(tweet, author, folderName, fetchedMeta = null, { addQueueTag = false } = {}) {
    const handle = author.username || 'unknown';
    const displayName = author.name || handle;
    const tweetUrl = `https://x.com/${handle}/status/${tweet.id}`;
    const text = tweet.text || '';
    const s = this._s;
    const importTag = (s.tagOnImport || '').replace(/^#/, '');
    const folderSlug = (folderName && s.tagByFolder !== false) ? slugifyFolderName(folderName) : '';
    const tagParts = [];
    if (addQueueTag && importTag) tagParts.push(importTag);
    if (folderSlug && folderSlug !== importTag) tagParts.push(folderSlug);
    const tagsValue = tagParts.length ? tagParts.join(', ') : '';

    const urlEntities = (tweet.entities && tweet.entities.urls) || [];
    const articleEntity = urlEntities.length > 0 ? urlEntities[urlEntities.length - 1] : null;
    const articleTitle = articleEntity?.title || fetchedMeta?.title || null;
    const articleDescription = articleEntity?.description || fetchedMeta?.description || null;

    const tweetTextClean = text.replace(/\s+/g, ' ').trim();
    const tweetIsJustUrl = /^https?:\/\/\S+$/.test(tweetTextClean);
    const isXNativeArticle = (articleEntity?.expanded_url || '').includes('x.com/i/article');
    let title = articleTitle || (tweetIsJustUrl ? null : tweetTextClean);
    if (!title) {
      title = isXNativeArticle ? `Article by ${displayName}` : tweet.id;
    } else if (!articleTitle && title.length > 80) {
      const cut = title.lastIndexOf(' ', 80);
      title = title.slice(0, cut > 0 ? cut : 80) + '…';
    }

    const q = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

    const descText = articleDescription || (tweetIsJustUrl ? (isXNativeArticle ? 'X native article — login to read' : '') : text);
    const descLines = descText.split('\n').map(l => `  ${l}`).join('\n');

    const published = tweet.created_at || '';
    const created = new Date().toISOString();

    let body;
    if (fetchedMeta?.content) {
      body = fetchedMeta.content;
    } else {
      body = text;
      for (const ue of urlEntities) {
        if (ue.url && ue.expanded_url) body = body.replace(ue.url, ue.expanded_url);
      }
    }

    const tagsLine = tagsValue ? `tags: [${tagsValue}]` : 'tags: []';
    const authorLabel = displayName.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const authorLink = `[${authorLabel}](https://x.com/${handle})`;
    const fm = `---\ntitle: ${q(title)}\nsource: ${q(tweetUrl)}\ntweet_id: "${tweet.id}"\nauthor: ${q(authorLink)}\npublished: ${published}\ncreated: ${created}\ndescription: |\n${descLines}\n${tagsLine}\n---\n`;
    return fm + '\n' + body + '\n';
  }

  _appendFetchLog(entry) {
    const s = this._s;
    if (!Array.isArray(s.fetchLog)) s.fetchLog = [];
    s.fetchLog.push({ tsIso: new Date().toISOString(), ...entry });
    if (s.fetchLog.length > 20) s.fetchLog = s.fetchLog.slice(-20);
  }

  async _ensureVaultFolder(folderPath) {
    if (!folderPath) return;
    try {
      if (!this.plugin.app.vault.getAbstractFileByPath(folderPath)) {
        await this.plugin.app.vault.createFolder(folderPath);
      }
    } catch (e) { /* ignore race */ }
  }

  async maybeAutoFetch() {
    const s = this._s;
    if (!s.enabled || !s.tokens || !s.autoFetchOnLoad) return;
    const now = Date.now();
    if (now < (s.nextRetryAt || 0)) return;
    const lastFetch = s.lastFetchIso ? Date.parse(s.lastFetchIso) : 0;
    if (now - lastFetch >= (s.syncFrequencyHours || 24) * 3600 * 1000) {
      await this.syncNow({ reason: 'auto' });
    }
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class XBookmarksPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.x = new XClient(this);

    this.addCommand({
      id: 'fetch-x-bookmarks',
      name: 'Fetch X bookmarks',
      callback: () => this.x.syncNow({ reason: 'command' }),
    });

    this.registerObsidianProtocolHandler('x-bookmarks-auth', (params) => {
      this.x.handleAuthCallback(params);
    });

    this.addSettingTab(new XBookmarksSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => this.x.maybeAutoFetch());
  }

  async loadSettings() {
    const data = await this.loadData() || {};
    // Migration shim: if settings were copied from a Sessions data.json,
    // they live under data.settings.x — lift to top level.
    const source = data.settings?.x ? data.settings.x : data;
    this.settings = { ...DEFAULTS, ...source };
    this.settings.folderSelection = { ...DEFAULTS.folderSelection, ...(this.settings.folderSelection || {}) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class XBookmarksSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new obsidian.Setting(containerEl)
      .setName('Enable X bookmarks')
      .setDesc('Import bookmarks from X (Twitter) into your vault as markdown notes.')
      .addToggle(tog => tog
        .setValue(s.enabled || false)
        .onChange(async v => { s.enabled = v; await this.plugin.saveSettings(); this.display(); }));

    if (s.enabled) {
      new obsidian.Setting(containerEl)
        .setName('Step 1 — Create an X app')
        .setDesc('Go to the X Developer Portal and create a new app. Choose Native App as the app type (recommended — no client secret needed). Set App Permissions to Read only.')
        .addButton(btn => btn
          .setButtonText('Open developer portal')
          .onClick(() => window.open('https://developer.x.com/en/portal/dashboard')));

      new obsidian.Setting(containerEl)
        .setName('Step 2 — Add Redirect URI to your app')
        .setDesc('In your app\'s Authentication Settings, enable OAuth 2.0. Under Redirect URIs, add this value exactly (no trailing slash).')
        .addButton(btn => btn
          .setButtonText('Copy redirect URI')
          .onClick(() => {
            navigator.clipboard.writeText('obsidian://x-bookmarks-auth');
            new obsidian.Notice('Redirect URI copied.');
          }));

      new obsidian.Setting(containerEl)
        .setName('Step 3 — Add Website URL to your app')
        .setDesc('X requires a Website URL field. Use this value — the plugin does not use it.')
        .addButton(btn => btn
          .setButtonText('Copy website URL')
          .onClick(() => {
            navigator.clipboard.writeText('https://obsidian.md');
            new obsidian.Notice('Website URL copied.');
          }));

      new obsidian.Setting(containerEl)
        .setName('Step 4 — Enter your Client ID')
        .setDesc('Find it under Keys and Tokens in your X app dashboard.')
        .addText(text => text
          .setPlaceholder('e.g. a1B2c3D4e5…')
          .setValue(s.clientId || '')
          .onChange(async v => { s.clientId = v.trim(); await this.plugin.saveSettings(); }));

      new obsidian.Setting(containerEl)
        .setName('Step 5 — Enter your Client Secret')
        .setDesc('Only required for Confidential Client apps (Web App / Bot type). Leave blank if you chose Native App.')
        .addText(text => {
          text.inputEl.type = 'password';
          text
            .setPlaceholder('Leave blank for Native App')
            .setValue(s.clientSecret || '')
            .onChange(async v => { s.clientSecret = v.trim(); await this.plugin.saveSettings(); });
        });

      new obsidian.Setting(containerEl)
        .setName('Step 6 — Connect your X account')
        .setDesc(s.tokens ? `Connected as @${s.handle || 'unknown'}.` : 'Once your Client ID is entered, click Connect to authorise in your browser.')
        .addButton(btn => btn
          .setButtonText(s.tokens ? 'Disconnect' : 'Connect X')
          .onClick(async () => {
            if (s.tokens) {
              this.plugin.x.disconnect();
              this.display();
            } else {
              await this.plugin.x.beginAuthFlow();
            }
          }));

      if (s.tokens) {
        new obsidian.Setting(containerEl)
          .setName('Bookmarks folder')
          .setDesc('Vault folder where imported bookmark notes will be created. Created automatically if it doesn\'t exist.')
          .addText(text => text
            .setPlaceholder('X Bookmarks')
            .setValue(s.vaultFolder || '')
            .onChange(async v => { s.vaultFolder = v.trim() || 'X Bookmarks'; await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
          .setName('Tag on import')
          .setDesc('Optional tag added to all imported bookmarks (e.g. #to-read, #x). Leave empty to skip.')
          .addText(text => text
            .setPlaceholder('e.g. to-read')
            .setValue(s.tagOnImport || '')
            .onChange(async v => { s.tagOnImport = v.trim(); await this.plugin.saveSettings(); }));

        if (s.foldersSupported === true && s.availableFolders.length > 0) {
          new obsidian.Setting(containerEl)
            .setName('Bookmark folder scope')
            .setDesc('Import all bookmarks or only selected X bookmark folders.')
            .addDropdown(dd => dd
              .addOption('all', 'All bookmarks')
              .addOption('selected', 'Selected folders only')
              .setValue(s.folderSelection.mode)
              .onChange(async v => { s.folderSelection.mode = v; await this.plugin.saveSettings(); this.display(); }));

          if (s.folderSelection.mode === 'selected') {
            for (const folder of s.availableFolders) {
              new obsidian.Setting(containerEl)
                .setName(folder.name)
                .setClass('xbookmarks-folder-toggle')
                .addToggle(tog => tog
                  .setValue(s.folderSelection.ids.includes(folder.id))
                  .onChange(async v => {
                    if (v) { if (!s.folderSelection.ids.includes(folder.id)) s.folderSelection.ids.push(folder.id); }
                    else { s.folderSelection.ids = s.folderSelection.ids.filter(id => id !== folder.id); }
                    await this.plugin.saveSettings();
                  }));
            }
          }
        } else if (s.foldersSupported === false) {
          containerEl.createEl('p', {
            cls: 'xbookmarks-settings-notice',
            text: 'X bookmark folders are not available on your API tier — all bookmarks will be synced.',
          });
        }

        if (s.foldersSupported === true) {
          new obsidian.Setting(containerEl)
            .setName('Organize by X folder')
            .setDesc('Store each bookmark in a subfolder named after its X folder (e.g. X Bookmarks/second-brain/). Bookmarks without a known folder stay in the root folder.')
            .addToggle(tog => tog
              .setValue(s.organizeByFolder !== false)
              .onChange(async v => { s.organizeByFolder = v; await this.plugin.saveSettings(); }));

          new obsidian.Setting(containerEl)
            .setName('Tag by X folder')
            .setDesc('Add the X folder name as a tag (e.g. #second-brain) to bookmark frontmatter.')
            .addToggle(tog => tog
              .setValue(s.tagByFolder !== false)
              .onChange(async v => { s.tagByFolder = v; await this.plugin.saveSettings(); }));

          if (s.folderSelection.mode === 'all') {
            new obsidian.Setting(containerEl)
              .setName('Fetch per folder in All mode')
              .setDesc('In "All bookmarks" mode, fetch each X folder separately so bookmarks get folder attribution for subfolders and tags. Uses more API calls (one extra request per folder per sync).')
              .addToggle(tog => tog
                .setValue(s.allModeFetchPerFolder === true)
                .onChange(async v => { s.allModeFetchPerFolder = v; await this.plugin.saveSettings(); }));
          }
        }

        new obsidian.Setting(containerEl)
          .setName('Sync frequency (hours)')
          .setDesc('Minimum hours between automatic fetches on Obsidian startup. Set to 0 to disable auto-sync on startup.')
          .addText(text => text
            .setPlaceholder('24')
            .setValue(String(s.syncFrequencyHours ?? 24))
            .onChange(async v => {
              const n = parseFloat(v);
              s.syncFrequencyHours = isNaN(n) || n < 0 ? 24 : n;
              await this.plugin.saveSettings();
            }));

        const lastLog = Array.isArray(s.fetchLog) && s.fetchLog.length ? s.fetchLog[s.fetchLog.length - 1] : null;
        const syncDesc = s.lastFetchIso
          ? `Last synced: ${new Date(s.lastFetchIso).toLocaleString()}${lastLog ? (lastLog.ok ? `  (${lastLog.count} new)` : `  Error: ${lastLog.error || 'unknown'}`) : ''}`
          : 'Never synced.';
        new obsidian.Setting(containerEl)
          .setName('Sync now')
          .setDesc(syncDesc)
          .addButton(btn => btn
            .setButtonText(this.plugin.x._syncInFlight ? 'Syncing…' : 'Fetch bookmarks')
            .setDisabled(this.plugin.x._syncInFlight)
            .onClick(async () => {
              btn.setButtonText('Syncing…'); btn.setDisabled(true);
              await this.plugin.x.syncNow({ reason: 'settings' });
              this.display();
            }))
          .addButton(btn => btn
            .setButtonText('Refresh folders')
            .onClick(async () => {
              await this.plugin.x.listFolders();
              this.display();
            }));
      }
    }
  }
}

module.exports = XBookmarksPlugin;
