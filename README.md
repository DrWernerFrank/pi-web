# pi-web

A browser GUI for the [pi](https://github.com/earendil-works/pi) coding agent. It runs where pi runs (here: WSL) and you open it in Chrome on Windows at **http://localhost:3141**.

- **Read every pi session**, rendered properly: LaTeX math, mermaid diagrams, Obsidian `![[viz-….png|500]]` images and callouts, code highlighting, Persian (right-to-left) mixed with English. It replaces the Obsidian + `/md-log` workaround; nothing needs linking.
- **Live**: while pi works in your terminal, the page updates on its own as each message is saved.
- **Chat from the browser**: start new chats or continue old ones. Replies stream in, and you get a Stop button, steering while pi works, a model and thinking picker, `/` commands and `!shell` commands.
- **Copy anything**: every prompt and every reply has a Copy button (visible without hovering), code blocks have one too, and while a reply is still streaming you get “Copy text so far”. `/copy` copies the last reply.
- **Attach files**: drag & drop anywhere on the page, Ctrl+V, or the 📎 button next to the message box. Images (PNG/JPEG/GIF/WebP, up to 15 MB) go into the chat; any other file (up to 32 MB) is saved into `pi-web-uploads/` in the session's folder and its **path is pasted into the message box**, so pi can read it like any file. (pi sessions, not Antigravity ones.)
- **Quizzes and questions in the page**: your `quiz` and `ask_user_question` tools open as clickable cards: pick an option, flag "I'm not sure", add a note, "I don't know", or type a free answer. Other extension dialogs appear as pop-ups.
- **Subagents**:
  - While one runs, a strip above the message box shows it with a running timer, and the sidebar shows "N subagents running", with the subagent listed under its parent.
  - **Watch** (on the strip, the launch card or the result card) opens that subagent's session in a side panel that follows it live. ⤢ opens it as a full page.
- **Context and plan usage** under the message box:
  - **Context**: how full the context window is, for any session, including ones running in your terminal. It turns amber at 70% and red at 90%.
  - **5h** and **Week**: your Claude subscription's 5-hour and weekly limits, with reset times. The home page shows them too.

## Google Antigravity, in the same place

If Antigravity is installed (its data is in `C:\Users\<you>\.gemini\antigravity`), its conversations appear in the sidebar under **Antigravity**, next to your pi sessions.

- **Reading** works whether the app is open or not. Messages, thinking, tool calls with their output and images, subagent messages and context checkpoints all render like pi sessions, and update live while Antigravity works.
- **Artifacts** (plans, write-ups: the markdown files Antigravity writes) are listed above the message box. Clicking one opens it in the side panel, and it refreshes while Antigravity edits it.
- **Subagents**: Antigravity's subagents are nested under their parent and show in the running strip. **Watch** opens them in the side panel.
- **Chatting** works with or without the app: pi-web starts its own **headless Antigravity language server** on demand (the same flags the app uses — the recipe the motion-studio bridge decoded), reuses one that's already running (including the studio bridge's — they share a token), and the server stays up across restarts. New chat → **Antigravity** starts a conversation (model Flash / Pro / Flash Lite), and the message box continues an existing one. Replies stream in here, and the conversation also appears in the app if it's open.
  - A follow-up sent from pi-web reaches the agent as a message from outside the app. Antigravity labels it a system message, and pi-web shows it as yours, marked "sent from pi-web". A new conversation's first message is a normal user message.
  - Set `PI_WEB_AGY_HEADLESS=1` to always use the headless server (never the app's), `PI_WEB_AGY_HEADLESS_PORT` to change its port (default 5387). Its log: `~/.cache/pi-web/agy-headless.log`.
  - Stopping a run and approving actions happen in the app.
- **Projects (the pi ↔ Antigravity sync)**: an Antigravity conversation runs inside a project's workspace folder — the same folder pi works. New chat → **Antigravity** has a *Project folder* field, and a pi session's ⋯ menu → **Antigravity: chat about this project** prefills it with that session's folder. pi-web finds or creates the Antigravity project for the folder (a small JSON file in `~/.gemini/config/projects/`; no app clicks), starts the conversation bound to it, and it appears in the sidebar under that folder, next to your pi sessions of the same project. Antigravity's agents read and edit that folder with their own tools; follow-ups from pi-web keep the binding, and the conversation also appears in the Antigravity app since the data is shared.
- **Quota**: while the app is open, the status bar shows your most-used Antigravity models' quota with reset times, and the home page lists all models.

How: pi-web reads Antigravity's files, polling since Windows changes are invisible to WSL's file watching. It copies the summaries database before reading it, so the app's own copy is never locked. To chat, it finds the running app's local language server (its port and CSRF token, read from the process list and never stored) and uses Antigravity's own `agentapi` command. Set `PI_WEB_NO_ANTIGRAVITY=1` to turn all of this off, or `PI_WEB_ANTIGRAVITY_DIR` to point elsewhere.

## Gemini, for reading images

Click any image (your own uploads, `![[viz-…]]` embeds, images in sessions) to open it large. A **Read with Gemini** panel sits next to it: type what you want to know and the answer streams in — Gemini sees images, including on models that can't.

- **Auth, in order**: your Google account (Google AI Pro / Code Assist subscription — the same login the `gemini` CLI uses, `~/.gemini/oauth_creds.json`, refreshed by pi-web; also picks up a Windows-side CLI login) → `GEMINI_API_KEY` (or `GOOGLE_API_KEY` from your shell / pi-web's `.env`) → nothing.
- **First run**: ⋯ → **Gemini…** opens the login. One browser consent click with the Google account of your subscription; no API key. The login is shared with the `gemini` CLI.
- A CLI login that only has `cloud-platform` scope goes through Cloud Code Assist and needs a project on the account; a login made by this page (or a newer CLI) has the consumer `generative-language` scope and needs none.
- Errors are surfaced in the panel; “no Gemini auth…” offers the login button right there.
- The model defaults to `gemini-2.5-flash` (set `GEMINI_MODEL` to override). Tokens never reach the browser.

### Agents and subagents

Every pi process — the one in your terminal, pi-web's, and subagents — also gets a **`read_image` tool** (from `~/.pi/agent/extensions/gemini-vision.ts`). Same auth as above, same auth order, errors phrased for the agent.

Subagents are spawned with `--no-extensions` and only the extensions backing their allowlisted tools, so:

- the extension registers `read_image` with the interactive-subagents extension (`registerToolExtension`), and
- an agent gets the tool exactly when its `tools:` frontmatter lists it (`worker` and `researcher` already do).

So an agent that needs an image read dispatches a worker/researcher with the path, and the subagent calls `read_image`. A model that can see images itself can call the tool directly too.

## Start it

**From Windows:** double-click `Pi Web.cmd` (you can drag a shortcut of it to your Desktop or taskbar). It starts pi-web inside WSL, opens your browser, and leaves a window showing the pi-web log and any subagents. You can close that window; pi-web keeps running.

**From WSL:**

```bash
pi-web            # start (in the background, inside tmux) and open the browser
pi-web stop       # stop it and every pi it started
pi-web status
pi-web logs       # show the server window (Ctrl+b then d to leave it)
pi-web restart
pi-web run        # run in this terminal instead (Ctrl+C stops it)
```

`pi-web` is a link in `~/.local/bin` to `bin/pi-web` in this folder.

## Using it with pi in the terminal

A session can be driven by **one** pi at a time.

- **Reading only**: keep using `learn` / pi in the terminal and keep the page open next to it. The page shows **live in terminal** for that session. If a quiz is waiting, answer it in the terminal: only the pi that asked can receive the answer.
- **Switching to the browser**: quit pi in the terminal (`/quit`), then type in the page. pi-web starts its own pi on the same session file, with your settings, skills, extensions and project `.pi` config, and continues where you left off.
- If you send from the page while the terminal pi is still running, pi-web warns you first: two pis on one session fork the conversation.

pi processes started by the page stop after 20 minutes idle with no page open on them, or right away with **⋯ → Stop pi** or `/quit`.

## Commands in the message box

| Type | Does |
|---|---|
| `/` | Command menu: your skills (`/skill:teach …`), extension commands (`/learn`, `/md-log`, …) and the ones below |
| `/model`, `/thinking high` | Choose the model / thinking level. The picker also opens from the model button next to the message box; models without thinking levels say so there |
| `/name My topic` | Rename the session |
| `/compact` | Summarize older context |
| `/new`, `/resume` | New chat / find a session |
| `/copy`, `/export`, `/session`, `/quit` | Copy last reply, export HTML, session info, stop pi |
| `!command` | Run a shell command in the session's folder. pi sees the output on your next message. `!!command` hides it from pi |
| Drag & drop / Ctrl+V / 📎 | Attach files: images go into the chat; other files' paths land in the box |
| Enter / Shift+Enter | Send / new line. While pi works, Enter steers it and Alt+Enter queues a message for after it finishes. Esc stops |

Quiz keys: `1`–`9` choose, `Enter` submits, `U` toggles "I'm not sure".

Terminal-only pi commands (`/tree`, `/fork`, `/settings`, `/login`, …) are still available in pi's terminal UI.

## How it works

```
Chrome (Windows) ──http──▶ pi-web server (Node, in WSL, tmux session "pi-web")
                               ├─ reads/watches ~/.pi/agent/sessions/**/*.jsonl  (the reader)
                               └─ runs `pi --mode rpc --session <file> -e bridge/pi-web-bridge.ts`
                                     per session you chat in (pi's official RPC mode)
```

- **RPC mode** streams pi's events to the page and forwards standard extension dialogs.
- **`bridge/pi-web-bridge.ts`** is a small pi extension loaded only into those processes. In RPC mode pi cannot show terminal pop-ups (`ctx.ui.custom()`), which would make quizzes look "cancelled". The bridge sends them to the page over a private socket instead: quiz and ask_user_question become native cards, and any other pop-up is drawn as terminal text you can type into.
- The server captures your interactive shell environment (`~/.bashrc`: PATH, API keys, `PI_VIZ_DIR`, …) so its pi behaves exactly like the one in your terminal.
- `![[image.png]]` embeds are looked up in `$PI_VIZ_DIR`, its parent folder (your vault), and the session folder's `viz/`.
- **Plan usage** comes from Anthropic's usage endpoint (`api.anthropic.com/api/oauth/usage`). It's read with the Claude sign-in pi saved in `~/.pi/agent/auth.json`, checked at most once a minute. pi-web only reads that file. The token goes only to Anthropic, never to the page, and pi itself renews it. If pi's sign-in has expired, the status bar says "Claude usage unavailable" until pi next uses Claude and renews it.
- **Context window sizes** come from pi's model catalog (`models-store.json`, your `models.json`) plus what each running pi reports (cached in `~/.cache/pi-web/model-windows.json`). That covers extension models like `claude-bridge/*` after pi-web has run pi once.
- **Subagent state** is read from the parent session: a launch record, and later a "finished/failed" report. A subagent with no report whose session has been quiet for 15 minutes shows as stopped.

## Settings

Environment variables (set before `pi-web`, e.g. in `~/.bashrc`):

| Variable | Meaning |
|---|---|
| `PI_WEB_PORT` | Port (default 3141) |
| `PI_WEB_ASSET_DIRS` | Extra folders for `![[image]]` embeds, `:`-separated |
| `PI_WEB_PI_ARGS` | Extra arguments for every pi pi-web starts, e.g. `--model tokenharbor/deepseek-v4.1-flash:free` |
| `PI_WEB_NO_TMUX` | Set to 1 to run without tmux (subagents then can't open panes) |
| `PI_WEB_NO_ANTIGRAVITY` | Set to 1 to hide Antigravity |
| `PI_WEB_ANTIGRAVITY_DIR` | Antigravity's data folder, if it isn't `C:\Users\<you>\.gemini\antigravity` |

The page itself (**⋯** menu): show/hide tool calls and thinking, light/dark/auto theme, text size.

## Safety

pi-web can run pi, and pi can run commands, so the server only listens on `127.0.0.1`. It rejects requests with a foreign `Host` header (blocks DNS rebinding) and requires a per-run token on every action (blocks other websites). Images from the internet inside messages are not loaded automatically: a model could leak data through an image URL. They show as links instead.

## Troubleshooting

- **Page won't load**: run `pi-web status` in WSL; if it's not running, `pi-web logs` shows why.
- **"pi not found"**: start pi-web from a shell where `pi` works (the launcher uses `bash -lic`, so `~/.bashrc` is loaded).
- **Port busy**: `pi-web --port 3150`.
- **Quizzes show as "Skipped"** in a browser chat: the bridge could not connect; see the server log (`pi-web logs`).
- Libraries missing after moving the folder: `npm install` in this folder.
- **Antigravity shows "app closed"** while it's open: pi-web looks for the app about every 15 seconds, so wait a moment. If a new Antigravity chat fails with a capacity error (503), Google has no room for that model right now; pick another one.
