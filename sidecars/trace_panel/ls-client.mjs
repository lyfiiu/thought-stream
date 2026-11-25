import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const DAEMON_FILE_RE = /^(?:ls|hub)_[^/\\]+\.json$/i;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function parseAddress(addr) {
  if (typeof addr !== 'string' || !addr.trim()) return null;
  const raw = addr.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const host = u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? '127.0.0.1' : u.hostname;
    return { host, port };
  } catch {
    return null;
  }
}

function findDaemonDirs() {
  const dirs = [];
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'daemon'))) dirs.push(join(appData, 'daemon'));
        break;
      }
    }
  }
  const geminiRoot = join(homedir(), '.gemini');
  try {
    for (const entry of readdirSync(geminiRoot)) {
      const candidate = join(geminiRoot, entry, 'daemon');
      if (existsSync(candidate) && !dirs.includes(candidate)) {
        dirs.push(candidate);
      }
    }
  } catch {}
  return dirs;
}

export function findBrainRoots() {
  const roots = [];
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const brain = join(dirname(d), 'brain');
        if (existsSync(brain)) roots.push(brain);
        break;
      }
    }
  }
  const geminiRoot = join(homedir(), '.gemini');
  try {
    for (const entry of readdirSync(geminiRoot)) {
      const brain = join(geminiRoot, entry, 'brain');
      if (existsSync(brain) && !roots.includes(brain)) {
        roots.push(brain);
      }
    }
  } catch {}
  return roots;
}

function readDaemonCandidates() {
  const records = [];
  for (const dir of findDaemonDirs()) {
    let files = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!DAEMON_FILE_RE.test(name)) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        const parsed = JSON.parse(readFileSync(full, 'utf8'));
        const port = Number(parsed?.httpPort);
        const pid = Number(parsed?.pid);
        const csrf = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
        if (Number.isInteger(port) && port > 0 && csrf && isPidAlive(pid)) {
          records.push({ host: '127.0.0.1', port, csrf, pid, mtimeMs: st.mtimeMs, source: 'daemon-file' });
        }
      } catch {}
    }
  }
  records.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return records;
}

function httpRequest({ host, port, method, path, headers = {}, body = null, timeoutMs = 3500 }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request(
      {
        hostname: host,
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode || 0,
            text,
            latencyMs: Date.now() - started,
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

export class LanguageServerClient {
  constructor() {
    this.endpoint = null;
    this.status = 'connecting'; // 'connected' | 'reconnecting' | 'disconnected'
    this.latencyMs = null;
    this.lastOkAt = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.lastDiscoverAt = 0;
  }

  async ensureEndpoint(force = false) {
    if (!force && this.endpoint) return this.endpoint;

    const envAddr = parseAddress(process.env.ANTIGRAVITY_LS_ADDRESS);
    const envCsrf = typeof process.env.ANTIGRAVITY_CSRF_TOKEN === 'string'
      ? process.env.ANTIGRAVITY_CSRF_TOKEN.trim()
      : '';

    const candidates = [];
    if (envAddr && envCsrf) {
      candidates.push({ ...envAddr, csrf: envCsrf, pid: null, source: 'env' });
    }
    for (const rec of readDaemonCandidates()) {
      if (!candidates.some((c) => c.port === rec.port && c.csrf === rec.csrf)) {
        candidates.push(rec);
      }
    }

    let lastErr = null;
    for (const cand of candidates) {
      try {
        const res = await httpRequest({
          host: cand.host,
          port: cand.port,
          method: 'GET',
          path: '/healthz',
          timeoutMs: 1500,
        });
        if (res.status >= 200 && res.status < 500) {
          this.endpoint = cand;
          this.latencyMs = res.latencyMs;
          this.lastOkAt = Date.now();
          this.lastDiscoverAt = Date.now();
          this.status = 'connected';
          this.consecutiveFailures = 0;
          this.lastError = null;
          return cand;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    this.consecutiveFailures++;
    this.status = this.consecutiveFailures >= 3 ? 'disconnected' : 'reconnecting';
    this.lastError = lastErr?.message || (candidates.length ? 'Language Server healthz failed' : 'No Language Server endpoint found');
    throw new Error(this.lastError);
  }

  async call(method, body = {}, timeoutMs = 4500) {
    let ep = await this.ensureEndpoint(false);
    const payload = JSON.stringify(body);
    try {
      const res = await httpRequest({
        host: ep.host,
        port: ep.port,
        method: 'POST',
        path: SERVICE_PREFIX + method,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': ep.csrf,
          'Content-Length': Buffer.byteLength(payload),
        },
        body: payload,
        timeoutMs,
      });

      if (res.status === 200) {
        this.latencyMs = res.latencyMs;
        this.lastOkAt = Date.now();
        this.status = 'connected';
        this.consecutiveFailures = 0;
        this.lastError = null;
        return res.text ? JSON.parse(res.text) : {};
      }

      if (res.status === 401 || res.status === 403) {
        // Endpoint token may have rotated if LS restarted; re-discover once.
        ep = await this.ensureEndpoint(true);
        const retry = await httpRequest({
          host: ep.host,
          port: ep.port,
          method: 'POST',
          path: SERVICE_PREFIX + method,
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': ep.csrf,
            'Content-Length': Buffer.byteLength(payload),
          },
          body: payload,
          timeoutMs,
        });
        if (retry.status === 200) {
          this.latencyMs = retry.latencyMs;
          this.lastOkAt = Date.now();
          this.status = 'connected';
          this.consecutiveFailures = 0;
          this.lastError = null;
          return retry.text ? JSON.parse(retry.text) : {};
        }
        throw new Error(`RPC ${method} HTTP ${retry.status}`);
      }

      throw new Error(`RPC ${method} HTTP ${res.status}`);
    } catch (err) {
      this.consecutiveFailures++;
      this.status = this.consecutiveFailures >= 3 ? 'disconnected' : 'reconnecting';
      this.lastError = err?.message || String(err);
      if (Date.now() - this.lastDiscoverAt > 3000) {
        this.endpoint = null;
      }
      throw err;
    }
  }

  async getAllTrajectories() {
    const res = await this.call('GetAllCascadeTrajectories', { excludeSubtrajectories: false }, 4000);
    return res?.trajectorySummaries || {};
  }

  async getTrajectorySteps(cascadeId, stepOffset = 0, endIndex = undefined) {
    const body = {
      cascadeId,
      stepOffset,
      trajectoryVerbosity: 3,
    };
    if (Number.isInteger(endIndex) && endIndex > stepOffset) {
      body.endIndex = endIndex;
    }
    const res = await this.call('GetCascadeTrajectorySteps', body, 5000);
    return Array.isArray(res?.steps) ? res.steps : [];
  }

  getConnectionInfo() {
    return {
      status: this.status,
      address: this.endpoint ? `${this.endpoint.host}:${this.endpoint.port}` : (process.env.ANTIGRAVITY_LS_ADDRESS || null),
      pid: this.endpoint?.pid || null,
      source: this.endpoint?.source || null,
      latencyMs: this.latencyMs,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

export function readTranscriptTokenIndex(conversationId) {
  if (!GUID_RE.test(String(conversationId || ''))) return new Map();
  const id = conversationId.toLowerCase();
  const tokensByStep = new Map();
  for (const root of findBrainRoots()) {
    for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const p = join(root, id, '.system_generated', 'logs', file);
      if (!existsSync(p)) continue;
      try {
        const text = readFileSync(p, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            if (Number.isInteger(row?.step_index)) {
              tokensByStep.set(row.step_index, {
                inputTokens: Number(row.input_tokens || 0) || 0,
                cacheReadTokens: Number(row.cache_read_tokens || 0) || 0,
                outputTokens: Number(row.output_tokens || 0) || 0,
                model: row.model || null,
              });
            }
          } catch {}
        }
        return tokensByStep;
      } catch {}
    }
  }
  return tokensByStep;
}

export function readTranscriptFallbackSteps(conversationId) {
  if (!GUID_RE.test(String(conversationId || ''))) return [];
  const id = conversationId.toLowerCase();
  for (const root of findBrainRoots()) {
    for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const p = join(root, id, '.system_generated', 'logs', file);
      if (!existsSync(p)) continue;
      try {
        const text = readFileSync(p, 'utf8');
        const out = [];
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            out.push(row);
          } catch {}
        }
        return out;
      } catch {}
    }
  }
  return [];
}
