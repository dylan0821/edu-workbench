import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function resolveDshBin() {
  const localBin = path.join(ROOT, 'node_modules', '.bin', 'dsh');
  if (fs.existsSync(localBin)) return localBin;
  const jsEntry = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(jsEntry)) return jsEntry;
  return null;
}

export async function testDeepseekApiKey(apiKey) {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) throw new TypeError('请输入 DeepSeek API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.deepseek.com/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${cleanKey}` },
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `API 返回状态 ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) msg = parsed.error.message;
      } catch {}
      return { ok: false, status: res.status, error: msg };
    }
    const data = await res.json().catch(() => ({}));
    const models = Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [];
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? '连接 DeepSeek API 超时' : (err.message || '连接失败')
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createDshManager({ dshHomeDir, getApiKey, getMcpEndpoint, store }) {
  const workspaceDir = path.join(dshHomeDir, 'workspace');
  const uploadsDir = path.join(workspaceDir, 'uploads');
  fs.mkdirSync(dshHomeDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  let proc = null;
  let startingPromise = null;
  let initialized = false;
  let activeModel = 'deepseek-flash';
  let activeEffort = 'high';
  let lastError = '';
  let lastOutput = [];
  let nextRpcId = 1;
  const pendingRpc = new Map();
  const activeTurns = new Map(); // conversationId -> { messageId, content, thinking, toolCalls: [], startedAt, outputTokens }
  const subscribers = new Set();

  function pushLog(line) {
    const clean = String(line || '').trim();
    if (!clean) return;
    lastOutput.push(clean);
    if (lastOutput.length > 50) lastOutput.shift();
  }

  function broadcast(event) {
    for (const fn of subscribers) {
      try { fn(event); } catch {}
    }
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  async function syncCredentialsFile(apiKey) {
    const credPath = path.join(dshHomeDir, '.credentials.yaml');
    const cleanKey = String(apiKey || '').trim();
    if (!cleanKey) {
      await fsp.rm(credPath, { force: true }).catch(() => {});
      return;
    }
    const content = `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${JSON.stringify(cleanKey)}\n`;
    await fsp.writeFile(credPath, content, { encoding: 'utf8', mode: 0o600 });
    await fsp.chmod(credPath, 0o600).catch(() => {});
  }

  async function ensureDshHomeConfig() {
    const agentsPath = path.join(dshHomeDir, 'AGENTS.md');
    const agentsDoc = [
      '# 教培工作台智能助手',
      '',
      '你是嵌入在「教培工作台」教务后台中的 DeepSeek Harness 智能助手，服务于机构管理员。',
      '',
      '## 核心能力',
      '1. **教务工作台操作**：你已通过 `workbench` MCP 服务直接连接教培工作台数据库，可执行：',
      '   - `workbench_get_overview`：查询机构、教师、学生、课程、账号与排课全貌',
      '   - `workbench_create_teacher` / `workbench_update_teacher` / `workbench_upsert_teacher_account`：创建与编辑教师档案及登录账号',
      '   - `workbench_create_student` / `workbench_update_student` / `workbench_manage_account`：创建与编辑学生档案、报名课程及账号管理',
      '   - `workbench_create_course` / `workbench_update_course` / `workbench_enroll_students` / `workbench_update_enrollment`：创建与编辑课程、配置多教师与容量、批量报名与状态调整',
      '   - `workbench_create_course_node` / `workbench_create_course_nodes_batch` / `workbench_copy_course_outline`：编排与复制课程大纲树',
      '   - `workbench_list_lessons` / `workbench_schedule_lesson` / `workbench_schedule_lessons_batch` / `workbench_update_lesson_status` / `workbench_delete_lesson`：排课、批量排课与冲突检测',
      '   - `workbench_create_trial_grant` / `workbench_add_student_followup`：试听授权与跟进记录',
      '   - `workbench_delete_entity`：删除教师/学生/课程（高危操作，执行前须向管理员明确确认）',
      '2. **完整 DeepSeek Harness 能力**：保留 dsh 原生的工具、技能与多步推理能力；工作目录已安全隔离在独立沙箱目录中。',
      '',
      '## 操作规范',
      '- 创建或修改教师、学生、课程、排课前，如不确定目标 ID，先调用 `workbench_get_overview` 核对现存数据。',
      '- 批量排课遇到冲突时，可先用 `dryRun: true` 预演并向管理员汇报冲突详情。',
      '- 执行删除（`workbench_delete_entity`）前，务必先向管理员确认目标名称与 ID。',
      '- 所有操作完成后，用清晰简洁的中文总结已创建或修改的内容。'
    ].join('\n');
    await fsp.writeFile(agentsPath, agentsDoc, 'utf8');

    const mcp = getMcpEndpoint();
    const patchPath = path.join(dshHomeDir, 'workbench-patch.yml');
    if (mcp?.url && mcp?.token) {
      const patchYaml = [
        '- insert:',
        '    - id: mcp-workbench',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: workbench',
        '        transport: streamable-http',
        `        url: ${JSON.stringify(mcp.url)}`,
        '        headers:',
        `          Authorization: ${JSON.stringify(`Bearer ${mcp.token}`)}`
      ].join('\n') + '\n';
      await fsp.writeFile(patchPath, patchYaml, 'utf8');
      return patchPath;
    }
    return null;
  }

  function sendRpc(method, params = {}) {
    if (!proc || proc.killed || !proc.stdin.writable) {
      return Promise.reject(new Error('DeepSeek Harness 运行时未启动'));
    }
    const id = nextRpcId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`RPC 请求 ${method} 超时`));
      }, 45000);
      pendingRpc.set(id, {
        resolve: val => { clearTimeout(timer); resolve(val); },
        reject: err => { clearTimeout(timer); reject(err); }
      });
      proc.stdin.write(payload);
    });
  }

  function respondRpc(id, result) {
    if (!proc || proc.killed || !proc.stdin.writable) return;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  async function generateConversationTitle(conversationId, userText, assistantText) {
    const apiKey = String(getApiKey?.() || '').trim();
    if (!apiKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const prompt = [
        '请根据以下对话内容，生成一个简洁的中文对话标题（4～12个字，不加引号、书名号或标点）：',
        `用户：${String(userText || '').slice(0, 300)}`,
        `助手：${String(assistantText || '').slice(0, 300)}`
      ].join('\n');
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 32,
          temperature: 0.3
        }),
        signal: controller.signal
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const rawTitle = String(data?.choices?.[0]?.message?.content || '').trim();
      const cleanTitle = rawTitle.replace(/^["'《「【]+|["'》」】。！？.,!?\s]+$/g, '').slice(0, 20);
      if (!cleanTitle) return;
      const updated = store?.updateAssistantConversation(conversationId, { title: cleanTitle });
      if (updated) {
        broadcast({ type: 'assistant_conversation_updated', conversation: updated });
      }
    } catch {} finally {
      clearTimeout(timer);
    }
  }

  function handleSessionEvent(params) {
    const sessionId = params?.sessionId;
    const event = params?.event;
    if (!sessionId || !event) return;

    const turn = activeTurns.get(sessionId);
    if (!turn) return;

    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content || [];
      let textPart = '';
      let thinkPart = '';
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          textPart += b.text;
        } else if (b.type === 'thinking' && b.thinking) {
          thinkPart += b.thinking;
        } else if (b.type === 'tool-call') {
          const existing = turn.toolCalls.find(t => t.id === b.id);
          if (!existing) {
            turn.toolCalls.push({
              id: b.id,
              name: b.name,
              arguments: b.arguments || {},
              status: 'running',
              result: ''
            });
          }
        }
      }
      if (textPart) {
        turn.content = turn.content ? `${turn.content}\n\n${textPart}` : textPart;
      }
      if (thinkPart) {
        turn.thinking = turn.thinking ? `${turn.thinking}\n${thinkPart}` : thinkPart;
      }
      const usage = event.data?.message?.usage;
      if (usage && typeof usage === 'object') {
        const inTok = Number(usage.inputTokens || 0);
        const outTok = Number(usage.outputTokens || 0);
        const cacheRead = Number(usage.cacheReadTokens || 0);
        const cacheWrite = Number(usage.cacheWriteTokens || 0);
        const totalTok = Number(usage.totalTokens || (inTok + outTok + cacheRead + cacheWrite));
        turn.outputTokens = (turn.outputTokens || 0) + outTok;
        const elapsedSec = Math.max(0.2, (Date.now() - (turn.startedAt || Date.now())) / 1000);
        const denom = inTok + cacheRead + cacheWrite;
        const cacheHitPct = denom > 0 ? Math.round((cacheRead / denom) * 100) : 0;
        const contextTokens = inTok + cacheRead + cacheWrite + outTok;
        const contextPct = Number(Math.min(100, (contextTokens / 1048576) * 100).toFixed(1));
        const metrics = {
          totalTokens: totalTok,
          tokPerSec: Math.round(turn.outputTokens / elapsedSec),
          cacheHitPct,
          contextPct
        };
        store?.updateAssistantConversationMetrics(sessionId, metrics);
        broadcast({ type: 'assistant_metrics', conversationId: sessionId, metrics });
      }
      store?.updateAssistantMessage(turn.messageId, {
        content: turn.content,
        thinking: turn.thinking,
        toolCalls: turn.toolCalls,
        status: 'streaming'
      });
      broadcast({
        type: 'assistant_message_update',
        conversationId: sessionId,
        messageId: turn.messageId,
        content: turn.content,
        thinking: turn.thinking,
        toolCalls: turn.toolCalls,
        status: 'streaming'
      });
      return;
    }

    if (event.type === 'tool/result') {
      const msg = event.data?.message;
      const callId = msg?.toolCallId || msg?.source?.callId;
      const isError = Boolean(msg?.isError);
      const resultText = (msg?.content || [])
        .map(c => (c.type === 'text' ? c.text : JSON.stringify(c)))
        .join('\n');
      const tc = turn.toolCalls.find(t => t.id === callId);
      if (tc) {
        tc.status = isError ? 'error' : 'done';
        tc.result = resultText;
      }
      store?.updateAssistantMessage(turn.messageId, {
        toolCalls: turn.toolCalls,
        status: 'streaming'
      });
      broadcast({
        type: 'assistant_message_update',
        conversationId: sessionId,
        messageId: turn.messageId,
        content: turn.content,
        thinking: turn.thinking,
        toolCalls: turn.toolCalls,
        status: 'streaming'
      });
      return;
    }

    if (event.type === 'turn/end') {
      const reasonKind = event.data?.reason?.kind || 'completed';
      const isErr = reasonKind === 'error';
      if (isErr && !turn.content) {
        turn.content = event.data?.reason?.message || '生成过程中发生错误';
      }
      const finalStatus = isErr ? 'error' : 'done';
      store?.updateAssistantMessage(turn.messageId, {
        content: turn.content,
        thinking: turn.thinking,
        toolCalls: turn.toolCalls,
        status: finalStatus
      });
      activeTurns.delete(sessionId);
      broadcast({
        type: 'assistant_message_done',
        conversationId: sessionId,
        messageId: turn.messageId,
        content: turn.content,
        thinking: turn.thinking,
        toolCalls: turn.toolCalls,
        status: finalStatus
      });
      if (turn.needsTitle && !isErr && (turn.userText || turn.content)) {
        generateConversationTitle(sessionId, turn.userText, turn.content).catch(() => {});
      }
    }
  }

  function handleIncomingLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      pushLog(trimmed);
      return;
    }

    // Response to our RPC request
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const pending = pendingRpc.get(msg.id);
      if (pending) {
        pendingRpc.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }

    // Server -> client request (e.g. approval/request)
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      if (msg.method === 'approval/request') {
        respondRpc(msg.id, { outcome: 'allowed-once' });
      } else {
        respondRpc(msg.id, {});
      }
      return;
    }

    // Notification
    if (msg.method === 'session.event') {
      handleSessionEvent(msg.params);
    } else if (msg.method === 'session.status') {
      broadcast({
        type: 'assistant_session_status',
        conversationId: msg.params?.sessionId,
        status: msg.params?.status
      });
    }
  }

  async function stop() {
    initialized = false;
    for (const [, pending] of pendingRpc.entries()) {
      pending.reject(new Error('DeepSeek Harness 已停止'));
    }
    pendingRpc.clear();
    for (const [convId, turn] of activeTurns.entries()) {
      store?.updateAssistantMessage(turn.messageId, {
        content: turn.content || '助手已停止',
        status: 'error'
      });
      broadcast({
        type: 'assistant_message_done',
        conversationId: convId,
        messageId: turn.messageId,
        content: turn.content || '助手已停止',
        thinking: turn.thinking,
        toolCalls: turn.toolCalls,
        status: 'error'
      });
    }
    activeTurns.clear();

    if (proc && !proc.killed) {
      const target = proc;
      proc = null;
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          try { target.kill('SIGKILL'); } catch {}
          resolve();
        }, 2000);
        target.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          if (target.stdin.writable) {
            target.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'shutdown', params: {} }) + '\n');
          }
          target.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    } else {
      proc = null;
    }
  }

  async function ensureStarted({ model, reasoningEffort } = {}) {
    const requestedModel = String(model || '').trim() || activeModel || 'deepseek-flash';
    const requestedEffort = ['off', 'low', 'high', 'max'].includes(reasoningEffort) ? reasoningEffort : activeEffort;
    if (proc && !proc.killed && initialized && requestedModel === activeModel && requestedEffort === activeEffort) {
      return getStatus();
    }
    if (proc && !proc.killed && initialized && (requestedModel !== activeModel || requestedEffort !== activeEffort)) {
      await stop();
    }
    if (startingPromise) return startingPromise;

    startingPromise = (async () => {
      const bin = resolveDshBin();
      if (!bin) {
        lastError = '未找到 @deepseek-ai/dsh 可执行文件，请先运行 npm install';
        throw new Error(lastError);
      }

      const apiKey = String(getApiKey?.() || '').trim();
      if (!apiKey) {
        lastError = '请先在「系统设置 → 智能助手」中配置 DeepSeek API Key';
        throw new Error(lastError);
      }

      await syncCredentialsFile(apiKey);
      const patchPath = await ensureDshHomeConfig();

      const args = [
        '--profile', 'sdk',
        ...(patchPath ? ['--patch', patchPath] : [])
      ];

      const env = {
        ...process.env,
        DSH_HOME: dshHomeDir,
        DEEPSEEK_API_KEY: apiKey
      };

      lastError = '';
      lastOutput = [];
      activeModel = requestedModel;
      activeEffort = requestedEffort;

      const isJs = bin.endsWith('.js');
      const child = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, {
        cwd: workspaceDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      proc = child;

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', handleIncomingLine);

      child.stderr.on('data', chunk => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          pushLog(line);
        }
      });

      child.once('exit', (code, signal) => {
        if (proc === child) {
          proc = null;
          initialized = false;
          for (const [, p] of pendingRpc.entries()) {
            p.reject(new Error(`DeepSeek Harness 进程已退出 (code=${code}, signal=${signal})`));
          }
          pendingRpc.clear();
        }
      });

      child.once('error', err => {
        if (proc === child) {
          proc = null;
          initialized = false;
          lastError = err.message || String(err);
        }
      });

      await sendRpc('initialize', {
        cwd: workspaceDir,
        provider: 'deepseek-official',
        model: requestedModel,
        reasoningEffort: requestedEffort,
        approvalRequests: true
      });
      initialized = true;
      return getStatus();
    })();

    try {
      return await startingPromise;
    } catch (err) {
      lastError = err.message || String(err);
      await stop();
      throw err;
    } finally {
      startingPromise = null;
    }
  }

  async function sendPrompt({ conversationId, text, model, reasoningEffort, attachments = [] }) {
    const conv = store.getAssistantConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    const cleanText = String(text || '').trim();
    const attList = Array.isArray(attachments) ? attachments : [];
    if (!cleanText && !attList.length) throw new TypeError('请输入指令或上传附件');

    const targetModel = String(model || conv.model || 'deepseek-flash').trim();
    const targetEffort = ['off', 'low', 'high', 'max'].includes(reasoningEffort)
      ? reasoningEffort
      : (conv.reasoning_effort || 'high');
    await ensureStarted({ model: targetModel, reasoningEffort: targetEffort });

    const displayParts = [];
    if (attList.length) {
      displayParts.push(attList.map(a => `[附件: ${a.name}]`).join(' '));
    }
    if (cleanText) displayParts.push(cleanText);
    const displayContent = displayParts.join('\n');

    // 首轮对话先用简短占位标题，生成回复后由模型自动总结生成正式标题
    const existingMsgs = store.listAssistantMessages(conversationId);
    const needsTitle = conv.title === '新对话' && existingMsgs.length === 0;
    const titleSeed = cleanText || attList[0]?.name || '新对话';
    if (needsTitle) {
      const tempTitle = titleSeed.replace(/\s+/g, ' ').slice(0, 14) + (titleSeed.length > 14 ? '…' : '');
      store.updateAssistantConversation(conversationId, { title: tempTitle, model: targetModel, reasoningEffort: targetEffort });
    } else if (conv.model !== targetModel || conv.reasoning_effort !== targetEffort) {
      store.updateAssistantConversation(conversationId, { model: targetModel, reasoningEffort: targetEffort });
    }

    const userMsgId = store.appendAssistantMessage({
      conversationId,
      role: 'user',
      content: displayContent,
      status: 'done'
    });
    const assistantMsgId = store.appendAssistantMessage({
      conversationId,
      role: 'assistant',
      content: '',
      thinking: '',
      toolCalls: [],
      status: 'streaming'
    });

    activeTurns.set(conversationId, {
      messageId: assistantMsgId,
      content: '',
      thinking: '',
      toolCalls: [],
      startedAt: Date.now(),
      outputTokens: 0,
      needsTitle,
      userText: displayContent
    });

    broadcast({
      type: 'assistant_turn_started',
      conversationId,
      userMessageId: userMsgId,
      assistantMessageId: assistantMsgId
    });

    // 构造 contentBlocks（支持图片直传 + 工作区文件路径提示）
    const contentBlocks = [];
    const fileNotes = [];
    for (const att of attList) {
      const safeRel = String(att.relativePath || '').replace(/^\/+/, '');
      const fullPath = path.resolve(workspaceDir, safeRel);
      if (!fullPath.startsWith(uploadsDir + path.sep)) continue;
      if (att.isImage && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(att.mimeType)) {
        try {
          const buf = await fsp.readFile(fullPath);
          contentBlocks.push({
            type: 'image',
            data: buf.toString('base64'),
            mimeType: att.mimeType,
            name: String(att.name || 'image')
          });
        } catch {}
      } else {
        fileNotes.push(`[已上传文件: ${safeRel} (原始文件名: ${att.name})]`);
      }
    }
    const promptText = [cleanText, ...fileNotes].filter(Boolean).join('\n\n') || '请查看我上传的附件。';
    contentBlocks.unshift({ type: 'text', text: promptText });

    try {
      // 尝试恢复已有 dsh 会话（若为首次则直接 query）
      if (existingMsgs.length > 0) {
        try { await sendRpc('session/resume', { sessionId: conversationId }); } catch {}
      }
      await sendRpc('session/query', {
        sessionId: conversationId,
        contentBlocks
      });
    } catch (err) {
      const turn = activeTurns.get(conversationId);
      if (turn) {
        const errMsg = err.message || '发送失败';
        store.updateAssistantMessage(turn.messageId, { content: errMsg, status: 'error' });
        activeTurns.delete(conversationId);
        broadcast({
          type: 'assistant_message_done',
          conversationId,
          messageId: turn.messageId,
          content: errMsg,
          thinking: turn.thinking,
          toolCalls: turn.toolCalls,
          status: 'error'
        });
      }
      throw err;
    }

    return { userMessageId: userMsgId, assistantMessageId: assistantMsgId };
  }

  function getStatus() {
    const apiKey = String(getApiKey?.() || '').trim();
    const running = Boolean(proc && !proc.killed && initialized);
    return {
      running,
      starting: Boolean(startingPromise),
      hasApiKey: Boolean(apiKey),
      model: activeModel,
      reasoningEffort: activeEffort,
      workspaceDir,
      uploadsDir,
      lastError,
      logs: lastOutput.slice(-15)
    };
  }

  return {
    ensureStarted,
    stop,
    sendPrompt,
    syncCredentialsFile,
    subscribe,
    broadcast,
    getStatus
  };
}
