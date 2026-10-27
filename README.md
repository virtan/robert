# Robert

Robert is a self-hosted AI assistant for Telegram group chats. It reads everything said in the
group, remembers it, and speaks up only when someone asks it for something. It runs any model on
[OpenRouter](https://openrouter.ai), and you can switch models from the chat.

```
Anna:   We land in Lisbon Friday 14:20, hotel is near Alfama
Ben:    [voice message] "…can someone check if we need to book the tram?"
Robert: The 28 tram doesn't take reservations: you queue at Martim Moniz…   ← asked implicitly
Anna:   Robert, remind us Thursday at 9 to check in online
Robert: Done: reminder set for Thu 09:00.
```

## Features

- **Listens, then helps when asked.** It answers when you @mention it, reply to it, or use its
  name or a nickname (in any language). In *smart* mode, a cheap model also catches implicit
  requests ("can the bot check…"). When addressed it always answers, and if the model fails, it
  says so in the chat instead of going silent.
- **Understands media.** It sees photos and stickers, transcribes voice messages, audio and video,
  and reads PDFs and text files. When the current model can't see images, a vision model
  describes them instead.
- **Researches.** It can search the web, read linked pages, and search older chat history.
- **Acts.** It sets reminders (one-off, daily, weekly), takes on tasks for later ("when Igor shows
  up, suggest the change to him"), generates and edits images, and replies with voice messages.
- **Checks its work.** For arithmetic, counting and puzzles it runs JavaScript in an isolated
  sandbox instead of guessing (see [Privacy and security](#privacy-and-security)). It checks chat
  history before quoting people, and it knows the facts about itself (current model, context
  window, limits, spending) instead of making them up.
- **Follows the thread.** It sees edits, and each reply carries a quote of the message it answers,
  even one sent before Robert joined.
- **Remembers.** Every message is stored in a local SQLite database. Older conversation is folded
  into a rolling summary, so context stays small and cheap. On top of that, Robert keeps a
  long-term memory per chat: people, dates, addresses, contacts and wallet addresses, plans, big
  events, places and technologies, each with who mentioned it. It never stores passwords, keys,
  seed phrases or card numbers.
- **Any model, switchable from Telegram.** Use `/model opus`, tap a preset, or say "Robert, switch
  to Gemini Flash" (owner only). Ask "which models are there?" for a short list with what each
  is best for and roughly what an answer costs. It detects model capabilities (vision, audio,
  files, tools) from OpenRouter.
- **Controls cost.** A daily spending cap, a per-user rate limit, and `/status` to see what you
  spent today.
- **Easy setup.** A wizard creates the bot for you through @BotFather, turns off privacy mode, adds
  the bot to a group, and installs a background service.
- **No secrets in the repo.** It needs only an OpenRouter key and a Telegram bot token, both
  stored outside the code in a file only your user can read.

## Requirements

- Linux or macOS (Windows is untested and has no service installer)
- [Node.js](https://nodejs.org) 22.18 or newer (Robert runs TypeScript directly, so there's no build step)
- An [OpenRouter](https://openrouter.ai/settings/keys) API key with some credit
- A Telegram account
- Optional: [ffmpeg](https://ffmpeg.org), for video frames and native voice-message replies

## Quick start

```sh
git clone https://github.com/virtan/robert.git
cd robert
npm ci
npm run setup
```

The wizard does five things:

1. **OpenRouter:** asks for your API key and validates it.
2. **Telegram bot:** creates one automatically, or accepts a token you paste.
   - *Automatic:* you enter an `api_id`/`api_hash` from [my.telegram.org](https://my.telegram.org),
     then log in by scanning a QR code with the Telegram app (Settings → Devices → Link Desktop
     Device), or with your phone number and a login code. The wizard says where Telegram sent the
     code (usually as a message from "Telegram" inside the app, not by SMS) and can re-send it by SMS
     or call. Then it talks to @BotFather for you: it creates
     the bot, disables group privacy mode, sets a description, and can add the bot to one of your
     groups. It ends by **logging out the temporary session**. Your account credentials are never
     written to disk.
   - *Manual:* create the bot in @BotFather yourself (`/newbot`, then `/setprivacy` → Disable) and
     paste the token. The wizard checks that privacy mode is really off.
3. **Owner:** records your Telegram user id. Only the owner can change models and settings, and
   approve groups.
4. **Preferences:** the names and nicknames Robert answers to, your time zone, the default model
   (from the recommended list) and a daily budget.
5. **Run:** optionally installs a background service that starts at boot and restarts on failure.

Then add the bot to a group (if the wizard didn't) and say hi.

Run `npm run doctor` any time to check the installation (tokens, privacy mode, model
availability, credit), and `npm run status` to see how Robert is running. To get a newer version
later, run `npm run update` (see [Updating](#updating)).

## Using it

| How to get an answer | Example |
|---|---|
| Mention it | `@my_robert_bot what's the weather in Porto?` |
| Reply to one of its messages | *(reply)* `and tomorrow?` |
| Edit a recent message to add its name | `what time is the train` → `Robert, what time is the train?` |
| Use its name | `Robert, translate this to Spanish` |
| Voice message that says its name | 🎤 "Robert, add milk to the list…" |
| Implicit request (*smart* mode) | `can the bot find a pharmacy open now?` |
| Direct message (owner) | anything |

Commands:

| Command | Who | What |
|---|---|---|
| `/help` | everyone | What Robert can do |
| `/model` | everyone sees, owner changes | Shows the model; the owner gets preset buttons |
| `/model <name>` | owner | Switch this chat's model, e.g. `/model opus`, `/model google/gemini-3.8-flash` |
| `/model global <name>` | owner | Change the default model for all chats |
| `/model default` | owner | Make this chat use the default model again |
| `/models` | everyone | Recommended models with what each is best for and its cost per answer |
| `/models all` | everyone | A longer list: the newest model of each major family |
| `/models <words>` | everyone | Search all OpenRouter models, e.g. `/models grok` |
| `/mode smart\|direct` | owner | *smart* also answers implicit requests; *direct* only answers when addressed |
| `/names <list>` | owner | Names and nicknames Robert answers to, e.g. `/names Robert, Rob, Роберт*, Роб` |
| `/status` | everyone | Model, mode, today's spending, memory size |
| `/summary` | everyone | Summary of the recent conversation |
| `/memory [words]` | everyone | Long-term memories of this chat, or the ones matching the words |
| `/memory forget <id>` | owner | Delete one memory (people can also ask Robert to correct facts they mentioned) |
| `/budget <usd>` | owner | Daily spending limit (0 = unlimited) |
| `/forget` | owner | Erase this chat's stored messages, media and memories |
| `/leave` | owner | Remove Robert from the group |

The owner can also ask in plain language: "Robert, switch to Claude Opus for this chat".

### Groups and approval

Robert only works in groups the owner has approved:

- If **you** add it to a group, the group is approved automatically.
- If **someone else** adds it, Robert stays silent and stores nothing. You get a DM with
  **Approve** / **Leave** buttons. You can also send `/approve` in that group.

DMs are answered only for the owner by default. Set `"allowDms": "members"` to also answer
people who take part in approved groups.

## Models and cost

Robert uses several models, each configurable in `config.json`:

| Role | Default | Used for |
|---|---|---|
| `chat` | `meta/muse-spark-open` | Answers (switchable per chat with `/model`) |
| `judge` | `anthropic/claude-haiku-5.5` | Deciding whether an implicit message is meant for Robert |
| `summary` | `anthropic/claude-haiku-5.5` | Rolling summary of older conversation |
| `memory` | `anthropic/claude-haiku-5.5` | Picking durable facts for the long-term memory |
| `vision` | `anthropic/claude-haiku-5.5` | Describing images for models that can't see; `look_at` |
| `transcribe` | `openai/gpt-4o-mini-transcribe` | Voice, audio and video transcription |
| `tts` | `google/gemini-3.8-flash-tts` | Voice replies (voice `Kore`, set with `ttsVoice`) |
| `image` | `google/gemini-3.1-flash-image` | Image generation and editing |

Web search and page fetching use OpenRouter's server-side `openrouter:web_search` and
`openrouter:web_fetch` tools. They are billed through the same key.

What costs money in an active group:

- **Every voice message is transcribed** when it arrives, so Robert can hear its name and remember
  what was said.
- **In smart mode, each burst of messages costs one small judge call.** Bursts are messages within
  a few seconds of each other. Use `/mode direct` to switch this off.
- **Long-term memory** costs one small call per 30 messages, or when a chat goes quiet for
  15 minutes. Set `"memory": false` to turn it off.
- **Answers** cost whatever the chosen model costs.

The daily budget (default $5) stops all paid calls for the rest of the UTC day once it's reached.
`/status` shows the day's spending. You can also set a credit limit on the OpenRouter key itself.

## Configuration

Everything lives in the data directory, `~/.robert` by default (set `ROBERT_HOME` to change it):

| File | What |
|---|---|
| `.env` | `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN` (mode 600) |
| `config.json` | Settings that differ from the defaults (see below) |
| `robert.db` | SQLite database: messages, summaries, long-term memories, reminders, waiting tasks, usage |
| `media/` | Photos, PDFs and audio received from Telegram |
| `models-cache.json` | OpenRouter's model list, refreshed every 6 hours |
| `system-prompt.md` | Optional: overrides [`prompts/system.md`](prompts/system.md) |

Environment variables take precedence over `.env`, so you can also run Robert with
`OPENROUTER_API_KEY=… TELEGRAM_BOT_TOKEN=… ROBERT_OWNER_ID=… npm start` and no setup at all.

`config.json` keys (all optional except `ownerId`):

```jsonc
{
  "ownerId": 123456789,               // Telegram user id of the owner
  "names": ["Robert", "Роберт*", "Bob"], // what it answers to; * also matches inflected forms
  "timezone": "Europe/Lisbon",        // for reminders and timestamps
  "models": { "chat": "openai/gpt-6.1-sol" }, // any role from the table above
  "modelPresets": [                   // the recommended list and /model buttons
    { "id": "meta/muse-spark-open", "bestFor": "everyday chat and research at a low price" },
    "anthropic/claude-opus-5.5"       // a plain id works too; its strengths come from OpenRouter
  ],
  "ttsVoice": "Kore",
  "defaultMode": "smart",             // or "direct"
  "dailyBudgetUsd": 5,                // 0 = unlimited
  "historyTokens": 24000,             // recent conversation sent verbatim; the rest is summarized
  "maxAttachments": 4,                // recent images/PDFs attached as real media
  "maxAsksPerUserPerHour": 40,        // the owner is exempt
  "retentionDays": 0,                 // delete older messages and media; 0 = keep forever
  "allowDms": "owner",                // or "members"
  "memory": true,                     // long-term memory of people, dates, places, plans…
  "runCode": true                     // false removes the run_js sandbox tool
}
```

Restart after editing: `node bin/robert.ts service restart`, or the way `npm run status` shows.
Settings you can change from Telegram (`/model`, `/names`, `/budget`) apply right away.

## Running it

**As a service:** `npm run setup` offers this. You can also run it any time:

```sh
node bin/robert.ts service install            # Linux: systemd user unit; macOS: launchd agent
node bin/robert.ts service install --system   # Linux: hardened system unit (prints sudo steps)
node bin/robert.ts service uninstall
```

- On Linux, a user service needs `sudo loginctl enable-linger $USER` to keep running after you log
  out and to start at boot. The installer reminds you.
- Logs: `journalctl --user -u robert -f` on Linux, `~/.robert/robert.log` on macOS.

**With Docker:**

```sh
docker compose run --rm robert setup   # interactive; saves secrets in the robert-data volume
docker compose up -d
docker compose logs -f
```

**In the foreground:** `npm start`.

`npm link` puts a `robert` command on your PATH, so `node bin/robert.ts …` becomes `robert …`.

Run only one instance per bot token. Telegram delivers each update to a single poller.

### Updating

```sh
npm run status   # how Robert runs here (service, Docker or by hand), from where, and which version
npm run update   # git pull, npm ci, then always restart it the way it runs
```

`npm run update` restarts services and Docker by itself. A copy started by hand has to be
restarted by hand; the command tells you which process it is. The database upgrades itself on start,
and new default settings apply unless you changed that setting yourself.

Installs from before `npm run update` existed need one manual update first:
`git pull && npm ci`, then restart Robert (`npm run status` shows how).

## Troubleshooting

- **It doesn't answer when called by a nickname.** Add the nicknames people actually use:
  `/names Robert, Rob, Роберт*, Роб`. In *direct* mode it also ignores implicit requests.
- **It doesn't react to normal messages in a group at all.** Group privacy mode is probably on.
  `npm run doctor` checks it. Fix it in @BotFather (`/setprivacy` → Disable), then remove the bot
  from the group and add it back.
- **It went quiet, or answers look odd.** Check the log (see [Running it](#running-it)): every
  skipped message says why (not addressed, judge said no, hourly limit, daily budget, model error).
- **It seems to run an old version, or answers twice.** `npm run status` shows every running
  copy, where it runs from and its version. Only one copy per bot token should run.
- **Setup's login code never arrives.** Choose the QR code login instead, or press Enter at the
  code prompt to get the code by SMS or call.

## Privacy and security

- Robert stores every message from approved chats, plus downloaded media and long-term memories,
  on your server. It tells the group so in its greeting and in `/help`. Anyone can see the
  memories with `/memory`. `/forget` erases a chat, and `retentionDays` sets an automatic expiry
  (for memories, counted from their last update).
- Memories never include passwords, private keys, seed phrases, card numbers or one-time codes:
  the model is told not to record them, and a filter in code drops anything that looks like one.
- Message content is sent to OpenRouter and the model provider you choose. Pick providers whose
  data policy you accept (OpenRouter has
  [privacy settings and ZDR routing](https://openrouter.ai/settings/privacy)).
- Forwarded messages, web pages, files and search results are marked as information, not
  instructions. Model switching and settings are checked against the owner's Telegram id in code,
  not left to the model.
- Robert can't run commands, write files, or reach your local network. Web fetching runs on
  OpenRouter's side.
- The `run_js` tool runs model-written JavaScript in [QuickJS](https://github.com/justjake/quickjs-emscripten)
  compiled to WebAssembly, on a separate worker thread with an empty environment. The guest has no
  `require`/`import`, `process`, files, network, environment variables or timers, only a `console`
  that returns text. It stops after 5 seconds or 64 MB, and the worker is killed if it doesn't.
  Set `"runCode": false` to remove the tool.
- Tokens are redacted from logs, and the data directory is created with owner-only permissions.
- The automatic bot creation uses your account only during setup, then logs out the session.
  You can confirm in Telegram → Settings → Devices.

## Limitations

- Bots can't download files larger than 20 MB (a Telegram Bot API limit).
- Robert can't see messages sent before it joined a group, except the text quoted in replies.
- Telegram doesn't tell bots about deleted messages, so Robert keeps them.
- If you change privacy mode while the bot is already in a group, remove the bot and add it back.
  Telegram only applies the change on join.
- In forum supergroups, all topics share one memory. Replies go to the right topic.
- The voice-reply cost isn't counted toward the daily budget, because the speech endpoint doesn't
  report it.

## Development

```sh
npm test            # unit tests plus end-to-end tests against a fake Telegram and a fake OpenRouter
npm run typecheck
```

| Path | What |
|---|---|
| `src/bot.ts` | Telegram side: ingesting messages and media, triggers, commands, approval, sending |
| `src/brain.ts` | The LLM side: answer loop with tools, judge, rolling summary, vision fallback |
| `src/context.ts` | Turns stored messages into the model's context, within a token budget |
| `src/tools.ts` | Tools the model can call (history search, reminders, waiting tasks, code, images, voice, models) |
| `src/sandbox/` | The isolated JavaScript sandbox behind `run_js` |
| `src/memory.ts` | Long-term memory: picking facts, the secret filter, the prompt section |
| `src/openrouter.ts` | Minimal OpenRouter client: chat, transcription, speech, images, models |
| `src/db.ts` | SQLite schema and queries (`node:sqlite`, full-text search with FTS5) |
| `src/setup/` | Setup wizard, Telegram login (QR or code) and @BotFather automation (GramJS) |
| `src/status.ts` | `status` and `update`: how Robert runs here, and updating it |
| `src/service.ts`, `src/doctor.ts` | Service installers (systemd, launchd) and installation checks |
| `prompts/system.md` | The system prompt template |

## License

MIT
