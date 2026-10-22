const form = document.querySelector('#repoForm');
const input = document.querySelector('#repoUrl');
const runBtn = document.querySelector('#runBtn');
const logSection = document.querySelector('#logSection');
const logEl = document.querySelector('#log');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');

const STEP_NAME = {
  files: 'github.list_files',
  manifest: 'code.inspect_manifest',
  deps: 'code.trace_dependencies',
  brief: 'agent.compose_brief',
};
const STEP_ORDER = ['files', 'manifest', 'deps', 'brief'];

let current = null;
let es = null;
let lineEls = {};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function resetLog() {
  logEl.innerHTML = '';
  lineEls = {};
  statusEl.textContent = '';
  statusEl.className = 'status';
}

function lineFor(id) {
  if (!lineEls[id]) {
    const idx = STEP_ORDER.indexOf(id) + 1;
    const el = document.createElement('div');
    el.className = 'line running';
    el.innerHTML =
      '<span class="n">' + idx + '</span>' +
      '<span class="name">' + STEP_NAME[id] + '</span>' +
      '<span class="st">running</span>' +
      '<span class="detail"></span>' +
      '<span class="ms"></span>';
    logEl.appendChild(el);
    lineEls[id] = { el, start: performance.now() };
  }
  return lineEls[id];
}

function setLine(id, status, detail) {
  const rec = lineFor(id);
  const el = rec.el;
  el.className = 'line ' + status;
  el.querySelector('.st').textContent = status;
  if (detail) el.querySelector('.detail').textContent = detail;
  if (status !== 'running') {
    el.querySelector('.ms').textContent = Math.round(performance.now() - rec.start) + ' ms';
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderBrief(b) {
  current = b;

  document.querySelector('#repoName').textContent = b.repo.fullName;
  document.querySelector('#repoDesc').textContent = b.repo.description;

  const meta = [
    ['主语言', b.repo.language],
    ['默认分支', b.repo.branch],
    ['Star', b.repo.stars == null ? '—' : String(b.repo.stars)],
    ['最近提交', fmtDate(b.repo.updatedAt)],
    ['可见文件', b.stats.files + ' 个'],
    ['协议', b.repo.license],
  ];
  document.querySelector('#metaTable').innerHTML =
    '<tbody>' + meta.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('') + '</tbody>';

  const stackRows = b.stack.length
    ? b.stack
        .map(
          (s) =>
            '<tr><td>' + esc(s.name) + '</td><td class="sub">' + esc(s.role) + '</td><td class="sub">' + esc(s.evidence) + '</td></tr>'
        )
        .join('')
    : '<tr><td colspan="3" class="sub">没有在依赖清单里找到可识别的技术栈特征</td></tr>';
  document.querySelector('#stackTable').innerHTML =
    '<thead><tr><th>名称</th><th>角色</th><th>判断依据</th></tr></thead><tbody>' + stackRows + '</tbody>';

  const maxFiles = Math.max(1, ...b.modules.map((m) => m.files));
  const moduleRows = b.modules.length
    ? b.modules
        .map(
          (m) =>
            '<tr><td>' + esc(m.dir) + '</td>' +
            '<td class="sub">' + esc(m.hint) +
            ' <span class="bar"><i style="width:' + Math.round((m.files / maxFiles) * 100) + '%"></i></span></td>' +
            '<td class="num">' + m.files + '</td></tr>'
        )
        .join('')
    : '<tr><td colspan="3" class="sub">目录为空</td></tr>';
  document.querySelector('#moduleTable').innerHTML =
    '<thead><tr><th>目录</th><th>说明</th><th>文件</th></tr></thead><tbody>' + moduleRows + '</tbody>';

  document.querySelector('#readList').innerHTML = b.readFirst.length
    ? b.readFirst.map((r) => '<li><code>' + esc(r.path) + '</code><span>' + esc(r.reason) + '</span></li>').join('')
    : '<li>没有可推荐的入口文件</li>';

  const t = b.firstTask;
  document.querySelector('#taskBox').innerHTML =
    '<h4>' + esc(t.title) + '</h4><p>' + esc(t.why) + '</p><ol>' +
    t.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>';

  document.querySelector('#questionList').innerHTML = b.questions.length
    ? b.questions.map((q) => '<li>' + esc(q) + '</li>').join('')
    : '<li>没有发现明显的信息缺口</li>';

  resultEl.classList.remove('hidden');
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toMarkdown(b) {
  const out = [];
  out.push('# 接手简报：' + b.repo.fullName, '');
  out.push('> ' + b.repo.description, '');
  out.push('## 概况', '');
  out.push('- 主语言：' + b.repo.language);
  out.push('- 默认分支：' + b.repo.branch);
  out.push('- Star：' + (b.repo.stars == null ? '—' : b.repo.stars));
  out.push('- 最近提交：' + fmtDate(b.repo.updatedAt));
  out.push('- 可见文件：' + b.stats.files);
  out.push('- 协议：' + b.repo.license, '');
  out.push('## 技术栈', '');
  b.stack.forEach((s) => out.push('- ' + s.name + '（' + s.role + '）— 依据：' + s.evidence));
  out.push('', '## 代码地图', '');
  b.modules.forEach((m) => out.push('- `' + m.dir + '` — ' + m.hint + '，' + m.files + ' 个文件'));
  out.push('', '## 建议先读', '');
  b.readFirst.forEach((r, i) => out.push(i + 1 + '. `' + r.path + '` — ' + r.reason));
  out.push('', '## 可以接手的第一个任务：' + b.firstTask.title, '', b.firstTask.why, '');
  b.firstTask.steps.forEach((s) => out.push('- ' + s));
  out.push('', '## 待确认', '');
  b.questions.forEach((q) => out.push('- ' + q));
  return out.join('\n');
}

function start() {
  const value = input.value.trim();
  if (!value) return;
  if (es) {
    es.close();
    es = null;
  }
  resultEl.classList.add('hidden');
  logSection.classList.remove('hidden');
  resetLog();
  statusEl.textContent = '正在连接…';
  runBtn.disabled = true;
  runBtn.textContent = '分析中';

  es = new EventSource('/api/analyze?repo=' + encodeURIComponent(value));

  es.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }
    if (msg.type === 'start') {
      STATUS_start(msg.repo);
    } else if (msg.type === 'step') {
      setLine(msg.id, msg.status, msg.detail);
      statusEl.textContent = msg.detail || '';
    } else if (msg.type === 'brief') {
      setLine('brief', 'done', '简报已生成');
      statusEl.textContent = '完成';
      renderBrief(msg.data);
      finish();
    } else if (msg.type === 'error') {
      statusEl.className = 'status error';
      statusEl.textContent = msg.message;
      const running = Object.keys(lineEls).find((k) => lineEls[k].el.classList.contains('running'));
      if (running) setLine(running, 'error', msg.message);
      finish();
    }
  };

  es.onerror = () => {
    if (statusEl.textContent !== '完成') {
      statusEl.className = 'status error';
      statusEl.textContent = '连接中断，请重试';
    }
    finish();
  };
}

function STATUS_start(repo) {
  statusEl.textContent = '正在分析 ' + repo;
}

function finish() {
  if (es) {
    es.close();
    es = null;
  }
  runBtn.disabled = false;
  runBtn.textContent = '分析';
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  start();
});

document.querySelectorAll('.textlink[data-repo]').forEach((btn) => {
  btn.addEventListener('click', () => {
    input.value = btn.dataset.repo;
    start();
  });
});

document.querySelector('#copyBtn').addEventListener('click', async () => {
  if (!current) return;
  const md = toMarkdown(current);
  const label = document.querySelector('#copyBtn');
  try {
    await navigator.clipboard.writeText(md);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  label.textContent = '已复制';
  setTimeout(() => {
    label.textContent = '复制 Markdown';
  }, 1600);
});
