/* ═══════════════════════════════════════════════════════════
   PromptBench · 提示词调试台
   纯前端：文件解析（图片/PDF/docx/xlsx/文本）→ 多模态请求 → SSE 流式
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* ---------- 基础工具 ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB'
  : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';
const now = () => new Date().toTimeString().slice(0, 8);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2600);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* ---------- 配置 ---------- */
const DEFAULTS = {
  provider: 'anthropic',
  anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-opus-5' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o' },
  maxTokens: 4096,
  samplingOn: false,
  temperature: 1.0,
  thinkingOn: false,
  systemPrompt: '',
};
const MODELS = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'deepseek-chat', 'deepseek-reasoner', 'qwen-max', 'qwen-plus', 'glm-4.5', 'moonshot-v1-128k'],
};
const URL_HINTS = {
  anthropic: '默认 api.anthropic.com；兼容代理 / 中转地址直接填 origin 即可',
  openai: '默认 api.openai.com/v1；DeepSeek、通义、Moonshot 等兼容接口填其 base URL',
};

function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (!v || typeof v !== 'object') return fallback;
    return { ...fallback, ...v,
      anthropic: { ...fallback.anthropic, ...(v.anthropic || {}) },
      openai: { ...fallback.openai, ...(v.openai || {}) } };
  } catch { return fallback; }
}

let config = loadJSON('pb.config', DEFAULTS);
let conversation = [];   // {role, text, thinking?, files?, error?, aborted?, model?, stopReason?}
let pending = [];        // 待发送附件
let streaming = false;
let abortCtl = null;
let lastMeta = null;     // 最近一次运行的元数据（响应面板）

/* ---------- 持久化 ---------- */
function persistConfig() {
  localStorage.setItem('pb.config', JSON.stringify(config));
  const foot = document.querySelector('.cfg-foot');
  foot.classList.add('saved');
  $('savedText').textContent = '已保存 ' + now();
  clearTimeout(foot._t);
  foot._t = setTimeout(() => foot.classList.remove('saved'), 1600);
}
const persistConfigSoon = debounce(persistConfig, 500);

function persistConversation() {
  const strip = (list) => list.map((m) => ({
    ...m,
    files: (m.files || []).map((f) => ({
      ...f,
      base64: undefined, dataUrl: undefined,
      text: f.text ? f.text.slice(0, 4000) : undefined,
    })),
  }));
  try { localStorage.setItem('pb.conv', JSON.stringify(conversation)); }
  catch {
    try { localStorage.setItem('pb.conv', JSON.stringify(strip(conversation))); }
    catch { localStorage.removeItem('pb.conv'); }
  }
}
function restoreConversation() {
  try { conversation = JSON.parse(localStorage.getItem('pb.conv')) || []; }
  catch { conversation = []; }
}

/* ---------- 文件解析 ---------- */
const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'xml',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'rb', 'php', 'sh',
  'yml', 'yaml', 'toml', 'ini', 'log', 'sql', 'css'];
const IMAGE_MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_TEXT_CHARS = 60000;

const cap = (s) => s.length > MAX_TEXT_CHARS
  ? s.slice(0, MAX_TEXT_CHARS) + `\n\n…（已截断，原文 ${s.length.toLocaleString()} 字符）`
  : s;

async function ingestFile(file) {
  const f = { id: uid(), name: file.name || '未命名', size: file.size, kind: 'error', mime: file.type || '' };
  const ext = (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
  try {
    if (file.type.startsWith('image/') || IMAGE_MIMES[ext]) {
      f.kind = 'image';
      f.mime = IMAGE_MIMES[ext] || (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) ? file.type : 'image/png');
      f.base64 = bufToB64(await file.arrayBuffer());
      f.dataUrl = `data:${f.mime};base64,${f.base64}`;
    } else if (ext === 'pdf' || file.type === 'application/pdf') {
      f.kind = 'pdf'; f.mime = 'application/pdf';
      f.base64 = bufToB64(await file.arrayBuffer());
    } else if (ext === 'docx' || ext === 'doc') {
      try {
        const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        f.kind = 'text'; f.text = cap(r.value);
      } catch {
        f.error = '旧版 .doc 无法解析，请在 Word 中「另存为 .docx」后重试';
      }
    } else if (['xlsx', 'xls', 'xlsm', 'csv', 'tsv'].includes(ext)) {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      f.kind = 'text';
      f.text = cap(wb.SheetNames.map((name) =>
        `# 工作表: ${name}\n${XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim()}`).join('\n\n'));
    } else if (file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXTS.includes(ext)) {
      f.kind = 'text'; f.text = cap(await file.text());
    } else {
      f.error = `暂不支持 .${ext || '?'} 文件 — 支持：图片 / PDF / docx / xlsx / csv / 纯文本`;
    }
  } catch (err) {
    f.error = '解析失败：' + (err && err.message ? err.message : err);
  }
  return f;
}

/* PDF → 文本（OpenAI 兼容模式使用；结果缓存在文件对象上） */
async function pdfText(f) {
  if (f._pdfText !== undefined) return f._pdfText;
  try {
    if (!window.pdfjsLib) throw new Error('pdf.js 未加载');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      pages.push(`— 第 ${i} 页 —\n` + tc.items.map((it) => it.str).join(' '));
    }
    f._pdfText = cap(pages.join('\n\n'));
  } catch (err) {
    f._pdfText = `<PDF 文本提取失败: ${err.message || err}>`;
  }
  return f._pdfText;
}

/* ---------- 请求构建 ---------- */
function endpointUrl() {
  const c = config[config.provider];
  let u = (c.baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) u = DEFAULTS[config.provider].baseUrl;
  if (config.provider === 'anthropic') {
    if (u.endsWith('/v1/messages')) return u;
    if (u.endsWith('/v1')) return u + '/messages';
    return u + '/v1/messages';
  }
  if (u.endsWith('/chat/completions')) return u;
  if (u.endsWith('/v1')) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

function anthropicUserBlocks(msg) {
  const blocks = [];
  for (const f of msg.files || []) {
    if (f.kind === 'image' && f.base64) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.base64 } });
    } else if (f.kind === 'pdf' && f.base64) {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.base64 } });
    } else if (f.kind === 'text' && f.text) {
      blocks.push({ type: 'text', text: `<file name="${f.name}">\n${f.text}\n</file>` });
    }
  }
  const t = (msg.text || '').trim();
  if (t || blocks.length === 0) blocks.push({ type: 'text', text: t });
  return blocks;
}

/* 空的 assistant 占位（出错/未开始输出）不进入请求历史 */
const sendable = (conv) => conv.filter((m) => m.role === 'user' || (m.text || '').trim());

function buildAnthropicBody(conv = conversation) {
  const body = {
    model: config.anthropic.model.trim() || 'claude-opus-5',
    max_tokens: clampInt(config.maxTokens, 1, 128000, 4096),
    stream: true,
    messages: sendable(conv).map((m) => m.role === 'assistant'
      ? { role: 'assistant', content: [{ type: 'text', text: m.text || '' }] }
      : { role: 'user', content: anthropicUserBlocks(m) }),
  };
  const sys = config.systemPrompt.trim();
  if (sys) body.system = sys;
  if (config.samplingOn) body.temperature = config.temperature;
  if (config.thinkingOn) body.thinking = { type: 'adaptive', display: 'summarized' };
  return body;
}

async function buildOpenAIBody(conv = conversation) {
  const msgs = [];
  const sys = config.systemPrompt.trim();
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of sendable(conv)) {
    if (m.role === 'assistant') { msgs.push({ role: 'assistant', content: m.text || '' }); continue; }
    const files = m.files || [];
    const hasImg = files.some((f) => f.kind === 'image' && f.dataUrl);
    const textParts = [];
    for (const f of files) {
      if (f.kind === 'pdf' && f.base64) textParts.push(`<file name="${f.name}">\n${await pdfText(f)}\n</file>`);
      else if (f.kind === 'text' && f.text) textParts.push(`<file name="${f.name}">\n${f.text}\n</file>`);
    }
    const t = (m.text || '').trim();
    const combined = [...textParts, ...(t ? [t] : [])].join('\n\n');
    if (hasImg) {
      const content = [];
      if (combined) content.push({ type: 'text', text: combined });
      for (const f of files) if (f.kind === 'image' && f.dataUrl) {
        content.push({ type: 'image_url', image_url: { url: f.dataUrl } });
      }
      msgs.push({ role: 'user', content });
    } else {
      msgs.push({ role: 'user', content: combined });
    }
  }
  const body = {
    model: config.openai.model.trim() || 'gpt-4o',
    max_tokens: clampInt(config.maxTokens, 1, 128000, 4096),
    stream: true,
    stream_options: { include_usage: true },
    messages: msgs,
  };
  if (config.samplingOn) body.temperature = config.temperature;
  if (config.thinkingOn) body.enable_thinking = true;
  return body;
}

function clampInt(v, lo, hi, dft) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dft;
  return Math.min(hi, Math.max(lo, n));
}

/* 生成请求体（发送与透视共用）；conv 可传入含输入框草稿的预览数组 */
async function buildBody(conv = conversation) {
  return config.provider === 'anthropic' ? buildAnthropicBody(conv) : await buildOpenAIBody(conv);
}

/* ---------- 透视面板 ---------- */
function summarizeBody(body) {
  const walk = (v) => {
    if (typeof v === 'string' && v.length > 120) {
      const approx = Math.round(v.length * 3 / 4);
      return `<${fmtSize(approx)} 省略>`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  return walk(body);
}

function hlJson(str) {
  return str
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)/g, '<span class="j-key">$1</span>$2')
    .replace(/(:\s*)(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, '$1<span class="j-str">$2</span>')
    .replace(/\b(true|false|null)\b/g, '<span class="j-bool">$1</span>')
    .replace(/(:\s*)(-?\d+(?:\.\d+)?)(?=[,\n}]|$)/g, '$1<span class="j-num">$2</span>');
}

function requestPreviewJson(body) {
  return hlJson(esc(JSON.stringify(summarizeBody(body), null, 2)));
}

function buildCurl(body) {
  const url = endpointUrl();
  const isA = config.provider === 'anthropic';
  const keyVar = isA ? '$ANTHROPIC_API_KEY' : '$OPENAI_API_KEY';
  const headers = isA
    ? ['-H "content-type: application/json"',
       `-H "x-api-key: ${keyVar}"`,
       '-H "anthropic-version: 2023-06-01"']
    : ['-H "content-type: application/json"',
       `-H "authorization: Bearer ${keyVar}"`];
  const json = JSON.stringify(summarizeBody(body));
  return `# 附件 base64 已省略；完整密钥请用环境变量\n\ncurl ${url} \\\n  ${headers.join(' \\\n  ')} \\\n  -d '${json}'`;
}

let lastBuiltBody = null;
const updateXray = debounce(async () => {
  /* 把输入框草稿（文本 + 待发附件）也纳入预览，所见即所发 */
  const draftText = $('input').value;
  const conv = (draftText.trim() || pending.length)
    ? [...conversation, { role: 'user', text: draftText, files: pending }]
    : conversation;
  const body = await buildBody(conv);
  lastBuiltBody = body;
  const payload = JSON.stringify(body);
  const size = fmtSize(new Blob([payload]).size);
  $('xrayRequest').innerHTML =
    `<span class="j-bool">POST</span> ${esc(endpointUrl())}  <span class="j-key">≈ ${size}</span>\n\n` +
    requestPreviewJson(body);
  $('xCurl').textContent = buildCurl(body);
  updateScope();
}, 120);

function updateScope(state) {
  const c = config[config.provider];
  $('scopeModel').textContent = c.model || '—';
  let host = '—';
  try { host = new URL(endpointUrl()).host; } catch { /* 保持 — */ }
  $('scopeEndpoint').textContent = host;
  const dot = $('scopeDot');
  dot.className = 'scope-dot' + (state === 'live' ? ' live' : state === 'err' ? ' err'
    : lastMeta && lastMeta.error ? ' err' : streaming ? ' live' : c.apiKey ? ' ok' : '');
}

function setMeter(meta) {
  const set = (id, v, quiet) => {
    $(id).textContent = v;
    $(id).classList.toggle('quiet', !!quiet);
  };
  set('mIn', meta.usage?.in != null ? meta.usage.in.toLocaleString() + ' tok' : '—', !meta.usage?.in);
  set('mOut', meta.usage?.out != null ? meta.usage.out.toLocaleString() + ' tok' : '—', !meta.usage?.out);
  set('mTtft', meta.ttft != null ? Math.round(meta.ttft) + ' ms' : '—', !meta.ttft);
  set('mTime', meta.time != null ? (meta.time / 1000).toFixed(1) + ' s' : '—', !meta.time);
  const sr = meta.stopReason;
  set('mStop', sr || (meta.error ? 'ERROR' : '—'), !sr);
}

function setResponsePane(meta) {
  const el = $('xrayResponse');
  el.classList.remove('code-dim');
  const view = summarizeBody({
    model: meta.model ?? null,
    stop_reason: meta.stopReason ?? null,
    input_tokens: meta.usage?.in ?? null,
    output_tokens: meta.usage?.out ?? null,
    thinking_chars: meta.thinkingChars ?? null,
    first_token_ms: meta.ttft != null ? Math.round(meta.ttft) : null,
    total_ms: meta.time != null ? Math.round(meta.time) : null,
  });
  if (meta.error) view.error = (meta.error.split('\n').find((l) => l.trim()) || meta.error).slice(0, 160);
  el.innerHTML = requestPreviewJson(view);
}

/* ---------- 渲染 ---------- */
const fileIco = (f) => {
  if (f.kind === 'image') return ['IMG', 't-image'];
  if (f.kind === 'pdf') return ['PDF', 't-pdf'];
  const ext = (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
  if (['docx', 'doc', 'rtf', 'odt'].includes(ext)) return ['DOC', 't-doc'];
  if (['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) return ['XLS', 't-sheet'];
  return ['TXT', 't-text'];
};

function fchipHtml(f, removable, msgFile) {
  const [label, cls] = fileIco(f);
  const expired = msgFile && (f.kind === 'image' || f.kind === 'pdf') && !f.base64;
  if (f.kind === 'error' || f.error) {
    return `<span class="fchip err" title="${esc(f.error)}">
      <span class="fchip-ico t-pdf">!</span>
      <span class="fchip-name">${esc(f.name)}</span>
      <span class="fchip-meta">${esc(f.error || '解析失败')}</span>
      ${removable ? `<button class="fchip-x" data-rm="${f.id}" title="移除">✕</button>` : ''}
    </span>`;
  }
  const meta = f.kind === 'text'
    ? `${(f.text || '').length.toLocaleString()} 字符`
    : fmtSize(f.size);
  return `<span class="fchip">
    ${f.kind === 'image' && f.dataUrl ? `<img class="fchip-thumb" src="${f.dataUrl}" data-zoom="${f.id}" alt="${esc(f.name)}">` : `<span class="fchip-ico ${cls}">${label}</span>`}
    <span class="fchip-name" title="${esc(f.name)}">${esc(f.name)}</span>
    <span class="fchip-meta">${meta}${expired ? ' <span class="expire">· 已过期</span>' : ''}</span>
    ${removable ? `<button class="fchip-x" data-rm="${f.id}" title="移除">✕</button>` : ''}
  </span>`;
}

function safeMarkdown(md) {
  const html = marked.parse(md || '', { breaks: true, gfm: true });
  return html
    .replace(/<(script|iframe|object|embed|style|link|meta)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|style|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

/* 思考过程卡片（showThinking 是运行时开关快照，保证历史消息显示稳定） */
function thinkHtml(m, i) {
  if (!m.thinking || m.showThinking === false) return '';
  return `<details class="think"${m._thinkOpen === false ? '' : ' open'} data-mi="${i}">
      <summary>思考过程</summary><pre>${esc(m.thinking)}</pre></details>`;
}

const SAMPLES = [
  '总结附件中的关键信息，用表格输出',
  '把附件内容提取为严格的 JSON',
  '帮我检查下面这段提示词的问题并优化它',
];

const MACARONS = `<svg width="104" height="42" viewBox="0 0 104 42" fill="none" aria-hidden="true">
  <g><rect x="2" y="7" width="28" height="13" rx="6.5" fill="#F49FB6"/><rect x="4" y="18" width="24" height="4.2" rx="2.1" fill="#F0D5B8"/><rect x="2" y="21" width="28" height="13" rx="6.5" fill="#E886A3"/></g>
  <g><rect x="38" y="7" width="28" height="13" rx="6.5" fill="#A9D8B9"/><rect x="40" y="18" width="24" height="4.2" rx="2.1" fill="#F0D5B8"/><rect x="38" y="21" width="28" height="13" rx="6.5" fill="#8CC3A2"/></g>
  <g><rect x="74" y="7" width="28" height="13" rx="6.5" fill="#C3B1E1"/><rect x="76" y="18" width="24" height="4.2" rx="2.1" fill="#F0D5B8"/><rect x="74" y="21" width="28" height="13" rx="6.5" fill="#AE9BD6"/></g>
</svg>`;

let renderQueued = false;
function renderMessages() {
  const box = $('messages');
  if (!conversation.length) {
    box.innerHTML = `<div class="empty">
      <div class="empty-mark">${MACARONS}</div>
      <h1>PROMPT<em>BENCH</em></h1>
      <p>输入提示词，可附加图片、PDF、Word、Excel 文件，点击「运行」。<br>
      右侧透视面板实时显示请求 JSON、输入输出 token 与思考过程。</p>
      <div class="empty-samples">${SAMPLES.map((s, i) =>
        `<button class="sample-chip" data-sample="${i}">${esc(s)}</button>`).join('')}</div>
    </div>`;
    return;
  }
  box.innerHTML = conversation.map((m, i) => {    if (m.role === 'user') {
      const files = m.files || [];
      return `<div class="msg msg-user">
        <div class="msg-head">USER <time>${esc(m.time || '')}</time></div>
        <div class="msg-body">
          ${files.length ? `<div class="file-chips">${files.map((f) => fchipHtml(f, false, true)).join('')}</div>` : ''}
          ${m.text ? `<div class="msg-text">${esc(m.text)}</div>` : ''}
        </div>
      </div>`;
    }
    const think = thinkHtml(m, i);
    const body = m.error
      ? `<div class="msg-error">${esc(m.error)}</div>`
      : `<div class="md">${safeMarkdown(m.text)}</div>`;
    const badges = [];
    if (m.model) badges.push(`<span class="badge">${esc(m.model)}</span>`);
    if (m.usage && (m.usage.in != null || m.usage.out != null)) {
      badges.push(`<span class="badge badge-tok">↑ ${m.usage.in ?? '—'} · ↓ ${m.usage.out ?? '—'} tok</span>`);
    }
    if (m.stopReason) {
      const cls = m.stopReason === 'refusal' ? ' stop-refusal'
        : (m.stopReason === 'max_tokens' || m.stopReason === 'length') ? ' stop-max' : '';
      badges.push(`<span class="badge${cls}">${esc(m.stopReason)}</span>`);
    }
    if (m.aborted) badges.push('<span class="badge aborted">已中断</span>');
    if (m.stopReason === 'refusal') badges.push('<span class="badge stop-refusal">模型拒绝了该请求（refusal）</span>');
    return `<div class="msg msg-assistant${streaming && i === conversation.length - 1 ? ' streaming' : ''}">
      <div class="msg-head">ASSISTANT ${badges.join(' ')}</div>
      <div class="msg-body">${think}${body}</div>
    </div>`;
  }).join('');
  if (followBottom) box.scrollTop = box.scrollHeight;
  updateJumpBtn();
}

function renderComposer() {
  $('attachments').innerHTML = pending.map((f) => fchipHtml(f, true, false)).join('');
  const n = $('input').value.length;
  const size = pending.reduce((a, f) => a + f.size, 0);
  $('charCount').textContent = `${n.toLocaleString()} 字符${size ? ' · 附件 ' + fmtSize(size) : ''}`;
}

function autoGrow() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(200, t.scrollHeight) + 'px';
}

/* 滚动跟随：用户上翻查看历史时停止自动贴底，滚回底部附近自动恢复 */
let followBottom = true;
function updateJumpBtn() {
  $('btnJump').hidden = followBottom || !conversation.length;
}

/* 流式期间只更新最后一条消息的内容——保留滚动位置、折叠状态、内部滚动条 */
function streamPatch() {
  const m = conversation[conversation.length - 1];
  const nodes = document.querySelectorAll('#messages .msg');
  const node = nodes[nodes.length - 1];
  if (!m || !node || !node.classList.contains('msg-assistant')) { renderMessages(); return; }

  let think = node.querySelector('.think');
  if (m.thinking && m.showThinking !== false && !think) {
    node.querySelector('.msg-body')?.insertAdjacentHTML('afterbegin', thinkHtml(m, conversation.length - 1));
    think = node.querySelector('.think');
  }
  if (think) {
    const pre = think.querySelector('pre');
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
    pre.textContent = m.thinking;
    if (stick) pre.scrollTop = pre.scrollHeight;
  }
  const md = node.querySelector('.md');
  if (md) md.innerHTML = safeMarkdown(m.text || '');
  if (followBottom) $('messages').scrollTop = $('messages').scrollHeight;
  updateJumpBtn();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (streaming) streamPatch(); else renderMessages();
  });
}

/* ---------- 发送与流式 ---------- */
async function run() {
  if (streaming) return;
  const cfg = config[config.provider];
  const text = $('input').value.trim();
  if (!text && !pending.length) { toast('请输入提示词或附加文件'); return; }
  if (!cfg.apiKey.trim()) {
    toast('请先在左侧「接口」中填写 API 密钥', true);
    $('panelConfig').classList.add('open');
    $('apiKey').focus();
    return;
  }
  if (pending.some((f) => f.error)) {
    toast('存在解析失败的附件，请先移除（红色标记）', true);
    return;
  }

  conversation.push({ role: 'user', text, files: pending, time: now() });
  pending = [];
  $('input').value = '';
  autoGrow();
  renderComposer();
  renderMessages();
  persistConversation();
  updateXray();

  /* 先构建请求体（此时会话以新 user 消息结尾），再放入流式占位 */
  const assistant = { role: 'assistant', text: '', thinking: '', files: [], showThinking: config.thinkingOn };
  let body;
  try {
    body = await buildBody();
  } catch (err) {
    conversation.push(assistant);
    assistant.error = '构建请求失败：' + (err.message || err);
    finishRun(assistant, { usage: {}, stopReason: null, ttft: null, time: 0, error: assistant.error });
    return;
  }
  conversation.push(assistant);

  streaming = true;
  setStreamingUI(true);
  updateScope('live');

  const t0 = performance.now();
  let ttft = null;
  const meta = { usage: {}, stopReason: null, model: null, ttft: null, time: null };
  lastMeta = meta;
  abortCtl = new AbortController();

  try {
    const url = endpointUrl();
    const isA = config.provider === 'anthropic';
    const headers = isA
      ? { 'content-type': 'application/json', 'x-api-key': cfg.apiKey.trim(),
          'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'content-type': 'application/json', 'authorization': 'Bearer ' + cfg.apiKey.trim() };

    let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abortCtl.signal });

    /* 个别兼容端点不认识 stream_options / enable_thinking，自动去掉重试一次 */
    if (!res.ok && !isA && res.status === 400) {
      const errText = await res.text();
      let retried = false;
      if (/stream_options/i.test(errText)) { delete body.stream_options; retried = true; }
      if (/enable_thinking/i.test(errText)) { delete body.enable_thinking; retried = true; }
      if (retried) {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abortCtl.signal });
      } else {
        throw httpError(res.status, errText);
      }
    }
    if (!res.ok) throw httpError(res.status, await res.text());
    if (!res.body) throw new Error('响应不含数据流');

    await readSSE(res, isA, assistant, meta, () => { if (ttft == null) { ttft = performance.now() - t0; meta.ttft = ttft; } });

    assistant.model = meta.model;
    assistant.stopReason = meta.stopReason;
    assistant.usage = { ...meta.usage };
    meta.time = performance.now() - t0;
  } catch (err) {
    if (err.name === 'AbortError') {
      assistant.aborted = true;
      meta.stopReason = 'aborted';
    } else {
      assistant.error = err.message || String(err);
      meta.error = err.message || String(err);
      meta.time = performance.now() - t0;
      updateScope('err');
    }
  }
  finishRun(assistant, meta);
}

function finishRun(assistant, meta) {
  streaming = false;
  abortCtl = null;
  setStreamingUI(false);
  if (assistant) {
    assistant.model = assistant.model || meta.model;
    assistant.stopReason = assistant.stopReason || meta.stopReason;
  }
  setMeter(meta);
  setResponsePane(meta);
  renderMessages();
  persistConversation();
  updateXray();
  if (!meta.error) updateScope();
}

function httpError(status, text) {
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.error?.message || j.message || JSON.stringify(j, null, 2);
  } catch { /* 保持原始文本 */ }
  const err = new Error(`HTTP ${status}\n\n${detail.slice(0, 2000)}`);
  err.name = 'HttpError';
  return err;
}

async function readSSE(res, isAnthropic, assistant, meta, onFirstToken) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let sawText = false;
  const markFirst = () => { if (!sawText) { sawText = true; onFirstToken(); } };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }

      if (isAnthropic) {
        if (ev.type === 'message_start') {
          meta.model = ev.message?.model;
          const u = ev.message?.usage || {};
          meta.usage.in = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta || {};
          if (d.type === 'text_delta' && d.text) { assistant.text += d.text; markFirst(); }
          else if (d.type === 'thinking_delta' && d.thinking) {
            assistant.thinking += d.thinking;
            meta.thinkingChars = (meta.thinkingChars || 0) + d.thinking.length;
          }
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason) meta.stopReason = ev.delta.stop_reason;
          if (ev.usage?.output_tokens) meta.usage.out = ev.usage.output_tokens;
        } else if (ev.type === 'error') {
          throw new Error(`API 流错误: ${ev.error?.message || JSON.stringify(ev.error)}`);
        }
      } else {
        const ch = ev.choices?.[0];
        const d = ch?.delta || {};
        if (typeof d.content === 'string' && d.content) { assistant.text += d.content; markFirst(); }
        /* DeepSeek-R1 等推理模型：reasoning_content / reasoning 增量 */
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
          assistant.thinking += d.reasoning_content;
          meta.thinkingChars = (meta.thinkingChars || 0) + d.reasoning_content.length;
        }
        else if (typeof d.reasoning === 'string' && d.reasoning) {
          assistant.thinking += d.reasoning;
          meta.thinkingChars = (meta.thinkingChars || 0) + d.reasoning.length;
        }
        if (ch?.finish_reason) meta.stopReason = ch.finish_reason;
        if (ev.usage) {
          meta.usage.in = ev.usage.prompt_tokens ?? meta.usage.in;
          meta.usage.out = ev.usage.completion_tokens ?? meta.usage.out;
        }
        if (ev.model) meta.model = ev.model;
      }
      setMeter(meta);
      setResponsePane(meta);
      scheduleRender();
    }
  }
}

function setStreamingUI(on) {
  $('btnSend').hidden = on;
  $('btnStop').hidden = !on;
  $('btnSend').disabled = on;
}

/* ---------- 事件绑定 ---------- */
function bindConfig() {
  const c = () => config[config.provider];

  $('segProvider').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    config.provider = btn.dataset.v;
    [...$('segProvider').children].forEach((b) => b.classList.toggle('active', b === btn));
    syncConfigUI();
    persistConfigSoon();
    updateXray();
  });

  $('apiKey').addEventListener('input', (e) => { c().apiKey = e.target.value; persistConfigSoon(); updateScope(); });
  $('btnEye').addEventListener('click', () => {
    const el = $('apiKey');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $('btnEye').textContent = show ? '隐藏' : '显示';
  });
  $('baseUrl').addEventListener('input', (e) => { c().baseUrl = e.target.value; persistConfigSoon(); updateXray(); });
  $('btnUrlReset').addEventListener('click', () => {
    c().baseUrl = DEFAULTS[config.provider].baseUrl;
    $('baseUrl').value = c().baseUrl;
    persistConfigSoon();
    updateXray();
  });
  $('model').addEventListener('input', (e) => { c().model = e.target.value; persistConfigSoon(); updateScope(); updateXray(); });
  $('maxTokens').addEventListener('input', (e) => { config.maxTokens = e.target.value; persistConfigSoon(); updateXray(); });

  $('samplingOn').addEventListener('change', (e) => {
    config.samplingOn = e.target.checked;
    $('samplingBox').hidden = !e.target.checked;
    persistConfigSoon();
    updateXray();
  });
  $('temperature').addEventListener('input', (e) => {
    config.temperature = parseFloat(e.target.value) || 0;
    $('tempVal').textContent = Number(config.temperature).toFixed(1);
    persistConfigSoon();
    updateXray();
  });
  $('thinkingOn').addEventListener('change', (e) => {
    config.thinkingOn = e.target.checked;
    persistConfigSoon();
    updateXray();
  });
  $('systemPrompt').addEventListener('input', (e) => {
    config.systemPrompt = e.target.value;
    persistConfigSoon();
    updateXray();
  });
}

function syncConfigUI() {
  const c = config[config.provider];
  $('apiKey').value = c.apiKey;
  $('baseUrl').value = c.baseUrl;
  $('model').value = c.model;
  $('maxTokens').value = config.maxTokens;
  $('samplingOn').checked = config.samplingOn;
  $('samplingBox').hidden = !config.samplingOn;
  $('temperature').value = config.temperature;
  $('tempVal').textContent = Number(config.temperature).toFixed(1);
  const isA = config.provider === 'anthropic';
  $('thinkingRow').style.display = '';
  $('thinkingHint').style.display = '';
  $('thinkingHint').textContent = isA
    ? 'adaptive thinking · 摘要形式返回'
    : '推理模型（DeepSeek-R1 / Qwen3 等）思考流 · 勾选后请求附加 enable_thinking';
  $('thinkingOn').checked = config.thinkingOn;
  $('modelList').innerHTML = MODELS[config.provider].map((m) => `<option value="${m}">`).join('');
  $('urlHint').textContent = URL_HINTS[config.provider];
}

function bindComposer() {
  $('btnSend').addEventListener('click', run);
  $('btnStop').addEventListener('click', () => abortCtl && abortCtl.abort());
  $('input').addEventListener('input', () => { autoGrow(); renderComposer(); updateXray(); });
  $('input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  $('btnAttach').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    await addFiles([...e.target.files]);
    e.target.value = '';
  });

  /* 粘贴截图 */
  $('input').addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); await addFiles(files); }
  });

  /* 拖拽 */
  const stage = $('stage');
  let dragDepth = 0;
  stage.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
  stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    await addFiles([...e.dataTransfer.files]);
  });

  $('messages').addEventListener('click', (e) => {
    const sample = e.target.closest('[data-sample]');
    if (sample) { $('input').value = SAMPLES[+sample.dataset.sample]; $('input').focus(); autoGrow(); renderComposer(); return; }
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) {
      const f = findFile(zoom.dataset.zoom);
      if (f?.dataUrl) window.open(f.dataUrl, '_blank');
      return;
    }
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      pending = pending.filter((f) => f.id !== rm.dataset.rm);
      renderComposer();
      updateXray();
    }
  });

  /* 思考过程折叠状态记忆（toggle 不冒泡，走捕获阶段） */
  $('messages').addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName === 'DETAILS' && d.dataset.mi) {
      const m = conversation[+d.dataset.mi];
      if (m) m._thinkOpen = d.open;
    }
  }, true);

  $('attachments').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      pending = pending.filter((f) => f.id !== rm.dataset.rm);
      renderComposer();
      updateXray();
    }
  });
}

function findFile(id) {
  return pending.find((f) => f.id === id)
    || conversation.flatMap((m) => m.files || []).find((f) => f.id === id);
}

async function addFiles(files) {
  if (!files.length) return;
  for (const file of files) {
    const f = await ingestFile(file);
    pending.push(f);
    if (f.error) toast(`${f.name}：${f.error}`, true);
  }
  renderComposer();
  updateXray();
}

function bindMisc() {
  $('btnClear').addEventListener('click', () => {
    if (!conversation.length) return;
    if (!confirm('清空当前会话？此操作不可撤销。')) return;
    conversation = [];
    lastMeta = null;
    persistConversation();
    renderMessages();
    $('xrayResponse').textContent = '尚无响应。运行一次后，这里显示用量、耗时与停止原因。';
    $('xrayResponse').classList.add('code-dim');
    setMeter({});
    updateXray();
  });

  document.querySelectorAll('.xray-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.xray-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      document.querySelectorAll('[data-pane]').forEach((el) => {
        el.hidden = el.dataset.pane !== tab;
      });
    });
  });

  $('btnCopyCurl').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('xCurl').textContent);
      $('btnCopyCurl').textContent = '已复制';
      setTimeout(() => { $('btnCopyCurl').textContent = '复制'; }, 1500);
    } catch { toast('复制失败，请手动选择文本', true); }
  });

  $('btnConfigToggle').addEventListener('click', () => $('panelConfig').classList.toggle('open'));
  $('btnXrayToggle').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 1180px)').matches) {
      $('panelXray').classList.toggle('open');
    } else {
      document.querySelector('.bench').classList.toggle('no-xray');
    }
  });

  /* 滚动跟随 + 回到最新 */
  const msgBox = $('messages');
  const distFromBottom = () => msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight;
  msgBox.addEventListener('scroll', () => {
    const d = distFromBottom();
    if (d <= 50) followBottom = true;
    else if (d > 90) followBottom = false;
    updateJumpBtn();
  }, { passive: true });
  /* 输入意图兜底：scroll 事件在隐藏/后台渲染时可能不触发，wheel/touch 更可靠 */
  msgBox.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) followBottom = false;
    else if (distFromBottom() <= 140) followBottom = true;
    updateJumpBtn();
  }, { passive: true });
  msgBox.addEventListener('touchmove', () => {
    if (distFromBottom() > 140) followBottom = false;
    updateJumpBtn();
  }, { passive: true });
  $('btnJump').addEventListener('click', () => {
    followBottom = true;
    msgBox.scrollTop = msgBox.scrollHeight;
    updateJumpBtn();
  });

  /* 点击移动端抽屉外侧关闭 */
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 820 && $('panelConfig').classList.contains('open')
      && !$('panelConfig').contains(e.target) && e.target !== $('btnConfigToggle')) {
      $('panelConfig').classList.remove('open');
    }
  });
}

/* ---------- 启动 ---------- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
restoreConversation();
bindConfig();
bindComposer();
bindMisc();
syncConfigUI();
renderMessages();
renderComposer();
setMeter({});
updateXray();
