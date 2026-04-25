# CLAUDE.md — X Bookmarks plugin

Guidance for Claude Code when editing this directory.

## What this plugin is

**X Bookmarks** is a standalone Obsidian plugin that imports X (Twitter) bookmarks into your vault as markdown notes. It is a pure ingester: connect your X account, run a sync, and bookmarks land as `.md` files with frontmatter (`tweet_id`, `source`, `author`, `published`, `created`, `tags`, `description`).

It deliberately has no reading-queue UI, no overlay, and no dependency on the Sessions plugin.

## Files

- `main.js` — single CommonJS file: `DEFAULTS`, helpers (`slugifyFolderName`, `fetchXArticleViaJina`, `fetchArticleMetadata`), `XClient`, `XBookmarksPlugin`, `XBookmarksSettingTab`
- `styles.css` — minimal settings-tab styling, `xbookmarks-` prefixed classes
- `manifest.json` — id `x-bookmarks`, desktop-only

No `package.json`, no TypeScript, no `node_modules`.

## Build / dev loop

**There is no build.** Edit `main.js` and `styles.css` directly. After every change:

1. Commit (`X Bookmarks: <what changed>`)
2. Run `/wt-test` to rsync into the live folder at `/Users/rootlab/Starbase/.obsidian/plugins/x-bookmarks/`
3. Reload the plugin in Obsidian: Settings → Community plugins → toggle off/on

The live folder is a pure rsync target — **never edit files there directly**.

## Worktree rule

Primary repo: `/Users/rootlab/projects/x-bookmarks` (main branch).
Feature worktrees: `/Users/rootlab/projects/x-bookmarks-wt/<feature>`.

Never skip the commit + `/wt-test` cycle after any change.

## Constraints

1. **OAuth redirect URI is `obsidian://x-bookmarks-auth`.** It is registered in the user's X developer portal. Never change it without a migration plan — changing it silently breaks the OAuth flow for all connected users.

2. **Settings are flat — no `.x` nesting.** `plugin.settings.clientId`, not `plugin.settings.x.clientId`. This is intentional (Sessions uses `.x` nesting, we don't). Don't re-introduce nesting.

3. **`loadSettings` has a migration shim.** If a user copies `data.json` from a Sessions install, settings live under `data.settings.x`. The shim at `loadSettings` lifts these to top level. Don't remove it.

4. **`XClient._s` points to `plugin.settings`.** All internal settings access goes through `this._s`. Keep this indirection — it makes the settings-key refactor easy to reason about.

5. **Jina rate-limit flag is per-sync.** `this._jinaRateLimited` is set during `syncNow` and cleared in `finally`. Once hit, all remaining X native article fetches in the same sync skip Jina. This is correct — don't make it persistent.

6. **Dedup uses two mechanisms.** (a) `_seenTweetIds`: built from filenames (`tweetId.md` / `title (tweetId).md`) and `tweet_id` frontmatter inside the vault folder, plus vault-wide scan for moved/renamed files. (b) `vault.getAbstractFileByPath` checks before `vault.create`. Both are needed. The first is for early-stop during listing; the second is the definitive guard at write time.

7. **`fetchArticleMetadata` is best-effort regex scraping.** Returns `{}` for JS-rendered pages (most modern SPAs). Don't replace it with a more expensive strategy without explicit approval.

8. **PKCE state lives in memory.** `_pendingVerifier` / `_pendingState` are instance fields. A plugin reload mid-auth-flow loses them. This is intentional (security boundary) — don't persist PKCE state.

## Settings schema

```js
{
  enabled, clientId, clientSecret, tokens, userId, handle,
  vaultFolder,          // default 'X Bookmarks'
  folderSelection,      // { mode: 'all' | 'selected', ids: [] }
  availableFolders,     // [{ id, name }]
  foldersSupported,     // null | true | false
  scheduleHours,        // null = no auto-fetch; integer hours ≥1, recurring while Obsidian is open
  lastFetchIso,
  lastSeenTweetId,
  failureCount,
  nextRetryAt,
  fetchLog,             // ring buffer, cap 20
  tagOnImport,          // '' by default (opt-in tag for all bookmarks)
  organizeByFolder,     // default true
  tagByFolder,          // default true — primary tagging mechanism
}
```

## Commit rule

Commit after any change. Use `X Bookmarks: <what changed>` as the commit message style.
