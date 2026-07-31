/**
 * ═══════════════════════════════════════════════════════════════
 *  JEEMO WORKSPACE — app.js
 *  Agentic AI Workspace: Xterm.js + Groq REST API + Pyodide
 *
 *  Boot order (fast-path):
 *    1. Terminal renders immediately
 *    2. Chat UI is ready immediately
 *    3. OpenAI chat works right away (no Pyodide needed)
 *    4. Pyodide loads lazily in the background — only blocks
 *       code execution, never the UI
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/* ════════════════════════════════════════════════════════════
   § 0.  CONSTANTS
   ════════════════════════════════════════════════════════════ */

const OPENAI_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_MODEL = 'llama-3.3-70b-versatile';   // fastest free Groq model
const LS_API_KEY   = 'jeemo_groq_key';

const VIRT_DIRS = [
  '/home/jeemo',
  '/home/jeemo/projects',
  '/home/jeemo/files',
  '/home/jeemo/tmp',
];

// Multiple CDN fallbacks for Pyodide — tried in order
const PYODIDE_CDNS = [
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
  'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/',
];

const SYSTEM_PROMPT = `You are Jeemo, an autonomous AI agent with access to a Python 3.11 runtime \
running in the user's browser via Pyodide. You have a virtual filesystem at /home/jeemo/ \
with subdirectories: projects/, files/, tmp/.

Rules:
1. Keep conversational text SHORT (1-3 sentences). Act, don't explain at length.
2. Output Python code in fenced blocks: \`\`\`python ... \`\`\`
3. Use only Python stdlib (os, pathlib, json, csv, math, re, datetime, etc). No pip.
4. Always print() results so the user sees output in the terminal.
5. Skip code blocks for pure questions or greetings.
6. Be concise, precise, and elegant.`;


/* ════════════════════════════════════════════════════════════
   § 1.  JEEMO TERMINAL
   ════════════════════════════════════════════════════════════ */

class JeemoTerminal {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this._ready    = false;
    this._queue    = [];   // lines printed before xterm is open

    this.xterm = new Terminal({
      fontFamily : "'Fira Code','JetBrains Mono','Cascadia Code',monospace",
      fontSize   : 13,
      lineHeight : 1.5,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      scrollback : 3000,
      theme: {
        background    : '#070a0e',
        foreground    : '#c9d1d9',
        cursor        : '#00e5ff',
        cursorAccent  : '#070a0e',
        selectionBackground: 'rgba(0,229,255,0.18)',
        black  :'#0d1117', red    :'#f85149', green :'#3fb950', yellow:'#d29922',
        blue   :'#388bfd', magenta:'#bc8cff', cyan  :'#39c5cf', white :'#b1bac4',
        brightBlack  :'#6e7681', brightRed    :'#ff7b72',
        brightGreen  :'#56d364', brightYellow :'#e3b341',
        brightBlue   :'#79c0ff', brightMagenta:'#d2a8ff',
        brightCyan   :'#56d4dd', brightWhite  :'#f0f6fc',
      },
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.xterm.loadAddon(this.fitAddon);
    this.xterm.open(this.container);

    // Fit needs a moment after open() for the DOM to settle
    requestAnimationFrame(() => {
      this.fitAddon.fit();
      this._ready = true;
      this._queue.forEach(fn => fn());
      this._queue = [];
    });

    window.addEventListener('resize', () => this.fitAddon.fit());
  }

  _write(fn) {
    if (this._ready) fn();
    else this._queue.push(fn);
  }

  writeln(t)  { this._write(() => this.xterm.writeln(t)); }
  info(t)     { this._write(() => this.xterm.writeln(`\x1b[36m${t}\x1b[0m`)); }
  success(t)  { this._write(() => this.xterm.writeln(`\x1b[32m${t}\x1b[0m`)); }
  warn(t)     { this._write(() => this.xterm.writeln(`\x1b[33m${t}\x1b[0m`)); }
  error(t)    { this._write(() => this.xterm.writeln(`\x1b[31m${t}\x1b[0m`)); }
  muted(t)    { this._write(() => this.xterm.writeln(`\x1b[2m${t}\x1b[0m`)); }
  bold(t)     { this._write(() => this.xterm.writeln(`\x1b[1m${t}\x1b[0m`)); }
  prompt(t)   { this._write(() => this.xterm.writeln(`\x1b[35m${t}\x1b[0m`)); }
  code(t)     { this._write(() => this.xterm.writeln(`\x1b[95m${t}\x1b[0m`)); }
  sep()       { this._write(() => this.xterm.writeln('')); }
  rule(c='─', w=58) { this._write(() => this.xterm.writeln(`\x1b[36m${c.repeat(w)}\x1b[0m`)); }
  clear()     { this._write(() => this.xterm.clear()); }

  printOutput(output, isErr = false) {
    if (!output || !output.trim()) return;
    output.split('\n').forEach(line => {
      if (isErr) this.error(line);
      else this.writeln(line);
    });
  }

  printBanner() {
    this.sep();
    this.rule('═');
    this.bold('  JEEMO WORKSPACE  v1.0');
    this.muted('  Groq · Llama 3.3 70B  ·  Python 3.11 (Pyodide)');
    this.rule('═');
    this.sep();
    this.success('  Terminal ready.');
    this.info('  Python runtime will load in the background.');
    this.muted('  Chat is available immediately.');
    this.sep();
  }
}


/* ════════════════════════════════════════════════════════════
   § 2.  JEEMO PYODIDE  (lazy background loader)
   ════════════════════════════════════════════════════════════ */

class JeemoPyodide {
  constructor() {
    this.pyodide   = null;
    this.ready     = false;
    this._loading  = false;
    this._promise  = null;   // reuse in-flight promise
  }

  /**
   * Start loading Pyodide in the background.
   * Safe to call multiple times — returns the same promise.
   */
  load(term, onReady, onError) {
    if (this._promise) return this._promise;

    this._loading = true;
    this._promise = this._doLoad(term, onReady, onError);
    return this._promise;
  }

  async _doLoad(term, onReady, onError) {
    // Check if the global was injected at all
    if (typeof loadPyodide === 'undefined') {
      const msg = 'Pyodide CDN script did not load. Check internet connection.';
      term.error('[python] ' + msg);
      onError && onError(msg);
      return;
    }

    term.info('[python] Loading Pyodide runtime…');

    // Try each CDN in order with a per-attempt timeout
    let loaded = false;
    for (const cdnURL of PYODIDE_CDNS) {
      term.muted(`[python] Trying CDN: ${cdnURL}`);
      try {
        const timeoutMs = 60_000;
        this.pyodide = await Promise.race([
          loadPyodide({
            indexURL: cdnURL,
            stdout: msg => term.writeln(msg),
            stderr: msg => term.error(msg),
          }),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`Timeout after ${timeoutMs/1000}s`)), timeoutMs)
          ),
        ]);
        loaded = true;
        break;
      } catch (err) {
        term.warn(`[python] CDN failed: ${err.message}`);
      }
    }

    if (!loaded) {
      const msg = 'All Pyodide CDNs failed. Python execution is disabled.\n' +
                  'Chat still works — just no code execution.';
      term.error('[python] ' + msg);
      onError && onError(msg);
      this._loading = false;
      return;
    }

    // Create virtual filesystem
    try {
      const mkdirs = VIRT_DIRS.map(d => `os.makedirs("${d}", exist_ok=True)`).join('\n');
      await this.pyodide.runPythonAsync(`import os\n${mkdirs}`);
    } catch (e) {
      term.warn('[python] FS init warning: ' + e.message);
    }

    this.ready    = true;
    this._loading = false;

    term.sep();
    term.rule('─');
    term.success('  ✦  Python runtime READY  (v' + this.pyodide.version + ')');
    term.rule('─');
    term.sep();

    onReady && onReady();
  }

  /**
   * Run a Python snippet. Captures stdout/stderr via io.StringIO.
   */
  async runCode(code) {
    if (!this.ready) return { stdout: '', stderr: '', error: 'Python runtime not ready.' };

    const wrapper = `
import sys, io as _io, traceback as _tb
_out = _io.StringIO()
_err = _io.StringIO()
_prev_out, _prev_err = sys.stdout, sys.stderr
sys.stdout, sys.stderr = _out, _err
try:
    exec(compile(${JSON.stringify(code)}, "<jeemo>", "exec"), {"__name__":"__main__"})
except Exception:
    _tb.print_exc(file=sys.stderr)
finally:
    sys.stdout, sys.stderr = _prev_out, _prev_err
_jeemo_out = _out.getvalue()
_jeemo_err = _err.getvalue()
`;
    try {
      await this.pyodide.runPythonAsync(wrapper);
      const stdout = this.pyodide.globals.get('_jeemo_out') ?? '';
      const stderr = this.pyodide.globals.get('_jeemo_err') ?? '';
      return { stdout, stderr, error: null };
    } catch (err) {
      return { stdout: '', stderr: '', error: err.message };
    }
  }

  async listDir(dirPath) {
    if (!this.ready) return [];
    try {
      const r = await this.pyodide.runPythonAsync(`
import os, json as _j
_e=[]
try:
  for n in sorted(os.listdir("${dirPath}")):
    p=os.path.join("${dirPath}",n)
    _e.append({"name":n,"isDir":os.path.isdir(p)})
except: pass
_j.dumps(_e)`);
      return JSON.parse(r);
    } catch (_) { return []; }
  }

  async readFile(path) {
    if (!this.ready) return '[Python not ready]';
    try {
      return await this.pyodide.runPythonAsync(
        `open(${JSON.stringify(path)},"r",errors="replace").read()`
      ) ?? '';
    } catch (e) { return `[Error: ${e.message}]`; }
  }
}


/* ════════════════════════════════════════════════════════════
   § 3.  JEEMO FILE TREE
   ════════════════════════════════════════════════════════════ */

class JeemoFileTree {
  constructor(rootUlId, py, onFileOpen) {
    this.rootUl     = document.getElementById(rootUlId);
    this.py         = py;
    this.onFileOpen = onFileOpen;
  }

  async refresh() {
    this.rootUl.innerHTML = '';
    if (!this.py.ready) {
      this.rootUl.innerHTML =
        '<li class="tree-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Waiting for Python…</li>';
      return;
    }
    const root = await this._buildNode('/home/jeemo', 'jeemo', true, true);
    this.rootUl.appendChild(root);
  }

  async _buildNode(path, name, isDir, expanded = false) {
    const li   = document.createElement('li');
    const item = document.createElement('div');
    item.className = `tree-item ${isDir ? 'tree-dir' : 'tree-file'}`;

    if (isDir) {
      item.innerHTML = `
        <i class="fa-solid fa-chevron-right tree-chevron"></i>
        <i class="fa-solid fa-folder-closed folder-icon"></i>
        <span>${this._esc(name)}</span>`;
      const ul = document.createElement('ul');
      ul.className   = 'tree-children';
      ul.style.display = expanded ? 'block' : 'none';

      if (expanded) {
        item.classList.add('open');
        item.querySelector('.folder-icon').className = 'fa-solid fa-folder-open folder-icon';
        await this._fill(path, ul);
      }

      item.addEventListener('click', async () => {
        const open = item.classList.toggle('open');
        item.querySelector('.folder-icon').className =
          open ? 'fa-solid fa-folder-open folder-icon' : 'fa-solid fa-folder-closed folder-icon';
        ul.style.display = open ? 'block' : 'none';
        if (open && ul.childElementCount === 0) await this._fill(path, ul);
      });

      li.appendChild(item);
      li.appendChild(ul);
    } else {
      const ext = name.split('.').pop().toLowerCase();
      item.innerHTML = `<i class="${this._icon(ext)}"></i><span>${this._esc(name)}</span>`;
      item.title = path;
      item.addEventListener('click', () => this.onFileOpen(path));
      li.appendChild(item);
    }
    return li;
  }

  async _fill(dirPath, ul) {
    const entries = await this.py.listDir(dirPath);
    if (!entries.length) {
      ul.innerHTML = '<li class="tree-loading" style="color:#4a5568">empty</li>';
      return;
    }
    const sorted = [...entries.filter(e => e.isDir), ...entries.filter(e => !e.isDir)];
    for (const e of sorted) {
      const child = await this._buildNode(`${dirPath}/${e.name}`, e.name, e.isDir);
      ul.appendChild(child);
    }
  }

  _icon(ext) {
    const m = { py:'fa-brands fa-python', js:'fa-brands fa-js',
      json:'fa-solid fa-brackets-curly', csv:'fa-solid fa-table',
      txt:'fa-solid fa-file-lines', md:'fa-solid fa-file-word',
      html:'fa-brands fa-html5', css:'fa-brands fa-css3-alt',
      png:'fa-solid fa-image', jpg:'fa-solid fa-image', svg:'fa-solid fa-draw-polygon' };
    return (m[ext] ?? 'fa-solid fa-file') + ' tree-file-icon';
  }
  _esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
}


/* ════════════════════════════════════════════════════════════
   § 4.  JEEMO CHAT
   ════════════════════════════════════════════════════════════ */

class JeemoChat {
  constructor(messagesId) {
    this.list    = document.getElementById(messagesId);
    this.history = [];
  }

  addUser(text) {
    this._bubble('user', text, false);
    this.history.push({ role: 'user', content: text });
  }

  addAgent(md, isError = false) {
    const b = this._bubble('agent', md, true, isError);
    this.history.push({ role: 'assistant', content: md });
    return b;
  }

  addSystem(text) {
    const row = document.createElement('div');
    row.className = 'msg-row system';
    const b = document.createElement('div');
    b.className   = 'msg-bubble';
    b.textContent = text;
    row.appendChild(b);
    this.list.appendChild(row);
    this._scroll();
  }

  setTyping(on) {
    const ex = document.getElementById('typing-row');
    if (on && !ex) {
      const row = document.createElement('div');
      row.id = 'typing-row'; row.className = 'msg-row agent';
      const av = document.createElement('div');
      av.className = 'msg-avatar';
      av.innerHTML = '<i class="fa-solid fa-hexagon-nodes"></i>';
      const b = document.createElement('div');
      b.className = 'msg-bubble';
      b.innerHTML = `<div class="typing-indicator">
        <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
      </div>`;
      row.appendChild(av); row.appendChild(b);
      this.list.appendChild(row);
      this._scroll();
    } else if (!on && ex) {
      ex.remove();
    }
  }

  addExecBadge(bubble, n) {
    const badge = document.createElement('div');
    badge.className = 'exec-badge';
    badge.innerHTML = `<i class="fa-solid fa-circle-play"></i> ${n} block${n!==1?'s':''} executed`;
    bubble.appendChild(badge);
  }

  clear() { this.list.innerHTML = ''; this.history = []; }

  _bubble(role, content, isMarkdown, isError = false) {
    const row = document.createElement('div');
    row.className = `msg-row ${role}`;

    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.innerHTML = role === 'agent'
      ? '<i class="fa-solid fa-hexagon-nodes"></i>'
      : '<i class="fa-solid fa-user"></i>';

    const b = document.createElement('div');
    b.className = `msg-bubble${isError ? ' error' : ''}`;

    if (isMarkdown) {
      b.innerHTML = marked.parse(content, { breaks: true, gfm: true });
    } else {
      b.textContent = content;
    }

    const ts = document.createElement('div');
    ts.className = 'msg-ts';
    ts.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    b.appendChild(ts);

    if (role === 'agent') { row.appendChild(av); row.appendChild(b); }
    else                  { row.appendChild(b);  row.appendChild(av); }

    this.list.appendChild(row);
    this._scroll();
    return b;
  }

  _scroll() { requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; }); }
}


/* ════════════════════════════════════════════════════════════
   § 5.  JEEMO OPENAI
   ════════════════════════════════════════════════════════════ */

class JeemoOpenAI {
  constructor() { this.apiKey = ''; }

  setKey(k) { this.apiKey = k.trim(); }
  get hasKey() { return !!this.apiKey; }

  async send(history) {
    // history is [{role:'user'|'assistant', content:'...'}]
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
    ];

    let res;
    try {
      res = await fetch(OPENAI_URL, {
        method : 'POST',
        headers: {
          'Content-Type' : 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0.65, max_tokens: 2048 }),
      });
    } catch (e) {
      throw new Error(`Network error: ${e.message}`);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message ?? ''; } catch (_) {}
      if (res.status === 401) throw new Error('Invalid Groq API key (401). Key must start with gsk_…');
      if (res.status === 429) throw new Error('Rate limit hit (429). Groq free tier: 30 req/min. Wait a moment and retry.');
      throw new Error(`Groq API error ${res.status}: ${detail || res.statusText}`);
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  }

  static extractCodeBlocks(text) {
    const blocks = [];
    const re = /```python\s*([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const code = m[1].trim();
      if (code) blocks.push(code);
    }
    return blocks;
  }
}


/* ════════════════════════════════════════════════════════════
   § 6.  JEEMO APP  (Orchestrator)
   ════════════════════════════════════════════════════════════ */

class JeemoApp {
  constructor() {
    this.term   = new JeemoTerminal('terminal-container');
    this.py     = new JeemoPyodide();
    this.chat   = new JeemoChat('chat-messages');
    this.openai = new JeemoOpenAI();
    this.tree   = null;
    this.busy   = false;

    this.el = {
      apiInput      : document.getElementById('api-key-input'),
      btnToggleKey  : document.getElementById('btn-toggle-key'),
      btnSaveKey    : document.getElementById('btn-save-key'),
      apiStatus     : document.getElementById('api-status'),
      chatInput     : document.getElementById('chat-input'),
      btnSend       : document.getElementById('btn-send'),
      btnClearChat  : document.getElementById('btn-clear-chat'),
      btnClearTerm  : document.getElementById('btn-clear-terminal'),
      btnRefreshTree: document.getElementById('btn-refresh-tree'),
      pyStatus      : document.getElementById('pyodide-status'),
      fileModal     : document.getElementById('file-modal'),
      modalFilename : document.getElementById('modal-filename'),
      modalContent  : document.getElementById('modal-content'),
      btnModalClose : document.getElementById('btn-modal-close'),
    };
  }

  async start() {
    // 1. Print banner immediately — terminal is ready
    this.term.printBanner();

    // 2. Bind all UI events
    this._bindUI();

    // 3. Restore saved API key
    this._restoreApiKey();

    // 4. Show welcome in chat (instant)
    this._showWelcome();

    // 5. Show initial file tree placeholder
    this.tree = new JeemoFileTree('tree-root-ul', this.py, p => this._openFile(p));
    await this.tree.refresh();   // shows "Waiting for Python…" instantly

    // 6. Kick off Pyodide in background — does NOT block UI
    this._startPyodide();
  }

  _startPyodide() {
    this._setPyChip('loading', 'Loading Python…');

    this.py.load(
      this.term,
      // onReady
      async () => {
        this._setPyChip('ready', 'Python Ready');
        await this.tree.refresh();
      },
      // onError
      (msg) => {
        this._setPyChip('error', 'Python Failed');
        this.chat.addSystem('⚠ Python runtime failed to load. Chat still works — code execution is disabled.');
      }
    );
  }

  _setPyChip(state, label) {
    const icons = { loading: 'fa-circle-notch fa-spin', ready: 'fa-circle-check', error: 'fa-triangle-exclamation' };
    const classes = { loading: 'chip-loading', ready: 'chip-ready', error: 'chip-error' };
    this.el.pyStatus.innerHTML = `<i class="fa-solid ${icons[state]}"></i> ${label}`;
    this.el.pyStatus.className = `status-chip ${classes[state]}`;
  }

  // ── UI bindings ─────────────────────────────────────────────

  _bindUI() {
    // API key
    this.el.btnSaveKey.addEventListener('click', () => this._saveKey());
    this.el.apiInput.addEventListener('keydown', e => { if (e.key==='Enter') this._saveKey(); });
    this.el.btnToggleKey.addEventListener('click', () => {
      const show = this.el.apiInput.type === 'password';
      this.el.apiInput.type = show ? 'text' : 'password';
      this.el.btnToggleKey.querySelector('i').className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    });

    // Send
    this.el.btnSend.addEventListener('click', () => this._send());
    this.el.chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
    });

    // Auto-resize textarea
    this.el.chatInput.addEventListener('input', () => {
      this.el.chatInput.style.height = 'auto';
      this.el.chatInput.style.height = Math.min(this.el.chatInput.scrollHeight, 160) + 'px';
    });

    // Clear
    this.el.btnClearChat.addEventListener('click', () => {
      this.chat.clear(); this._showWelcome();
      this.term.info('[chat] Cleared.');
    });
    this.el.btnClearTerm.addEventListener('click', () => {
      this.term.clear(); this.term.info('[terminal] Cleared.');
    });

    // Refresh tree
    this.el.btnRefreshTree.addEventListener('click', async () => {
      const icon = this.el.btnRefreshTree.querySelector('i');
      icon.classList.add('fa-spin');
      await this.tree.refresh();
      icon.classList.remove('fa-spin');
    });

    // Modal
    this.el.btnModalClose.addEventListener('click', () => this._closeModal());
    this.el.fileModal.addEventListener('click', e => { if (e.target===this.el.fileModal) this._closeModal(); });
    document.addEventListener('keydown', e => { if (e.key==='Escape') this._closeModal(); });
  }

  // ── API Key ──────────────────────────────────────────────────

  _saveKey() {
    const k = this.el.apiInput.value.trim();
    if (!k) { this._setApiStatus(false); return; }
    this.openai.setKey(k);
    localStorage.setItem(LS_API_KEY, k);
    this._setApiStatus(true);
    this.term.success('[api] Groq API key saved ✓');
    this.chat.addSystem('Groq API key connected — Jeemo is ready!');
  }

  _restoreApiKey() {
    const saved = localStorage.getItem(LS_API_KEY);
    if (saved) {
      this.el.apiInput.value = saved;
      this.openai.setKey(saved);
      this._setApiStatus(true);
    }
  }

  _setApiStatus(ok) {
    this.el.apiStatus.className = ok ? 'status-badge status-connected' : 'status-badge status-disconnected';
    this.el.apiStatus.innerHTML = ok
      ? '<i class="fa-solid fa-circle"></i> Connected'
      : '<i class="fa-solid fa-circle"></i> Disconnected';
  }

  // ── Welcome ──────────────────────────────────────────────────

  _showWelcome() {
    this.chat.addSystem('Jeemo Workspace ready.');
    this.chat.addAgent(`## Welcome to **Jeemo** ✦

I'm your autonomous AI agent powered by **Groq · Llama 3.3 70B** with a **Python 3.11** runtime.

**What I can do:**
- 📝 Write & execute Python code in your browser
- 📂 Create and manage files in the virtual filesystem
- 📊 Analyse data, do maths, manipulate text
- 🔧 Build scripts and tools on-the-fly

**Get started:** paste your **OpenAI API key** (\`sk-…\`) in the sidebar and hit **Connect**.`);
  }

  // ── Send / Agentic loop ──────────────────────────────────────

  async _send() {
    const text = this.el.chatInput.value.trim();
    if (!text || this.busy) return;

    if (!this.openai.hasKey) {
      this.chat.addSystem('⚠ Enter your Groq API key in the sidebar first.');
      return;
    }

    this.busy = true;
    this.el.btnSend.disabled    = true;
    this.el.chatInput.disabled  = true;
    this.el.chatInput.value     = '';
    this.el.chatInput.style.height = 'auto';

    this.chat.addUser(text);
    this.term.sep();
    this.term.prompt(`▶ User: ${text}`);
    this.chat.setTyping(true);

    try {
      this.term.info('[api] Sending to Groq…');
      const reply = await this.openai.send(this.chat.history);

      this.chat.setTyping(false);
      const bubble = this.chat.addAgent(reply);
      this.term.muted('[api] Response received.');

      // ── Extract and run Python blocks ──
      const blocks = JeemoOpenAI.extractCodeBlocks(reply);

      if (blocks.length > 0) {
        // If Pyodide is still loading, wait up to 30s for it
        if (!this.py.ready && this.py._loading) {
          this.term.warn('[python] Waiting for runtime to finish loading…');
          this.chat.addSystem('⏳ Python is still loading — waiting to execute code…');
          await this._waitForPy(30_000);
        }

        if (!this.py.ready) {
          this.term.error('[python] Runtime unavailable — skipping code execution.');
          this.chat.addSystem('⚠ Python unavailable — code not executed.');
        } else {
          this.term.sep();
          this.term.rule('─');
          this.term.code(`  ⟨ Jeemo ⟩  Running ${blocks.length} code block(s)`);
          this.term.rule('─');

          let ran = 0;
          for (let i = 0; i < blocks.length; i++) {
            const code = blocks[i];
            this.term.sep();
            this.term.code(`── Block ${i+1}/${blocks.length} ─────────────────────────────`);
            code.split('\n').forEach(l => this.term.muted('  ' + l));
            this.term.sep();

            const { stdout, stderr, error } = await this.py.runCode(code);
            if (stdout) { this.term.writeln('\x1b[32m── stdout ──\x1b[0m'); this.term.printOutput(stdout, false); }
            if (stderr) { this.term.writeln('\x1b[33m── stderr ──\x1b[0m'); this.term.printOutput(stderr, true); }
            if (error)  { this.term.error(`── error: ${error}`); }
            if (!stdout && !stderr && !error) this.term.muted('  (no output)');
            ran++;
          }

          this.term.sep();
          this.term.rule('─');
          this.term.success(`  ✓  Done (${ran} block${ran!==1?'s':''})`);
          this.term.rule('─');
          this.term.sep();

          this.chat.addExecBadge(bubble, ran);
          await this.tree.refresh();
        }
      }

    } catch (err) {
      this.chat.setTyping(false);
      this.chat.addAgent(`⚠ **Error:** ${err.message}`, true);
      this.term.error('[ERROR] ' + err.message);
    }

    this.busy = false;
    this.el.btnSend.disabled   = false;
    this.el.chatInput.disabled = false;
    this.el.chatInput.focus();
  }

  /** Poll until py.ready or timeout */
  _waitForPy(ms) {
    return new Promise(resolve => {
      const start    = Date.now();
      const interval = setInterval(() => {
        if (this.py.ready || Date.now() - start > ms) {
          clearInterval(interval);
          resolve();
        }
      }, 500);
    });
  }

  // ── File modal ───────────────────────────────────────────────

  async _openFile(path) {
    const content = await this.py.readFile(path);
    this.el.modalFilename.innerHTML =
      `<i class="fa-solid fa-file-code"></i> ${path.split('/').pop()}`;
    this.el.modalContent.textContent = content;
    this.el.fileModal.classList.remove('hidden');
  }

  _closeModal() {
    this.el.fileModal.classList.add('hidden');
    this.el.modalContent.textContent = '';
  }
}


/* ════════════════════════════════════════════════════════════
   § 7.  BOOTSTRAP
   ════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  const app = new JeemoApp();
  window.__jeemo__ = app;   // expose for DevTools debugging
  app.start();              // intentionally not awaited at top level
});
