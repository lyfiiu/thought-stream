import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageServerClient, readTranscriptFallbackSteps, readTranscriptTokenIndex } from './ls-client.mjs';
import { buildContentFingerprint, computeDiagnostics, groupIntoTurns, normalizeStatus, parseStep } from './step-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const lsClient = new LanguageServerClient();

// Track per-conversation last observed content fingerprint & timestamp so
// silenceMs accurately reflects real progress vs. a true hang.
const activityTracker = new Map(); // convId -> { fingerprint, changedAt }

function trackActivity(convId, fingerprint, now = Date.now()) {
  const prev = activityTracker.get(convId);
  if (!prev || prev.fingerprint !== fingerprint) {
    const next = { fingerprint, changedAt: now };
    activityTracker.set(convId, next);
    if (activityTracker.size > 64) {
      activityTracker.delete(activityTracker.keys().next().value);
    }
    return next.changedAt;
  }
  return prev.changedAt;
}

// Preferences persisted in PLUGIN_DATA if available.
function prefsPath() {
  const dir = process.env.ANTIGRAVITY_PLUGIN_DATA || process.env.PLUGIN_DATA || '';
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    return join(dir, 'thought-stream-prefs.json');
  } catch {
    return null;
  }
}

function loadPrefs() {
  const p = prefsPath();
  if (!p || !existsSync(p)) return { lang: 'zh', autoExpandThinking: true, showFocusMeta: true };
  try {
    return { lang: 'zh', autoExpandThinking: true, showFocusMeta: true, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch {
    return { lang: 'zh', autoExpandThinking: true, showFocusMeta: true };
  }
}

function savePrefs(patch) {
  const current = { ...loadPrefs(), ...(patch || {}) };
  const p = prefsPath();
  if (p) {
    try { writeFileSync(p, JSON.stringify(current, null, 2)); } catch {}
  }
  return current;
}

const stepCache = new Map(); // convId -> { steps: rawSteps[], stepCount: number }

async function fetchAllStepsPaged(convId, stepCountHint = null) {
  const cached = stepCache.get(convId);
  let steps = [];
  let offset = 0;

  if (cached && cached.steps.length > 0 && (stepCountHint === null || stepCountHint >= cached.steps.length)) {
    // Re-fetch from the earliest non-terminal step (or last 6 steps) so
    // completed prefixes are never re-downloaded on every 750ms poll.
    let firstMutable = cached.steps.findIndex((s) => {
      const st = normalizeStatus(s?.status);
      return st === 'RUNNING' || st === 'PENDING' || st === 'WAITING';
    });
    if (firstMutable < 0) {
      firstMutable = Math.max(0, cached.steps.length - 4);
    } else {
      firstMutable = Math.max(0, firstMutable - 1);
    }
    steps = cached.steps.slice(0, firstMutable);
    offset = firstMutable;
  }

  const maxPages = 60;
  for (let page = 0; page < maxPages; page++) {
    const batch = await lsClient.getTrajectorySteps(convId, offset);
    if (!batch.length) break;
    steps.push(...batch);
    offset += batch.length;
    if (Number.isInteger(stepCountHint) && offset >= stepCountHint) break;
    if (batch.length < 50 && stepCountHint === null) break;
  }

  stepCache.set(convId, { steps, stepCount: steps.length });
  if (stepCache.size > 24) {
    stepCache.delete(stepCache.keys().next().value);
  }
  return steps;
}

async function buildSubagentSummaries(convId, summaries, parsedSteps, now) {
  const childIds = new Set();
  for (const [id, val] of Object.entries(summaries)) {
    const meta = val?.trajectoryMetadata || {};
    if (meta.parentConversationId === convId || meta.rootConversationId === convId) {
      if (id !== convId) childIds.add(id);
    }
  }
  for (const s of parsedSteps) {
    if (s.childConversationId) childIds.add(s.childConversationId);
  }

  const results = [];
  for (const cid of [...childIds].slice(0, 12)) {
    const sum = summaries[cid];
    const runStatus = String(sum?.status || '').replace(/^CASCADE_RUN_STATUS_/, '') || 'UNKNOWN';
    let tailSteps = [];
    try {
      const count = Number(sum?.stepCount || 0);
      const start = Math.max(0, count - 6);
      tailSteps = await lsClient.getTrajectorySteps(cid, start);
    } catch {}
    const parsedTail = tailSteps.map((st, idx) => parseStep(st, idx, null, now));
    const latestTool = [...parsedTail].reverse().find((x) => x.kind === 'tool');
    const latestThought = [...parsedTail].reverse().find((x) => x.kind === 'planner' && x.thinking);
    const parentInvoke = parsedSteps.find((s) => s.childConversationId === cid);
    results.push({
      id: cid,
      title: parentInvoke?.target || sum?.summary || cid.slice(0, 8),
      runStatus,
      stepCount: sum?.stepCount || parsedTail.length,
      lastModifiedTime: sum?.lastModifiedTime || null,
      latestAction: latestTool ? `${latestTool.verb}: ${latestTool.target}` : (latestThought ? 'Thinking…' : runStatus),
      latestThinking: latestThought?.thinking?.slice(0, 400) || '',
      recentSteps: parsedTail.slice(-4),
    });
  }
  return results;
}

function buildFallbackFromTranscript(convId, now) {
  const rows = readTranscriptFallbackSteps(convId);
  const parsed = rows.map((r, i) => {
    const type = String(r.type || '');
    const status = normalizeStatus(r.status);
    if (type === 'USER_INPUT') {
      return { index: r.step_index ?? i, kind: 'user', rawType: type, status, createdAt: Date.parse(r.created_at) || null, text: r.content || '' };
    }
    if (type === 'PLANNER_RESPONSE') {
      return {
        index: r.step_index ?? i,
        kind: 'planner',
        rawType: type,
        status,
        createdAt: Date.parse(r.created_at) || null,
        thinking: r.thinking || '',
        thinkingLen: (r.thinking || '').length,
        thinkingDurationSec: null,
        response: r.content || '',
        responseLen: (r.content || '').length,
        toolCalls: Array.isArray(r.tool_calls) ? r.tool_calls : [],
        model: r.model || null,
        usage: {
          inputTokens: Number(r.input_tokens || 0) || 0,
          cacheReadTokens: Number(r.cache_read_tokens || 0) || 0,
          outputTokens: Number(r.output_tokens || 0) || 0,
          thinkingTokens: 0,
        },
      };
    }
    return {
      index: r.step_index ?? i,
      kind: 'tool',
      rawType: type,
      toolName: type.toLowerCase(),
      verb: type,
      category: 'tool',
      target: '',
      subtitle: '',
      status,
      createdAt: Date.parse(r.created_at) || null,
      durationMs: null,
      args: {},
      output: typeof r.content === 'string' ? r.content : '',
      outputMeta: '',
      isError: status === 'ERROR',
    };
  });
  return parsed;
}

async function getTraceSnapshot(requestedConvId, fallbackConvId = '') {
  const now = Date.now();
  let summaries = {};
  let lsError = null;

  try {
    summaries = await lsClient.getAllTrajectories();
  } catch (err) {
    lsError = err?.message || String(err);
  }

  const conversations = Object.entries(summaries)
    .map(([id, v]) => ({
      id,
      title: v?.annotations?.title || v?.summary || `Session ${id.slice(0, 8)}`,
      status: String(v?.status || '').replace(/^CASCADE_RUN_STATUS_/, '') || 'UNKNOWN',
      stepCount: v?.stepCount || 0,
      modifiedAt: v?.lastModifiedTime || v?.createdTime || '',
      parentConversationId: v?.trajectoryMetadata?.parentConversationId || null,
    }))
    .sort((a, b) => Date.parse(b.modifiedAt || 0) - Date.parse(a.modifiedAt || 0))
    .slice(0, 40);

  let targetId = GUID_RE.test(requestedConvId || '') ? requestedConvId : '';
  if (!targetId && GUID_RE.test(fallbackConvId || '')) {
    targetId = fallbackConvId;
  }
  if (!targetId && conversations.length > 0) {
    targetId = conversations[0].id;
  }

  if (!targetId) {
    return {
      now,
      conversationId: null,
      conversations,
      summary: null,
      turns: [],
      subagents: [],
      diagnostics: computeDiagnostics({
        connection: lsClient.getConnectionInfo(),
        summary: null,
        parsedSteps: [],
        subagents: [],
        lastChangeAt: null,
        now,
      }),
      source: lsError ? 'offline' : 'empty',
    };
  }

  const summary = summaries[targetId] || null;
  let parsedSteps = [];
  let source = 'live-rpc';
  let lastChangeAt = activityTracker.get(targetId)?.changedAt || now;

  if (!lsError) {
    try {
      const rawSteps = await fetchAllStepsPaged(targetId, summary?.stepCount ?? null);
      const tokenIndex = readTranscriptTokenIndex(targetId);
      const fp = `${summary?.status || ''}|${summary?.lastModifiedTime || ''}|${buildContentFingerprint(rawSteps)}`;
      lastChangeAt = trackActivity(targetId, fp, now);
      parsedSteps = rawSteps.map((s, idx) => parseStep(s, idx, tokenIndex, now));
    } catch (err) {
      lsError = err?.message || String(err);
    }
  }

  if (lsError && parsedSteps.length === 0) {
    parsedSteps = buildFallbackFromTranscript(targetId, now);
    source = 'transcript-fallback';
  }

  const subagents = !lsError
    ? await buildSubagentSummaries(targetId, summaries, parsedSteps, now)
    : [];

  const turns = groupIntoTurns(parsedSteps, now);
  const diagnostics = computeDiagnostics({
    connection: lsClient.getConnectionInfo(),
    summary,
    parsedSteps,
    subagents,
    lastChangeAt,
    now,
  });

  return {
    now,
    conversationId: targetId,
    title: summary?.annotations?.title || summary?.summary || `Session ${targetId.slice(0, 8)}`,
    conversations,
    turns,
    subagents,
    diagnostics,
    totalSteps: parsedSteps.length,
    source,
  };
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp, Response } = await import('sidecar_sdk');
  const app = new SidecarApp();

  for (const [route, [file, contentType]] of Object.entries(STATIC_FILES)) {
    const handler = () => new Response(readFileSync(join(PUBLIC_DIR, file), 'utf8'), {
      contentType,
      headers: { 'Cache-Control': 'no-store' },
    });
    if (route === '/') app.page(route, handler);
    else app.api(route, handler, 'GET');
  }

  app.api('/api/trace', async (data) => {
    const reqId = typeof data?.conversationId === 'string' ? data.conversationId : '';
    return getTraceSnapshot(reqId, app.config.conversationId || '');
  }, 'GET');

  app.api('/api/health', async () => {
    try {
      await lsClient.ensureEndpoint(false);
    } catch {}
    return {
      ok: lsClient.status === 'connected',
      connection: lsClient.getConnectionInfo(),
    };
  }, 'GET');

  app.api('/api/prefs', () => loadPrefs(), 'GET');
  app.api('/api/prefs', (data) => savePrefs(data), 'POST');

  await app.run();
} else {
  // Standalone local preview mode for testing outside sidecar runtime
  const port = Number(process.env.THOUGHT_STREAM_PORT || 17910);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('// standalone preview');
      return;
    }
    if (url.pathname === '/api/trace') {
      const snap = await getTraceSnapshot(url.searchParams.get('conversationId') || '', process.env.ANTIGRAVITY_CONVERSATION_ID || '');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snap));
      return;
    }
    if (url.pathname === '/api/prefs') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(loadPrefs()));
      return;
    }
    const stat = STATIC_FILES[url.pathname];
    if (stat) {
      res.writeHead(200, { 'Content-Type': stat[1] });
      res.end(readFileSync(join(PUBLIC_DIR, stat[0]), 'utf8'));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Thought Stream standalone preview: http://127.0.0.1:${port}`);
  });
}
