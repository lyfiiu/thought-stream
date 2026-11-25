import { basename } from 'node:path';

const MAX_TEXT = 16000;
const MAX_OUTPUT = 12000;

function trunc(str, max = MAX_TEXT) {
  if (typeof str !== 'string') return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n... [truncated ${str.length - max} chars]`;
}

function parseMs(ts) {
  if (!ts || typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function parseDurationStrSec(dur) {
  if (typeof dur !== 'string') return null;
  const m = dur.match(/^([\d.]+)s$/);
  return m ? Number(m[1]) : null;
}

export function normalizeStatus(raw) {
  const s = String(raw || '').replace(/^CORTEX_STEP_STATUS_/, '');
  if (!s) return 'UNKNOWN';
  if (s === 'DONE') return 'DONE';
  if (s === 'RUNNING') return 'RUNNING';
  if (s === 'PENDING') return 'PENDING';
  if (s.includes('WAIT')) return 'WAITING';
  if (/ERROR|INVALID|FAIL|CANCEL|BLOCKED|REJECT/.test(s)) return 'ERROR';
  return s;
}

function safeJsonParse(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function formatToolVerbAndTarget(toolName, step, args) {
  const name = toolName || step.type?.replace(/^CORTEX_STEP_TYPE_/, '').toLowerCase() || 'tool';
  const shortPath = (p) => {
    if (!p || typeof p !== 'string') return '';
    const clean = p.replace(/^file:\/\//, '');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length <= 3) return clean;
    return `…/${parts.slice(-2).join('/')}`;
  };

  if (name === 'read_file' || name === 'view_file') {
    const p = args?.Path || args?.AbsolutePath || step.viewFile?.absolutePathUri || '';
    const sLine = args?.StartLine ?? step.viewFile?.startLine;
    const eLine = args?.EndLine ?? step.viewFile?.endLine;
    const range = sLine ? `:${sLine}${eLine ? `-${eLine}` : ''}` : '';
    return { verb: 'Read', category: 'read', target: `${shortPath(p)}${range}` || '(file)' };
  }

  if (name === 'edit_file' || name === 'replace_file_content' || name === 'multi_replace_file_content') {
    const p = args?.Path || args?.TargetFile || '';
    return { verb: 'Edit', category: 'edit', target: shortPath(p) || '(file)' };
  }

  if (name === 'write_file' || name === 'write_to_file') {
    const p = args?.Path || args?.TargetFile || '';
    return { verb: 'Write', category: 'write', target: shortPath(p) || '(file)' };
  }

  if (name === 'run_command') {
    const cmd = args?.CommandLine || step.runCommand?.commandLine || '';
    const summary = args?.toolSummary || '';
    const oneLine = String(cmd).replace(/\s+/g, ' ').trim();
    const preview = oneLine.length > 90 ? oneLine.slice(0, 87) + '…' : oneLine;
    return {
      verb: 'Bash',
      category: 'bash',
      target: preview || summary || '(command)',
      subtitle: summary && summary !== preview ? summary : '',
    };
  }

  if (name === 'command_status' || name === 'send_command_input' || name === 'manage_task') {
    return {
      verb: name === 'manage_task' ? 'Task' : 'Shell',
      category: 'bash',
      target: args?.Action ? `${args.Action} ${args.TaskId || ''}`.trim() : (args?.CommandId || name),
    };
  }

  if (name === 'search_web' || name === 'read_url_content' || name === 'fetch_page_content') {
    const q = args?.query || args?.Url || step.readUrlContent?.url || '';
    return { verb: 'Web', category: 'web', target: String(q).slice(0, 90) || name };
  }

  if (name === 'find_by_name' || name === 'grep_search' || name === 'list_dir') {
    const q = args?.Query || args?.Pattern || args?.SearchPath || args?.DirectoryPath || '';
    return { verb: 'Search', category: 'search', target: String(q).slice(0, 90) || name };
  }

  if (name === 'invoke_subagent') {
    const role = args?.Role || step.invokeSubagent?.subagents?.[0]?.role || 'Subagent';
    const type = args?.TypeName || step.invokeSubagent?.subagents?.[0]?.typeName || '';
    const model = args?.Model || step.invokeSubagent?.subagents?.[0]?.modelOption || '';
    return {
      verb: 'Agent',
      category: 'agent',
      target: [role, type ? `(${type})` : '', model && model !== 'inherit' ? `[${model}]` : ''].filter(Boolean).join(' '),
    };
  }

  if (name === 'update_focus') {
    return {
      verb: 'Focus',
      category: 'meta',
      target: args?.focus || step.generic?.args?.focus || '',
    };
  }

  if (name === 'update_steps') {
    const steps = args?.steps || step.generic?.args?.steps || [];
    const done = Array.isArray(steps) ? steps.filter((s) => s.status === 'done').length : 0;
    const active = Array.isArray(steps) ? steps.find((s) => s.status === 'in_progress')?.title : '';
    return {
      verb: 'Plan',
      category: 'meta',
      target: active ? `${done}/${steps.length} · ${active}` : `${done}/${steps.length} steps`,
    };
  }

  if (name === 'send_message') {
    return {
      verb: 'Msg',
      category: 'agent',
      target: `→ ${String(args?.Recipient || '').slice(0, 12)}`,
    };
  }

  if (name === 'ask_question') {
    const q = args?.questions?.[0]?.question || '';
    return { verb: 'Ask', category: 'wait', target: String(q).slice(0, 90) || 'Waiting for user answer' };
  }

  // Generic / MCP fallback
  const firstVal = args && typeof args === 'object'
    ? Object.entries(args).find(([, v]) => typeof v === 'string' || typeof v === 'number')
    : null;
  return {
    verb: name,
    category: 'tool',
    target: firstVal ? `${firstVal[0]}=${String(firstVal[1]).slice(0, 70)}` : '',
  };
}

function extractToolOutput(step) {
  if (step.error) {
    return {
      text: typeof step.error === 'string' ? step.error : JSON.stringify(step.error, null, 2),
      isError: true,
    };
  }
  if (step.runCommand) {
    const rc = step.runCommand;
    const out = rc.combinedOutput?.full ?? rc.combinedOutput?.truncated ?? '';
    const exitInfo = rc.exitCode !== undefined && rc.exitCode !== null ? `exit ${rc.exitCode}` : '';
    return {
      text: trunc(out, MAX_OUTPUT),
      meta: exitInfo,
      isError: Number.isInteger(rc.exitCode) && rc.exitCode !== 0,
    };
  }
  if (step.viewFile) {
    const vf = step.viewFile;
    const lines = vf.numLines ? `${vf.numLines} lines` : '';
    const bytes = vf.numBytes ? `${vf.numBytes} B` : '';
    return {
      text: trunc(vf.content || '', MAX_OUTPUT),
      meta: [lines, bytes].filter(Boolean).join(' · '),
      isError: false,
    };
  }
  if (step.codeAction) {
    const ca = step.codeAction;
    const spec = ca.actionSpec || {};
    if (spec.createFile) {
      return {
        text: trunc(spec.createFile.content || '', MAX_OUTPUT),
        meta: basename(spec.createFile.path?.absolutePathUri || ''),
        isError: false,
      };
    }
    return {
      text: trunc(JSON.stringify(ca, null, 2), MAX_OUTPUT),
      meta: '',
      isError: false,
    };
  }
  if (step.readUrlContent) {
    return {
      text: trunc(step.readUrlContent.content || JSON.stringify(step.readUrlContent, null, 2), MAX_OUTPUT),
      meta: '',
      isError: false,
    };
  }
  if (step.invokeSubagent) {
    const sub = step.invokeSubagent;
    const childId = sub.results?.[0]?.conversationId || null;
    return {
      text: trunc(sub.subagents?.[0]?.initialPrompt || '', MAX_OUTPUT),
      meta: childId ? `subagent:${childId.slice(0, 8)}` : '',
      childConversationId: childId,
      isError: false,
    };
  }
  if (step.generic?.result) {
    const res = step.generic.result;
    const txt = typeof res.result === 'string' ? res.result : JSON.stringify(res, null, 2);
    return {
      text: trunc(txt, MAX_OUTPUT),
      meta: '',
      isError: false,
    };
  }
  return { text: '', meta: '', isError: false };
}

export function parseStep(step, index, tokenIndexMap = null, now = Date.now()) {
  const meta = step?.metadata || {};
  const status = normalizeStatus(step?.status);
  const createdAt = parseMs(meta.createdAt);
  const startedAt = parseMs(meta.startedAt);
  const completedAt = parseMs(meta.completedAt);
  const rawType = String(step?.type || '').replace(/^CORTEX_STEP_TYPE_/, '');
  const durationMs = completedAt && startedAt
    ? Math.max(0, completedAt - startedAt)
    : (status === 'RUNNING' || status === 'WAITING') && (startedAt || createdAt)
      ? Math.max(0, now - (startedAt || createdAt))
      : null;

  if (rawType === 'USER_INPUT') {
    const items = step.userInput?.items || [];
    const text = step.userInput?.userResponse
      || items.map((i) => i?.text).filter(Boolean).join('\n')
      || '';
    return {
      index,
      kind: 'user',
      rawType,
      status,
      createdAt,
      startedAt,
      completedAt,
      durationMs,
      text: trunc(text, MAX_TEXT),
    };
  }

  if (rawType === 'PLANNER_RESPONSE') {
    const pr = step.plannerResponse || {};
    const mu = meta.modelUsage || {};
    const fallbackTok = tokenIndexMap?.get(index);
    const inputTokens = Number(mu.inputTokens ?? fallbackTok?.inputTokens ?? 0) || 0;
    const cacheReadTokens = Number(mu.cacheReadTokens ?? mu.cachedTokens ?? fallbackTok?.cacheReadTokens ?? 0) || 0;
    const outputTokens = Number(mu.outputTokens ?? fallbackTok?.outputTokens ?? 0) || 0;
    const thinkingTokens = Number(mu.thinkingOutputTokens ?? 0) || 0;
    const thinkingDurSec = parseDurationStrSec(pr.thinkingDuration)
      ?? (durationMs !== null ? Number((durationMs / 1000).toFixed(2)) : null);

    const toolCalls = Array.isArray(pr.toolCalls)
      ? pr.toolCalls.map((tc) => ({
          id: tc.id || '',
          name: tc.name || '',
        }))
      : [];

    const responseText = pr.modifiedResponse || pr.response || '';
    const thinkingText = pr.thinking || '';

    return {
      index,
      kind: 'planner',
      rawType,
      status,
      createdAt,
      startedAt,
      completedAt,
      durationMs,
      thinking: trunc(thinkingText, MAX_TEXT),
      thinkingLen: thinkingText.length,
      thinkingDurationSec: thinkingDurSec,
      response: trunc(responseText, MAX_TEXT),
      responseLen: responseText.length,
      toolCalls,
      stopReason: pr.stopReason || null,
      model: meta.generatorModel || mu.model || fallbackTok?.model || null,
      usage: {
        inputTokens,
        cacheReadTokens,
        outputTokens,
        thinkingTokens,
      },
    };
  }

  if (rawType === 'SYSTEM_MESSAGE' || rawType === 'CHECKPOINT' || rawType === 'ERROR_MESSAGE') {
    const msg = step.systemMessage?.systemMessage
      || step.errorMessage?.userMessage
      || step.error?.message
      || (typeof step.error === 'string' ? step.error : '')
      || '';
    return {
      index,
      kind: 'system',
      rawType,
      status: rawType === 'ERROR_MESSAGE' ? 'ERROR' : status,
      createdAt,
      startedAt,
      completedAt,
      durationMs,
      text: trunc(msg, MAX_TEXT),
    };
  }

  // Tool / Generic / Command / View / Edit / Subagent step
  const tc = meta.toolCall || {};
  const args = safeJsonParse(tc.argumentsJson) || step.generic?.args || {};
  const toolName = tc.name || rawType.toLowerCase();
  const { verb, category, target, subtitle } = formatToolVerbAndTarget(toolName, step, args);
  const output = extractToolOutput(step);
  const checklist = toolName === 'update_steps' && Array.isArray(args?.steps) ? args.steps : null;

  return {
    index,
    kind: 'tool',
    rawType,
    toolName,
    verb,
    category,
    target,
    subtitle: subtitle || '',
    status: output.isError && status === 'DONE' ? 'ERROR' : status,
    createdAt,
    startedAt,
    completedAt,
    durationMs,
    args,
    output: output.text,
    outputMeta: output.meta || '',
    isError: output.isError || status === 'ERROR',
    childConversationId: output.childConversationId || null,
    checklist,
  };
}

export function groupIntoTurns(parsedSteps, now = Date.now()) {
  const turns = [];
  let current = null;

  const ensureTurn = (seedStep) => {
    if (!current) {
      current = {
        turnIndex: turns.length + 1,
        userText: '(Session start)',
        startedAt: seedStep?.createdAt || now,
        endedAt: null,
        items: [],
        stats: { steps: 0, tools: 0, errors: 0, thinkingSec: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      };
      turns.push(current);
    }
    return current;
  };

  for (const s of parsedSteps) {
    if (s.kind === 'user') {
      current = {
        turnIndex: turns.length + 1,
        userText: s.text || '(Empty prompt)',
        startedAt: s.createdAt || now,
        endedAt: s.completedAt || s.createdAt || null,
        items: [],
        stats: { steps: 1, tools: 0, errors: 0, thinkingSec: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      };
      turns.push(current);
      continue;
    }

    const turn = ensureTurn(s);
    turn.items.push(s);
    turn.stats.steps += 1;
    if (s.completedAt) turn.endedAt = Math.max(turn.endedAt || 0, s.completedAt);
    else if (s.createdAt) turn.endedAt = Math.max(turn.endedAt || 0, s.createdAt);

    if (s.kind === 'tool') {
      turn.stats.tools += 1;
      if (s.isError || s.status === 'ERROR') turn.stats.errors += 1;
    }
    if (s.kind === 'planner') {
      if (Number.isFinite(s.thinkingDurationSec)) {
        turn.stats.thinkingSec += s.thinkingDurationSec;
      }
      turn.stats.inputTokens += s.usage?.inputTokens || 0;
      turn.stats.cacheReadTokens += s.usage?.cacheReadTokens || 0;
      turn.stats.outputTokens += s.usage?.outputTokens || 0;
    }
  }

  for (const t of turns) {
    const hasRunning = t.items.some((i) => i.status === 'RUNNING' || i.status === 'PENDING' || i.status === 'WAITING');
    t.status = t.items.some((i) => i.status === 'WAITING')
      ? 'WAITING'
      : hasRunning
        ? 'RUNNING'
        : t.items.some((i) => i.status === 'ERROR')
          ? 'ERROR'
          : 'DONE';
    const end = hasRunning ? now : (t.endedAt || t.startedAt);
    t.durationMs = t.startedAt ? Math.max(0, end - t.startedAt) : 0;
  }

  return turns;
}

export function buildContentFingerprint(steps) {
  if (!Array.isArray(steps) || !steps.length) return '0';
  const tail = steps.slice(-4).map((s, idx) => {
    const st = s?.status || '';
    const th = s?.plannerResponse?.thinking?.length || 0;
    const rp = (s?.plannerResponse?.response || s?.plannerResponse?.modifiedResponse || '').length;
    const cmd = s?.runCommand?.combinedOutput?.full?.length || 0;
    return `${steps.length - 4 + idx}:${s?.type}:${st}:${th}:${rp}:${cmd}`;
  });
  return `${steps.length}|${tail.join(';')}`;
}

export function computeDiagnostics({
  connection,
  summary,
  parsedSteps,
  subagents,
  lastChangeAt,
  now = Date.now(),
}) {
  const rawRunStatus = String(summary?.status || '').replace(/^CASCADE_RUN_STATUS_/, '') || 'UNKNOWN';
  const waitingStep = parsedSteps.findLast((s) => s.status === 'WAITING');
  const runningSteps = parsedSteps.filter((s) => s.status === 'RUNNING');
  const pendingSteps = parsedSteps.filter((s) => s.status === 'PENDING');
  const lastStep = parsedSteps.at(-1) || null;
  const activeSubagent = subagents.find((sa) => sa.runStatus === 'RUNNING');

  const silenceMs = lastChangeAt ? Math.max(0, now - lastChangeAt) : 0;
  const lastTurnStart = parseMs(summary?.lastUserInputTime)
    || parsedSteps.findLast((s) => s.kind === 'user')?.createdAt
    || null;
  const turnElapsedMs = rawRunStatus === 'RUNNING' && lastTurnStart ? Math.max(0, now - lastTurnStart) : 0;

  let healthState = 'idle'; // 'live' | 'waiting' | 'slow' | 'stalled' | 'disconnected' | 'idle' | 'cancelling'
  let activityEn = 'Idle — ready for next instruction';
  let activityZh = '空闲 — 等待新指令';

  if (connection.status === 'disconnected') {
    healthState = 'disconnected';
    activityEn = `Disconnected from Language Server (${connection.lastError || 'unreachable'})`;
    activityZh = `与 Language Server 断联 (${connection.lastError || '无法连接'})`;
  } else if (connection.status === 'reconnecting') {
    healthState = 'slow';
    activityEn = `Reconnecting to Language Server (attempt #${connection.consecutiveFailures})…`;
    activityZh = `正在重连 Language Server (第 ${connection.consecutiveFailures} 次尝试)…`;
  } else if (waitingStep) {
    healthState = 'waiting';
    activityEn = `Waiting for user approval/input on ${waitingStep.verb}: ${waitingStep.target}`;
    activityZh = `等待你确认/输入: ${waitingStep.verb} ${waitingStep.target}`;
  } else if (rawRunStatus === 'CANCELLING') {
    healthState = 'cancelling';
    activityEn = 'Cancelling active turn…';
    activityZh = '正在取消当前任务…';
  } else if (rawRunStatus === 'RUNNING') {
    if (silenceMs >= 45000) {
      healthState = 'stalled';
    } else if (silenceMs >= 15000) {
      healthState = 'slow';
    } else {
      healthState = 'live';
    }

    if (activeSubagent) {
      activityEn = `Subagent "${activeSubagent.title}" running (${activeSubagent.latestAction || 'working'})`;
      activityZh = `子代理 "${activeSubagent.title}" 执行中 (${activeSubagent.latestAction || '工作中'})`;
    } else if (runningSteps.length > 0) {
      const top = runningSteps[0];
      const sec = top.durationMs ? ` (${(top.durationMs / 1000).toFixed(1)}s)` : '';
      activityEn = `Executing ${top.verb}: ${top.target}${sec}`;
      activityZh = `正在执行 ${top.verb}: ${top.target}${sec}`;
    } else if (pendingSteps.length > 0) {
      const top = pendingSteps[0];
      activityEn = `Queued ${top.verb}: ${top.target}`;
      activityZh = `排队准备执行 ${top.verb}: ${top.target}`;
    } else {
      const sec = silenceMs > 1000 ? ` (${(silenceMs / 1000).toFixed(1)}s)` : '';
      activityEn = `Model is reasoning / streaming next step${sec}…`;
      activityZh = `模型正在深度思考 / 生成下一步${sec}…`;
    }

    if (healthState === 'stalled') {
      activityEn = `Possible stall (${Math.round(silenceMs / 1000)}s no step update) — ${activityEn}`;
      activityZh = `疑似卡住 (已 ${Math.round(silenceMs / 1000)}s 无步骤进展) — ${activityZh}`;
    }
  } else if (lastStep?.status === 'ERROR') {
    healthState = 'idle';
    activityEn = `Stopped on error: ${lastStep.verb || lastStep.rawType}`;
    activityZh = `因错误停止: ${lastStep.verb || lastStep.rawType}`;
  }

  return {
    healthState,
    rawRunStatus,
    activityEn,
    activityZh,
    silenceMs,
    turnElapsedMs,
    runningCount: runningSteps.length,
    pendingCount: pendingSteps.length,
    waitingCount: waitingStep ? 1 : 0,
    lastChangeAt,
    connection,
  };
}
