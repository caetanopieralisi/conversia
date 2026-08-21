const api = {
  async request(path, opts = {}) {
    const token = localStorage.getItem('token');
    const res = await fetch('/api' + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(opts.headers || {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) {
      localStorage.clear();
      render();
      throw new Error('Sessão expirada');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro na requisição');
    return data;
  }
};

const app = document.getElementById('app');
let pollTimer = null;

function isLoggedIn() { return !!localStorage.getItem('token'); }

function render() {
  clearInterval(pollTimer);
  if (!isLoggedIn()) return renderLogin();
  const hash = location.hash.replace('#', '') || 'conversas';
  renderShell(hash);
}
window.addEventListener('hashchange', render);

// ---------- LOGIN ----------
function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <h1>Entrar na plataforma</h1>
        <div id="login-error" class="error" style="display:none"></div>
        <input id="email" type="email" placeholder="E-mail" />
        <input id="password" type="password" placeholder="Senha" />
        <button id="login-btn" style="width:100%">Entrar</button>
      </div>
    </div>`;
  document.getElementById('login-btn').onclick = async () => {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errBox = document.getElementById('login-error');
    errBox.style.display = 'none';
    try {
      const data = await api.request('/auth/login', { method: 'POST', body: { email, password } });
      localStorage.setItem('token', data.token);
      localStorage.setItem('client', JSON.stringify(data.client || {}));
      localStorage.setItem('user', JSON.stringify(data.user || {}));
      location.hash = 'conversas';
      render();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.style.display = 'block';
    }
  };
}

// ---------- SHELL ----------
function renderShell(page) {
  const client = JSON.parse(localStorage.getItem('client') || '{}');
  app.innerHTML = `
    <div class="shell">
      <div class="sidebar">
        <div class="brand">${client.nome_empresa || 'Plataforma'}</div>
        <a data-page="conversas" class="${page === 'conversas' ? 'active' : ''}">Conversas</a>
        <a data-page="leads" class="${page === 'leads' ? 'active' : ''}">Leads</a>
        <a data-page="dashboard" class="${page === 'dashboard' ? 'active' : ''}">Dashboard</a>
        <div class="spacer"></div>
        <a id="logout">Sair</a>
      </div>
      <div class="main" id="main"></div>
    </div>`;
  app.querySelectorAll('.sidebar a[data-page]').forEach(a => {
    a.onclick = () => { location.hash = a.dataset.page; };
  });
  document.getElementById('logout').onclick = () => { localStorage.clear(); render(); };

  if (page === 'conversas') renderConversas();
  else if (page === 'leads') renderLeads();
  else if (page === 'dashboard') renderDashboard();
}

// ---------- CONVERSAS ----------
let activePhone = null;

async function renderConversas() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="convo-layout">
      <div class="convo-list" id="convo-list">Carregando...</div>
      <div class="chat" id="chat">
        <div style="margin:auto;color:var(--muted)">Selecione uma conversa</div>
      </div>
    </div>`;
  await loadConvoList();
  pollTimer = setInterval(async () => {
    await loadConvoList();
    if (activePhone) await loadChat(activePhone, true);
  }, 5000);
}

async function loadConvoList() {
  const list = document.getElementById('convo-list');
  if (!list) return;
  const convos = await api.request('/conversations');
  list.innerHTML = convos.map(c => `
    <div class="convo-item ${c.phone === activePhone ? 'active' : ''}" data-phone="${c.phone}">
      <div class="name">${c.contact_name || c.phone}</div>
      <div class="preview">${(c.direction === 'outbound' ? 'Você: ' : '') + (c.content || '')}</div>
    </div>`).join('') || '<div style="padding:12px;color:var(--muted)">Nenhuma conversa ainda</div>';
  list.querySelectorAll('.convo-item').forEach(el => {
    el.onclick = () => { activePhone = el.dataset.phone; loadChat(activePhone); loadConvoList(); };
  });
}

async function loadChat(phone, silent) {
  const chat = document.getElementById('chat');
  if (!chat) return;
  const msgs = await api.request('/conversations/' + encodeURIComponent(phone));
  const scrollBottom = !silent;
  chat.innerHTML = `
    <div class="chat-msgs" id="chat-msgs">
      ${msgs.map(m => `<div class="bubble ${m.direction === 'inbound' ? 'in' : 'out'}">${escapeHtml(m.content || '')}</div>`).join('')}
    </div>
    <div class="chat-input">
      <textarea id="msg-input" placeholder="Digite uma mensagem manual..."></textarea>
      <button id="send-btn">Enviar</button>
    </div>`;
  const msgsBox = document.getElementById('chat-msgs');
  if (scrollBottom || true) msgsBox.scrollTop = msgsBox.scrollHeight;
  document.getElementById('send-btn').onclick = async () => {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api.request('/conversations/' + encodeURIComponent(phone) + '/send', { method: 'POST', body: { message: text } });
      await loadChat(phone);
    } catch (e) {
      alert('Erro ao enviar: ' + e.message);
    }
  };
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ---------- LEADS ----------
async function renderLeads() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="filters">
      <input id="q" placeholder="Buscar por nome ou telefone" />
      <select id="status-filter">
        <option value="">Todos os status</option>
        <option value="ativo">Ativo</option>
        <option value="aguardando_humano">Aguardando humano</option>
        <option value="fechado">Fechado</option>
      </select>
    </div>
    <table>
      <thead><tr><th>Nome</th><th>Telefone</th><th>Email</th><th>Urgente</th><th>Status</th><th></th></tr></thead>
      <tbody id="leads-body"><tr><td colspan="6">Carregando...</td></tr></tbody>
    </table>`;

  async function load() {
    const q = document.getElementById('q').value;
    const status = document.getElementById('status-filter').value;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const leads = await api.request('/leads?' + params.toString());
    const body = document.getElementById('leads-body');
    body.innerHTML = leads.map(l => `
      <tr>
        <td>${l.name || '-'}</td>
        <td>${l.phone}</td>
        <td>${l.email || '-'}</td>
        <td>${l.urgent ? 'Sim' : 'Não'}</td>
        <td><span class="badge ${l.status}">${l.status}</span></td>
        <td>
          <select data-phone="${l.phone}" class="status-select">
            <option value="ativo" ${l.status === 'ativo' ? 'selected' : ''}>Ativo</option>
            <option value="aguardando_humano" ${l.status === 'aguardando_humano' ? 'selected' : ''}>Aguardando humano</option>
            <option value="fechado" ${l.status === 'fechado' ? 'selected' : ''}>Fechado</option>
          </select>
        </td>
      </tr>`).join('') || '<tr><td colspan="6">Nenhum lead encontrado</td></tr>';
    body.querySelectorAll('.status-select').forEach(sel => {
      sel.onchange = async () => {
        await api.request('/leads/' + encodeURIComponent(sel.dataset.phone) + '/status', {
          method: 'PATCH', body: { status: sel.value }
        });
        load();
      };
    });
  }
  document.getElementById('q').oninput = debounce(load, 400);
  document.getElementById('status-filter').onchange = load;
  await load();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- DASHBOARD ----------
async function renderDashboard() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  const m = await api.request('/metrics');
  const porStatus = Object.fromEntries((m.leads_por_status || []).map(s => [s.status, s.total]));
  const tempoMin = m.tempo_medio_primeira_resposta_segundos != null
    ? Math.round(m.tempo_medio_primeira_resposta_segundos / 60) + ' min'
    : '-';
  main.innerHTML = `
    <h2 style="margin-bottom:20px">Dashboard</h2>
    <div class="cards">
      <div class="card"><div class="label">Leads (30 dias)</div><div class="value">${m.leads_30_dias ?? '-'}</div></div>
      <div class="card"><div class="label">Ativos</div><div class="value">${porStatus.ativo || 0}</div></div>
      <div class="card"><div class="label">Aguardando humano</div><div class="value">${porStatus.aguardando_humano || 0}</div></div>
      <div class="card"><div class="label">Fechados</div><div class="value">${porStatus.fechado || 0}</div></div>
      <div class="card"><div class="label">Tempo médio 1ª resposta</div><div class="value">${tempoMin}</div></div>
    </div>`;
}

render();
