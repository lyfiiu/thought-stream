# Thought Stream

A **Claude Code-style** real-time chain-of-thought, tool call tree, subagent trace, and connection/stall heartbeat monitor plugin for **Antigravity**.

> Solves the problem where Antigravity's default chat UI only shows generic `Working...` / `Thinking...` states without revealing raw reasoning, exact tool arguments, subagent progress, or whether the agent is waiting for approval, stalled, or disconnected.

---

## Features

- **Full Chain-of-Thought (`∴ Thinking`)**
  - Streams raw `plannerResponse.thinking`, thinking duration, and thinking token counts (`thinkingOutputTokens`) instead of hiding them behind generic status text.
  - Collapsible per-step blocks with auto-expand toggle.
- **Claude Code–Style Tool Call Tree**
  - Categorizes steps into crisp `Read`, `Bash`, `Edit`, `Write`, `Search`, `Web`, `Agent`, `Plan`, and `Focus` nodes.
  - Shows exact target paths/commands, live duration timers, single-line `⎿` previews, and click-to-expand full JSON arguments & execution output.
- **Stall, Approval & Disconnect Diagnostics**
  - **Live RPC Heartbeat**: Polls Antigravity Language Server `/healthz` + `GetCascadeTrajectorySteps` with latency (`ms`) and a 16-bar heartbeat sparkline.
  - **Now-Happening Banner**: Immediately distinguishes `RUNNING`, `WAITING` (awaiting user approval/input), `SLOW` (>15s without step progress), `STALLED` (>45s no change), and `DISCONNECTED`.
  - **Auto-Recovery & Offline Fallback**: Scans `~/.gemini/antigravity/daemon/` if the Language Server port changes, and falls back to local `transcript_full.jsonl` / `transcript.jsonl` when offline.
- **Subagent Tracing**
  - Discovers child subagent conversations (`invoke_subagent`) and lets you jump into any subagent's live trace with one click.
- **Bilingual & Theme-Aware**
  - Switches between `中文` / `EN` and automatically syncs with Antigravity Light & Dark themes.

---

## Installation

Clone directly into Antigravity's global plugins directory:

```bash
git clone https://github.com/lyfiiu/thought-stream.git ~/.gemini/config/plugins/thought-stream
```

Antigravity discovers plugins under `~/.gemini/config/plugins/` automatically (no manual build step required; it uses Antigravity's bundled Node + `sidecar_sdk` runtime).

Open the side panel from the **`+`** menu in the Auxiliary Pane → **Thought Stream**.

---

## Architecture

```text
thought-stream/
├── plugin.json                        # Antigravity plugin manifest
├── assets/logo.svg                    # Plugin icon
└── sidecars/trace_panel/
    ├── sidecar.json                   # AUX_PANE sidecar definition
    ├── package.json
    ├── main.mjs                       # Sidecar HTTP server (/api/trace, /api/health, /api/prefs)
    ├── ls-client.mjs                  # Language Server RPC client + daemon discovery + transcript fallback
    ├── step-parser.mjs                # Claude Code-style step normalizer, turn grouper & stall diagnostics
    └── public/
        ├── index.html
        ├── styles.css
        └── app.js
```

## License

MIT
