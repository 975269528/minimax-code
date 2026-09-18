---
name: x-link-reader
description: "Read X/Twitter content from x.com or twitter.com URLs. Use when the user shares an X or Twitter link (tweet or profile) and asks about its content. Also use when webfetch fails on x.com with anti-bot errors. Bypasses X's anti-scraping via the FxTwitter API — no API key needed."
descriptions:
  zh-Hans: "读取 x.com 或 Twitter 链接内容，在网页抓取失败或遇到反爬时通过 FxTwitter API 获取信息。"
---

# X/Twitter Link Reader

X.com blocks direct HTTP fetching (returns anti-bot challenge pages). This skill
uses the open-source [FxTwitter](https://github.com/FixTweet/FxTweet) API to
retrieve tweet and profile data as structured JSON — free, no auth required.

## When to use

- User shares a URL matching `x.com/*/status/*` or `twitter.com/*/status/*`
- User shares a profile URL like `x.com/username`
- User asks "what does this tweet say", "summarize this post", etc.
- `webfetch` on an `x.com` URL returns an error or empty page

## Tweet: fetch a single post

Replace the domain with `api.fxtwitter.com` and fetch as **text**:

```
Original:  https://x.com/elonmusk/status/1234567890
Proxy:     https://api.fxtwitter.com/elonmusk/status/1234567890
```

Use `webfetch` with format `text` (the response is JSON):

```
webfetch url="https://api.fxtwitter.com/{user}/status/{id}" format="text"
```

### Tweet response structure

```jsonc
{
  "code": 200,
  "tweet": {
    "url": "https://x.com/user/status/123",
    "text": "The full tweet text",
    "author": {
      "name": "Display Name",
      "screen_name": "handle",
      "followers": 12345,
      "avatar_url": "https://..."
    },
    "created_at": "Sun Apr 05 19:32:37 +0000 2026",
    "replies": 20,
    "retweets": 181,
    "likes": 1424,
    "views": 116843,
    "lang": "en",
    "replying_to": "other_user",        // null if not a reply
    "quoted_status_result": { ... },     // quoted tweet, if any
    "media": {
      "photos": [{ "url": "..." }],
      "videos": [{ "url": "..." }]
    },
    "card": {
      "url": "...",
      "title": "...",
      "description": "..."
    }
  }
}
```

## Profile: fetch user info

```
webfetch url="https://api.fxtwitter.com/{username}" format="text"
```

Returns user profile data including name, bio, follower/following counts, etc.

## Translate a tweet

Append `/translate/{lang}` to the tweet path:

```
webfetch url="https://api.fxtwitter.com/{user}/status/{id}/translate/zh" format="text"
```

Supported language codes: `zh`, `en`, `ja`, `ko`, `es`, `fr`, `de`, etc.

## Key fields to present

1. **Author**: `tweet.author.name` (@`tweet.author.screen_name`)
2. **Text**: `tweet.text`
3. **Date**: `tweet.created_at`
4. **Engagement**: likes, retweets, replies, views
5. **Media**: photos/videos URLs if present
6. **Card**: linked article title/description if present
7. **Reply context**: who the tweet is replying to, if applicable

## Limitations

- **Individual tweets and profiles only** — no timelines, search, or batch.
- **Public content only** — private/protected accounts return errors.
- **Deleted tweets** — the API returns an error; report this to the user.
- **No write operations** — read-only, cannot post or interact.

## Rules

- Always use `api.fxtwitter.com`, never fetch `x.com` or `twitter.com` directly.
- This API is read-only and public — no API key or authentication needed.
- If the user just wants a tweet summary, present it concisely; don't dump raw JSON.
