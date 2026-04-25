# X Bookmarks

An Obsidian plugin that imports your X (Twitter) bookmarks into your vault as markdown notes.

Each bookmark becomes a `.md` file with frontmatter containing `title`, `source`, `tweet_id`, `author`, `published`, `created`, `description`, and `tags`. Article content is fetched where available.

---

## Installation

Manual install (plugin not yet in the Obsidian community directory):

1. Download `main.js`, `styles.css`, and `manifest.json` from the latest release.
2. Create a folder at `<your-vault>/.obsidian/plugins/x-bookmarks/`.
3. Copy the three files into that folder.
4. In Obsidian: Settings → Community plugins → enable **X Bookmarks**.

---

## Setup

### Step 1 — Create an X developer app

1. Go to the [X Developer Portal](https://developer.x.com/en/portal/dashboard).
2. Create a new app. Choose **Native App** as the app type (recommended — no client secret needed).
3. Set App Permissions to **Read only**.

### Step 2 — Add the redirect URI

In your app's **Authentication Settings**:

- Enable **OAuth 2.0**.
- Under **Redirect URIs**, add exactly:
  ```
  obsidian://x-bookmarks-auth
  ```
  (no trailing slash)

### Step 3 — Add a website URL

X requires a Website URL. Use `https://obsidian.md` — the plugin doesn't use it.

### Step 4 — Copy your Client ID

Find your **Client ID** under **Keys and Tokens** in the X app dashboard.

### Step 5 — Enter credentials in Obsidian

Open **Settings → X Bookmarks**:
- Toggle **Enable X bookmarks** on.
- Paste your **Client ID** (and Client Secret if you chose Confidential Client / Web App type).

### Step 6 — Connect

Click **Connect X** and complete the OAuth flow in your browser. Once authorised, your account handle will appear and folders will be fetched.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| **Bookmarks folder** | `X Bookmarks` | Vault folder for imported notes |
| **Tag on import** | _(empty)_ | Optional tag added to all bookmarks, e.g. `#to-read` or `#x` |
| **Organize by X folder** | On | Store bookmarks in `<vaultFolder>/<folder-slug>/` subfolders |
| **Tag by X folder** | On | Add the X folder slug as a tag in frontmatter |
| **Bookmark folder scope** | All | Import all bookmarks or only selected X bookmark folders |
| **Sync frequency (hours)** | 24 | Minimum hours between auto-fetches at Obsidian startup. Set 0 to disable. |

---

## Note format

```yaml
---
title: "Article title"
source: "https://x.com/handle/status/..."
tweet_id: "1234567890"
author: "[Display Name](https://x.com/handle)"
published: 2024-01-15T12:00:00.000Z
created: 2024-01-16T08:30:00.000Z
description: |
  Article description or tweet text
tags: [to-read, folder-slug]
---

Article body or tweet text (t.co links expanded)
```

---

## Troubleshooting

**Rate limits (429).** X's free API tier has tight rate limits. The plugin backs off automatically and shows a retry time. If you see repeated 429s, increase **Sync frequency** to reduce API calls.

**Jina 429s.** X native articles (`x.com/i/article/`) are fetched via Jina AI's reader. If Jina is rate-limited during a sync, the remaining native articles in that sync will save without body content. They'll pick up content on the next successful sync if the note is deleted first.

**Token expiry.** If you see "session expired — reconnect", go to Settings → X Bookmarks → Step 6 → Connect X to re-authorise.

**Migrating from Sessions.** If you previously used the X bookmarks feature inside the Sessions plugin:
- It is recommended to register a **separate X developer app** for this plugin, because sharing an app between two Obsidian plugins causes OAuth token refresh conflicts (both plugins try to rotate the same refresh token).
- Before connecting in X Bookmarks, disable Sessions's X integration to avoid both plugins fetching simultaneously and hitting rate limits faster.
- Existing bookmark notes in your vault will be skipped by the dedup logic (via `tweet_id` frontmatter), so no duplicates are created regardless.

**Body extraction is best-effort.** Article body content is fetched via regex scraping (`og:description`, `<article>` tags, etc.). Modern JS-rendered sites often return empty bodies — this is expected. The note will still be created with title, source, and description.
