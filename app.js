/**
 * JEEMO — app.js v5
 * Claude-like UI · Groq · Pyodide (cached via Service Worker)
 */
'use strict';

/* ══ CONSTANTS ══ */
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const LS_KEY     = 'jeemo_groq_key';
const LS_CONVS   = 'jeemo_conversations';
const LS_SB      = 'jeemo_sb';

const VIRT_DIRS = ['/home/jeemo','/home/jeemo/projects','/home/jeemo/files','/home/jeemo/tmp'];

// Tried in order — first to load wins
const PY_CDNS = [
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
  'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/',
  'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/',
];

const SYSTEM = `You are Jeemo, a helpful AI assistant. You also have access to a Python 3.11 runtime (Pyodide) running in the user's browser, with a virtual filesystem at /home/jeemo/ (subdirs: projects, files, tmp).

CRITICAL RULES about when to write code:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Write a \`\`\`python block ONLY when the user asks you to:
   - Create, read, edit, list, copy, or delete files
   - Run calculations, generate data, process text/CSV/JSON
   - Write a script or program they can download
   - Do something requiring actual computation or file output

❌ Do NOT write code for:
   - Greetings ("hi", "hello", "how are you")  
   - General questions ("what is X", "explain Y")
   - Opinions or advice
   - Anything that's just a conversation

WHEN you do write code:
   - 1 short sentence of explanation, then the \`\`\`python block
   - Always print() results so the user sees output
   - Save results to /home/jeemo/files/ so user can download
   - stdlib only: os, pathlib, json, csv, math, re, datetime, shutil, random, string
   - No pip installs

Be warm, concise, and helpful — like Claude.`;

/* ══ UTILS ══ */
const $   = id => document.getElementById(id);
const esc = s  => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const uid = () => Math.random().toString(36).slice(2,10);
const now = () => new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});

function dl(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text],{type:'text/plain'}));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},100);
}

/* ══ SERVICE WORKER — caches Pyodide permanently ══ */
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}

/* ══ PYODIDE LOADER ══ */
class Py {
  constructor(){ this.inst=null; this.ready=false; this._p=null; }

  load(onStatus, onReady, onErr) {
    if (this._p) return this._p;
    this._p = this._run(onStatus, onReady, onErr);
  }

  async _run(onStatus, onReady, onErr) {
    onStatus('loading','Loading Python…');

    // Try each CDN in order until one works
    let cdn = null;
    for (const url of PY_CDNS) {
      try {
        onStatus('loading', `Trying CDN…`);
        await this._loadScript(url + 'pyodide.js');
        if (typeof loadPyodide === 'function') { cdn = url; break; }
      } catch(e) { console.warn('[py] CDN failed:', url); }
    }

    if (!cdn) {
      onStatus('error','Python Failed');
      onErr('Could not load Pyodide. Try refreshing the page.');
      return;
    }

    onStatus('loading','Starting Python…');
    try {
      this.inst = await Promise.race([
        loadPyodide({ indexURL: cdn }),
        new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),90_000)),
      ]);
      const mk = VIRT_DIRS.map(d=>`os.makedirs("${d}",exist_ok=True)`).join('\n');
      await this.inst.runPythonAsync(`import os\n${mk}`);
      this.ready = true;
      onStatus('ready','Python Ready');
      onReady?.();
    } catch(e) {
      onStatus('error','Python Failed');
      onErr(e.message);
    }
  }

  _loadScript(src) {
    // Check if already loaded (SW cache hit = fast)
    if (typeof loadPyodide === 'function') return Promise.resolve();
    // Remove old failed scripts
    document.querySelectorAll('script[data-py]').forEach(s=>s.remove());
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.setAttribute('data-py','1'); s.crossOrigin='anonymous';
      const t = setTimeout(()=>{ s.remove(); fail(new Error('timeout')); }, 25_000);
      s.onload  = ()=>{ clearTimeout(t); ok(); };
      s.onerror = ()=>{ clearTimeout(t); s.remove(); fail(new Error('load error')); };
      document.head.appendChild(s);
    });
  }

  async run(code) {
    if (!this.ready) return {out:'',err:'',error:'Python not ready.'};
    try {
      await this.inst.runPythonAsync(`
import sys,io as _io,traceback as _tb
_o=_io.StringIO();_e=_io.StringIO()
_so,_se=sys.stdout,sys.stderr
sys.stdout,sys.stderr=_o,_e
try:
    exec(compile(${JSON.stringify(code)},"<jeemo>","exec"),{"__name__":"__main__"})
except:
    _tb.print_exc(file=sys.stderr)
finally:
    sys.stdout,sys.stderr=_so,_se
_jo=_o.getvalue();_je=_e.getvalue()`);
      return {out:this.inst.globals.get('_jo')??'',err:this.inst.globals.get('_je')??'',error:null};
    } catch(e){return {out:'',err:'',error:e.message};}
  }

  async ls(dir) {
    if(!this.ready) return [];
    try {
      const r=await this.inst.runPythonAsync(`
import os,json as _j
_e=[]
try:
  for n in sorted(os.listdir(${JSON.stringify(dir)})):
    p=os.path.join(${JSON.stringify(dir)},n)
    _e.append({"name":n,"isDir":os.path.isdir(p)})
except:pass
_j.dumps(_e)`);
      return JSON.parse(r);
    } catch{return [];}
  }

  async read(p) {
    if(!this.ready) return '[not ready]';
    try{return await this.inst.runPythonAsync(`open(${JSON.stringify(p)},"r",errors="replace").read()`)??'';}
    catch(e){return `[Error: ${e.message}]`;}
  }

  async allFiles() {
    if(!this.ready) return [];
    const {out}=await this.run(`
import os,json
f=[]
for r,d,files in os.walk('/home/jeemo'):
  for n in files:
    fp=os.path.join(r,n)
    try:f.append({'path':fp,'size':os.path.getsize(fp)})
    except:pass
print(json.dumps(f))`);
    try{return JSON.parse(out.trim());}catch{return[];}
  }
}

/* ══ STORE ══ */
class Store {
  constructor(){try{this.d=JSON.parse(localStorage.getItem(LS_CONVS)||'{}')}catch{this.d={}}}
  _s(){localStorage.setItem(LS_CONVS,JSON.stringify(this.d));}
  create(t='New chat'){const id=uid();this.d[id]={id,t,ts:Date.now(),msgs:[]};this._s();return id;}
  get(id){return this.d[id]??null;}
  list(){return Object.values(this.d).sort((a,b)=>b.ts-a.ts);}
  add(id,role,content){if(this.d[id]){this.d[id].msgs.push({role,content});this._s();}}
  title(id,t){if(this.d[id]){this.d[id].t=t;this._s();}}
  del(id){delete this.d[id];this._s();}
  history(id){return(this.d[id]?.msgs??[]).map(m=>({role:m.role,content:m.content}));}
  clear(id){if(this.d[id]){this.d[id].msgs=[];this._s();}}
}

/* ══ CHAT UI ══ */
class UI {
  constructor(){ this.el=$('messages'); }

  showEmpty() {
    this.el.innerHTML=`
    <div class="empty-state">
      <div class="empty-icon"><i class="fa-solid fa-hexagon-nodes"></i></div>
      <div class="empty-title">How can I help you today?</div>
      <div class="empty-sub">Ask me anything, or use one of these to get started:</div>
      <div class="suggestion-grid">
        <button class="suggestion-btn" data-s="Create a file called notes.txt with today's date and a short greeting">📄 Create a text file with today's date</button>
        <button class="suggestion-btn" data-s="Generate a CSV file with 10 random employee records (name, age, department, salary) and save it">📊 Generate a CSV with random data</button>
        <button class="suggestion-btn" data-s="Calculate and print the first 50 prime numbers, then save them to a file">🔢 Calculate the first 50 prime numbers</button>
        <button class="suggestion-btn" data-s="List all files in my virtual filesystem">📁 List all my files</button>
      </div>
    </div>`;
  }

  addUser(text) {
    return this._row('user', 'You', text, false);
  }

  addAgent(md) {
    return this._row('agent', 'Jeemo', md, true);
  }

  addSystem(text) {
    const d=document.createElement('div');
    d.className='msg-wrap system-wrap';
    d.innerHTML=`<div class="msg-inner" style="justify-content:center"><div class="sys-msg">${esc(text)}</div></div>`;
    this._append(d);
  }

  typing(on) {
    const ex=$('typing-row');
    if(on&&!ex){
      const d=document.createElement('div');
      d.id='typing-row';d.className='msg-wrap agent-wrap';
      d.innerHTML=`<div class="msg-inner">
        <div class="msg-avatar"><i class="fa-solid fa-hexagon-nodes"></i></div>
        <div class="msg-body">
          <div class="msg-name">Jeemo</div>
          <div class="msg-content"><div class="typing-dots">
            <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
          </div></div>
        </div>
      </div>`;
      this._append(d);
    } else if(!on&&ex) ex.remove();
  }

  appendExecLog(logEl) {
    // Append to the last agent message body
    const bodies = this.el.querySelectorAll('.agent-wrap .msg-body');
    const last = bodies[bodies.length-1];
    if(last) last.appendChild(logEl);
    this._scroll();
  }

  clear() { this.el.innerHTML=''; }

  _row(role, name, content, isMd) {
    // Clear empty state if present
    const empty = this.el.querySelector('.empty-state');
    if(empty) empty.remove();

    const wrap = document.createElement('div');
    wrap.className = `msg-wrap ${role}-wrap`;

    const inner = document.createElement('div');
    inner.className = 'msg-inner';

    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.innerHTML = role==='agent'
      ? '<i class="fa-solid fa-hexagon-nodes"></i>'
      : '<i class="fa-solid fa-user"></i>';

    const body = document.createElement('div');
    body.className = 'msg-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'msg-name';
    nameEl.textContent = name;

    const contentEl = document.createElement('div');
    contentEl.className = 'msg-content';

    if(isMd) {
      contentEl.innerHTML = marked.parse(content, {breaks:true, gfm:true});
      // Add code block headers + copy buttons
      contentEl.querySelectorAll('pre').forEach(pre => {
        const code = pre.querySelector('code');
        const lang = code?.className.replace('language-','') || '';
        const hdr = document.createElement('div');
        hdr.className = 'code-hdr';
        hdr.innerHTML = `<span>${lang||'code'}</span>`;
        const btn = document.createElement('button');
        btn.className='copy-btn'; btn.textContent='Copy';
        btn.onclick = ()=>{
          navigator.clipboard.writeText(code?.textContent??'');
          btn.textContent='Copied!';
          setTimeout(()=>btn.textContent='Copy',1500);
        };
        hdr.appendChild(btn);
        pre.insertBefore(hdr, pre.firstChild);
      });
    } else {
      contentEl.textContent = content;
    }

    body.appendChild(nameEl);
    body.appendChild(contentEl);
    inner.appendChild(av);
    inner.appendChild(body);
    wrap.appendChild(inner);
    this._append(wrap);
    return body; // return body so we can append exec log to it
  }

  _append(el) { this.el.appendChild(el); this._scroll(); }
  _scroll() { requestAnimationFrame(()=>{ this.el.scrollTop=this.el.scrollHeight; }); }
}

/* ══ EXEC LOG ══ */
class Log {
  constructor(){ this._l=[]; }
  reset(){ this._l=[]; }
  ok(t) { this._l.push({c:'log-ok', t}); }
  err(t){ this._l.push({c:'log-err',t}); }
  dim(t){ this._l.push({c:'log-dim',t}); }

  build(n) {
    const wrap=document.createElement('div'); wrap.className='exec-log';
    const hdr=document.createElement('div'); hdr.className='exec-log-hdr';
    hdr.innerHTML=`<span><i class="fa-solid fa-circle-play"></i> ${n} block${n!==1?'s':''} executed</span>
      <button class="icon-btn" id="log-tgl" style="font-size:11px"><i class="fa-solid fa-chevron-down"></i></button>`;
    const body=document.createElement('div'); body.className='exec-log-body';
    this._l.forEach(l=>{ const d=document.createElement('div'); d.className=l.c; d.textContent=l.t; body.appendChild(d); });
    hdr.querySelector('#log-tgl').onclick = ()=>{
      const h=body.style.display==='none';
      body.style.display=h?'block':'none';
      hdr.querySelector('i').className=h?'fa-solid fa-chevron-down':'fa-solid fa-chevron-right';
    };
    wrap.appendChild(hdr); wrap.appendChild(body);
    return wrap;
  }
}

/* ══ GROQ ══ */
class Groq {
  constructor(k){ this.k=k; }
  async verify(){
    const r=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${this.k}`},body:JSON.stringify({model:GROQ_MODEL,messages:[{role:'user',content:'hi'}],max_tokens:5})});
    if(r.status===401) throw new Error('invalid_key');
    if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d?.error?.message||`HTTP ${r.status}`);}
  }
  async send(history){
    const r=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${this.k}`},body:JSON.stringify({model:GROQ_MODEL,messages:[{role:'system',content:SYSTEM},...history],temperature:.7,max_tokens:2048})});
    if(!r.ok){const d=await r.json().catch(()=>({}));if(r.status===401)throw new Error('Invalid API key.');if(r.status===429)throw new Error('Rate limit — wait a moment.');throw new Error(d?.error?.message||`Error ${r.status}`);}
    return(await r.json())?.choices?.[0]?.message?.content??'';
  }
  static blocks(text){
    const b=[];const re=/```python\s*([\s\S]*?)```/gi;let m;
    while((m=re.exec(text))!==null){const c=m[1].trim();if(c)b.push(c);}
    return b;
  }
}

/* ══ SIDEBAR ══ */
class Sidebar {
  constructor(){ this.mobile=()=>window.innerWidth<=768; }
  init(){
    $('btn-sidebar-toggle').onclick=()=>this.toggle();
    $('sb-overlay').onclick=()=>this.close();
    window.addEventListener('resize',()=>{ if(!this.mobile()){$('sidebar').classList.remove('mobile-open');$('sb-overlay').classList.remove('on');} });
    // Restore desktop state
    const saved=localStorage.getItem(LS_SB);
    if(saved==='0'&&!this.mobile()) this._setDesktop(false);
  }
  open(){ if(this.mobile()){$('sidebar').classList.add('mobile-open');$('sb-overlay').classList.add('on');}else{this._setDesktop(true);} }
  close(){ if(this.mobile()){$('sidebar').classList.remove('mobile-open');$('sb-overlay').classList.remove('on');}else{this._setDesktop(false);} }
  toggle(){ const open=this.mobile()?$('sidebar').classList.contains('mobile-open'):!$('sidebar').classList.contains('sidebar-closed'); open?this.close():this.open(); }
  _setDesktop(on){ $('sidebar').classList.toggle('sidebar-closed',!on); localStorage.setItem(LS_SB,on?'1':'0'); }
}

/* ══ APP ══ */
class App {
  constructor(){
    this.py    = new Py();
    this.groq  = null;
    this.ui    = null;
    this.store = new Store();
    this.log   = new Log();
    this.sb    = new Sidebar();
    this.busy  = false;
    this.cid   = null; // current conversation id
  }

  start(){
    registerSW();
    this._bindGate();
    const k=localStorage.getItem(LS_KEY);
    if(k){ this.groq=new Groq(k); this._launch(); }
  }

  /* GATE */
  _bindGate(){
    const inp=$('gate-input'),err=$('gate-err'),errMsg=$('gate-err-msg');
    $('gate-eye').onclick=()=>{
      const s=inp.type==='password'; inp.type=s?'text':'password';
      $('gate-eye').querySelector('i').className=s?'fa-solid fa-eye-slash':'fa-solid fa-eye';
    };
    const go=async()=>{
      const k=inp.value.trim(); err.classList.add('hidden');
      if(!k){errMsg.textContent='Please enter your API key.';err.classList.remove('hidden');return;}
      if(!k.startsWith('gsk_')){errMsg.textContent='Groq keys start with gsk_';err.classList.remove('hidden');return;}
      $('gate-btn-t').classList.add('hidden');$('gate-btn-l').classList.remove('hidden');$('gate-btn').disabled=true;
      try{
        const g=new Groq(k); await g.verify();
        localStorage.setItem(LS_KEY,k); this.groq=g; this._launch();
      }catch(e){
        $('gate-btn-t').classList.remove('hidden');$('gate-btn-l').classList.add('hidden');$('gate-btn').disabled=false;
        errMsg.textContent=e.message==='invalid_key'?'Invalid API key — double-check and try again.':'Error: '+e.message;
        err.classList.remove('hidden');
      }
    };
    $('gate-btn').onclick=go;
    inp.onkeydown=e=>{if(e.key==='Enter')go();};
  }

  /* LAUNCH */
  _launch(){
    $('screen-gate').classList.remove('active');$('screen-gate').classList.add('hidden');
    $('screen-app').classList.remove('hidden');$('screen-app').classList.add('active');

    this.ui=new UI();
    this.sb.init();
    this._bindApp();
    this._renderConvs();

    const list=this.store.list();
    if(list.length) this._loadConv(list[0].id);
    else this._newConv();

    // Start Pyodide silently
    this.py.load(
      (s,l)=>this._pyChip(s,l),
      ()=>{},
      msg=>this.ui.addSystem('⚠ Python: '+msg)
    );
  }

  _pyChip(s,l){
    const el=$('py-chip'); el.className='py-chip '+s;
    el.innerHTML=`${s==='loading'?'<i class="fa-solid fa-circle-notch fa-spin"></i>':s==='ready'?'<i class="fa-solid fa-circle-check"></i>':'<i class="fa-solid fa-triangle-exclamation"></i>'} <span>${l}</span>`;
  }

  /* CONVERSATIONS */
  _newConv(){
    const id=this.store.create(); this.cid=id;
    this.ui.clear(); this.ui.showEmpty();
    $('conv-title').textContent='New chat';
    this._renderConvs();
  }

  _loadConv(id){
    const c=this.store.get(id); if(!c)return;
    this.cid=id; this.ui.clear();
    $('conv-title').textContent=c.t;
    if(!c.msgs.length) this.ui.showEmpty();
    else c.msgs.forEach(m=>m.role==='user'?this.ui.addUser(m.content):this.ui.addAgent(m.content));
    this._renderConvs();
    if(this.sb.mobile()) this.sb.close();
  }

  _renderConvs(){
    const el=$('conv-list'); el.innerHTML='';
    const list=this.store.list();
    if(!list.length){el.innerHTML='<div style="padding:10px 12px;font-size:12px;color:var(--text-3)">No conversations yet</div>';return;}
    list.forEach(c=>{
      const d=document.createElement('div');
      d.className='conv-item'+(c.id===this.cid?' active':'');
      d.innerHTML=`<i class="fa-solid fa-comment-dots"></i><span>${esc(c.t)}</span><button class="conv-del" title="Delete"><i class="fa-solid fa-trash-can"></i></button>`;
      d.onclick=e=>{if(e.target.closest('.conv-del'))return;this._loadConv(c.id);};
      d.querySelector('.conv-del').onclick=e=>{e.stopPropagation();this.store.del(c.id);if(this.cid===c.id)this._newConv();else this._renderConvs();};
      el.appendChild(d);
    });
  }

  /* BINDINGS */
  _bindApp(){
    $('btn-new').onclick=()=>this._newConv();
    $('btn-logout').onclick=()=>{localStorage.removeItem(LS_KEY);location.reload();};
    $('btn-send').onclick=()=>this._send();
    $('btn-clear').onclick=()=>{this.ui.clear();this.store.clear(this.cid);this.ui.showEmpty();};
    $('btn-files').onclick=()=>this._openFiles();

    $('msg-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();this._send();}};
    $('msg-input').oninput=()=>{const el=$('msg-input');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,180)+'px';};

    // Suggestion buttons (delegated)
    $('messages').addEventListener('click',e=>{
      const btn=e.target.closest('.suggestion-btn');
      if(btn){$('msg-input').value=btn.dataset.s;this._send();}
    });

    $('btn-files-close').onclick=()=>$('files-modal').classList.add('hidden');
    $('files-modal').onclick=e=>{if(e.target===$('files-modal'))$('files-modal').classList.add('hidden');};
    $('btn-viewer-close').onclick=()=>$('viewer-modal').classList.add('hidden');
    $('viewer-modal').onclick=e=>{if(e.target===$('viewer-modal'))$('viewer-modal').classList.add('hidden');};
    document.onkeydown=e=>{if(e.key==='Escape'){$('files-modal').classList.add('hidden');$('viewer-modal').classList.add('hidden');}};
  }

  /* SEND */
  async _send(){
    const inp=$('msg-input'),text=inp.value.trim();
    if(!text||this.busy)return;

    this.busy=true; $('btn-send').disabled=true; inp.disabled=true;
    inp.value=''; inp.style.height='auto';

    // Clear empty state
    const empty=$('messages').querySelector('.empty-state');
    if(empty) empty.remove();

    this.ui.addUser(text);
    this.store.add(this.cid,'user',text);

    // Auto-title
    const c=this.store.get(this.cid);
    if(c&&c.msgs.length===1){
      const t=text.slice(0,46)+(text.length>46?'…':'');
      this.store.title(this.cid,t);
      $('conv-title').textContent=t;
      this._renderConvs();
    }

    this.ui.typing(true);
    try{
      const reply=await this.groq.send(this.store.history(this.cid));
      this.ui.typing(false);
      const body=this.ui.addAgent(reply);
      this.store.add(this.cid,'assistant',reply);

      const blocks=Groq.blocks(reply);
      if(blocks.length){
        if(!this.py.ready&&this.py._p){
          this.ui.addSystem('⏳ Python is loading, please wait…');
          await this._waitPy(45_000);
        }
        if(!this.py.ready){
          this.ui.addSystem('⚠ Python not available — code was not executed.');
        } else {
          this.log.reset();
          this.log.dim(`Running ${blocks.length} block(s)…\n`);
          let ran=0;
          for(let i=0;i<blocks.length;i++){
            const code=blocks[i];
            this.log.dim(`── Block ${i+1} ──────────────`);
            const{out,err,error}=await this.py.run(code);
            if(out) out.trimEnd().split('\n').forEach(l=>this.log.ok(l));
            if(err)  err.trimEnd().split('\n').forEach(l=>this.log.err(l));
            if(error) this.log.err('Error: '+error);
            if(!out&&!err&&!error) this.log.dim('(no output)');
            ran++;
          }
          this.log.dim(`\n✓ Done`);
          body.appendChild(this.log.build(ran));
          // Refresh file list silently
        }
      }
    }catch(e){
      this.ui.typing(false);
      this.ui.addAgent(`Sorry, I ran into an error: **${e.message}**`);
    }

    this.busy=false; $('btn-send').disabled=false; inp.disabled=false; inp.focus();
  }

  _waitPy(ms){
    return new Promise(r=>{const s=Date.now();const t=setInterval(()=>{if(this.py.ready||Date.now()-s>ms){clearInterval(t);r();}},400);});
  }

  /* FILES MODAL */
  async _openFiles(){
    $('files-modal').classList.remove('hidden');
    const list=$('files-list');
    list.innerHTML='<div style="color:var(--text-3);padding:16px;text-align:center"><i class="fa-solid fa-circle-notch fa-spin"></i> Scanning…</div>';
    if(!this.py.ready){list.innerHTML='<div style="color:var(--text-3);padding:16px;text-align:center">Python not ready yet.</div>';return;}
    const files=await this.py.allFiles();
    list.innerHTML='';
    if(!files.length){list.innerHTML='<div style="color:var(--text-3);padding:20px;text-align:center">No files yet — ask Jeemo to create some!</div>';return;}
    files.forEach(f=>{
      const card=document.createElement('div'); card.className='file-card';
      const sz=f.size>1024?`${(f.size/1024).toFixed(1)} KB`:`${f.size} B`;
      card.innerHTML=`<i class="fa-solid fa-file"></i>
        <span class="file-path">${esc(f.path)}</span>
        <span class="file-size">${sz}</span>
        <button class="action-btn" data-v><i class="fa-solid fa-eye"></i> View</button>
        <button class="action-btn" data-d><i class="fa-solid fa-download"></i></button>`;
      card.querySelector('[data-v]').onclick=async()=>{
        $('files-modal').classList.add('hidden');
        const content=await this.py.read(f.path);
        $('viewer-name').textContent=f.path.split('/').pop();
        $('viewer-content').textContent=content;
        $('btn-viewer-dl').onclick=()=>dl(f.path.split('/').pop(),content);
        $('viewer-modal').classList.remove('hidden');
      };
      card.querySelector('[data-d]').onclick=async()=>dl(f.path.split('/').pop(),await this.py.read(f.path));
      list.appendChild(card);
    });
  }
}

document.addEventListener('DOMContentLoaded',()=>{
  window.__jeemo__=new App();
  window.__jeemo__.start();
});
