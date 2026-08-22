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
function isAdmin() { return location.hash.startsWith('#admin'); }

function render() {
  clearInterval(pollTimer);
  const hash = location.hash.replace('#', '') || '';
  if (hash.startsWith('admin')) return renderAdminArea(hash);
  if (!isLoggedIn()) return renderLogin();
  renderShell(hash || 'conversas');
}
window.addEventListener('hashchange', render);

function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(s => s[0].toUpperCase()).join('');
}
function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function fmtTime(d) {
  return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- LOGIN (cliente) ----------
function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <div class="login-logo">ConversIA</div>
        <div class="sub">Gerencie seu atendimento via WhatsApp</div>
        <div id="login-error" class="error" style="display:none"></div>
        <input id="email" type="email" placeholder="E-mail" />
        <input id="password" type="password" placeholder="Senha" />
        <button id="login-btn" style="width:100%">Entrar</button>
        <div class="admin-toggle"><button class="link-btn" id="go-admin">Acesso do administrador</button></div>
      </div>
    </div>`;
  document.getElementById('go-admin').onclick = () => { location.hash = 'admin-login'; };
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

// ---------- SHELL (cliente) ----------
function renderShell(page) {
  const client = JSON.parse(localStorage.getItem('client') || '{}');
  app.innerHTML = `
    <div class="shell">
      <div class="sidebar">
        <div class="brand">ConversIA</div>
        <div class="brand-sub">${escapeHtml(client.nome_empresa || '')}</div>
        <a data-page="conversas" class="${page === 'conversas' ? 'active' : ''}"><span class="ic">💬</span>Conversas</a>
        <a data-page="leads" class="${page === 'leads' ? 'active' : ''}"><span class="ic">🗂️</span>Leads</a>
        <a data-page="dashboard" class="${page === 'dashboard' ? 'active' : ''}"><span class="ic">📊</span>Dashboard</a>
        <a data-page="agente" class="${page === 'agente' ? 'active' : ''}"><span class="ic">🤖</span>Agente</a>
        <div class="spacer"></div>
        <a id="logout"><span class="ic">🚪</span>Sair</a>
      </div>
      <div class="main" id="main"></div>
    </div>`;
  app.querySelectorAll('.sidebar a[data-page]').forEach(a => {
    a.onclick = () => { location.hash = a.dataset.page; };
  });
  document.getElementById('logout').onclick = () => { localStorage.clear(); location.hash = ''; render(); };

  if (page === 'conversas') renderConversas();
  else if (page === 'leads') renderLeads();
  else if (page === 'dashboard') renderDashboard();
  else if (page === 'agente') renderAgente();
}

// ---------- CONVERSAS ----------
let activePhone = null;

async function renderConversas() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="convo-layout">
      <div class="convo-list">
        <div class="convo-search"><input id="convo-search" placeholder="Buscar conversa..." /></div>
        <div id="convo-items">Carregando...</div>
      </div>
      <div class="chat" id="chat">
        <div class="empty-state">Selecione uma conversa</div>
      </div>
    </div>`;
  let allConvos = [];
  document.getElementById('convo-search').oninput = debounce(() => renderConvoItems(allConvos), 250);

  await loadConvoList();
  pollTimer = setInterval(async () => {
    await loadConvoList();
    if (activePhone) await loadChat(activePhone, true);
  }, 5000);

  async function loadConvoList() {
    allConvos = await api.request('/conversations');
    renderConvoItems(allConvos);
  }
}

function renderConvoItems(convos) {
  const box = document.getElementById('convo-items');
  if (!box) return;
  const q = (document.getElementById('convo-search')?.value || '').toLowerCase();
  const filtered = convos.filter(c => !q || (c.contact_name || '').toLowerCase().includes(q) || (c.phone || '').includes(q));
  box.innerHTML = filtered.map(c => `
    <div class="convo-item ${c.phone === activePhone ? 'active' : ''}" data-phone="${c.phone}">
      <div class="avatar">${initials(c.contact_name || c.phone)}</div>
      <div class="meta">
        <div class="name">${escapeHtml(c.contact_name || c.phone)}</div>
        <div class="preview">${(c.direction === 'outbound' ? 'Você: ' : '') + escapeHtml(c.content || '')}</div>
      </div>
    </div>`).join('') || '<div style="padding:16px;color:var(--muted)">Nenhuma conversa encontrada</div>';
  box.querySelectorAll('.convo-item').forEach(el => {
    el.onclick = () => { activePhone = el.dataset.phone; loadChat(activePhone); renderConvoItems(convos); };
  });
}

async function loadChat(phone, silent) {
  const chat = document.getElementById('chat');
  if (!chat) return;
  const msgs = await api.request('/conversations/' + encodeURIComponent(phone));
  chat.innerHTML = `
    <div class="chat-header">${escapeHtml(phone)}</div>
    <div class="chat-msgs" id="chat-msgs">
      ${msgs.map(m => `
        <div class="bubble ${m.direction === 'inbound' ? 'in' : 'out'}">
          ${escapeHtml(m.content || '')}
          <div class="bubble-time">${fmtTime(m.created_at)}</div>
        </div>`).join('') || '<div class="empty-state">Sem mensagens ainda</div>'}
    </div>
    <div class="chat-input">
      <textarea id="msg-input" placeholder="Digite uma mensagem manual..."></textarea>
      <button id="send-btn">Enviar</button>
    </div>`;
  const msgsBox = document.getElementById('chat-msgs');
  msgsBox.scrollTop = msgsBox.scrollHeight;
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

// ---------- LEADS ----------
async function renderLeads() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Leads</div>
    <div class="page-sub">Contatos capturados pelo agente</div>
    <div class="filters">
      <input id="q" placeholder="Buscar por nome ou telefone" />
      <select id="status-filter">
        <option value="">Todos os status</option>
        <option value="ativo">Ativo</option>
        <option value="aguardando_humano">Aguardando humano</option>
        <option value="fechado">Fechado</option>
      </select>
    </div>
    <div class="panel-box">
      <table>
        <thead><tr><th>Nome</th><th>Telefone</th><th>Email</th><th>Urgente</th><th>Status</th><th></th></tr></thead>
        <tbody id="leads-body"><tr><td colspan="6">Carregando...</td></tr></tbody>
      </table>
    </div>`;

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
        <td>${escapeHtml(l.name) || '-'}</td>
        <td>${escapeHtml(l.phone)}</td>
        <td>${escapeHtml(l.email) || '-'}</td>
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
    <div class="page-title">Dashboard</div>
    <div class="page-sub">Visão geral do atendimento nos últimos 30 dias</div>
    <div class="cards">
      <div class="card"><div class="label">Leads (30 dias)</div><div class="value">${m.leads_30_dias ?? '-'}</div></div>
      <div class="card"><div class="label">Ativos</div><div class="value">${porStatus.ativo || 0}</div></div>
      <div class="card"><div class="label">Aguardando humano</div><div class="value">${porStatus.aguardando_humano || 0}</div></div>
      <div class="card"><div class="label">Fechados</div><div class="value">${porStatus.fechado || 0}</div></div>
      <div class="card"><div class="label">Tempo médio 1ª resposta</div><div class="value">${tempoMin}</div></div>
    </div>`;
}

// ---------- AGENTE (config do cliente) ----------
async function renderAgente() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  const a = await api.request('/agent');
  main.innerHTML = `
    <div class="page-title">Configuração do agente</div>
    <div class="page-sub">Ajuste como o ConversIA responde no WhatsApp da sua empresa</div>
    <div class="form-card">
      <label>Nome da empresa</label>
      <input id="ag-nome" value="${escapeHtml(a.nome_empresa || '')}" />
      <label>Nicho / ramo de atuação</label>
      <input id="ag-nicho" value="${escapeHtml(a.nicho || '')}" />
      <label>Prompt do agente (instruções de como ele deve atender)</label>
      <textarea id="ag-prompt">${escapeHtml(a.system_prompt || '')}</textarea>
      <div class="toggle-row">
        <div class="switch ${a.active ? 'on' : ''}" id="ag-toggle"><div class="knob"></div></div>
        <span id="ag-toggle-label">${a.active ? 'Agente ativo' : 'Agente pausado'}</span>
      </div>
      <div class="save-row">
        <button id="ag-save">Salvar alterações</button>
        <span class="saved-msg" id="ag-saved" style="display:none">Salvo com sucesso ✓</span>
      </div>
    </div>`;

  let active = !!a.active;
  const toggle = document.getElementById('ag-toggle');
  toggle.onclick = () => {
    active = !active;
    toggle.classList.toggle('on', active);
    document.getElementById('ag-toggle-label').textContent = active ? 'Agente ativo' : 'Agente pausado';
  };

  document.getElementById('ag-save').onclick = async () => {
    await api.request('/agent', {
      method: 'PUT',
      body: {
        nome_empresa: document.getElementById('ag-nome').value,
        nicho: document.getElementById('ag-nicho').value,
        system_prompt: document.getElementById('ag-prompt').value,
        active
      }
    });
    const client = JSON.parse(localStorage.getItem('client') || '{}');
    client.nome_empresa = document.getElementById('ag-nome').value;
    localStorage.setItem('client', JSON.stringify(client));
    const saved = document.getElementById('ag-saved');
    saved.style.display = 'inline';
    setTimeout(() => (saved.style.display = 'none'), 2500);
  };
}

// =====================================================
// ÁREA ADMIN (dono da ConversIA)
// =====================================================
function isAdminLoggedIn() { return !!localStorage.getItem('adminToken'); }

async function adminRequest(path, opts = {}) {
  const token = localStorage.getItem('adminToken');
  const res = await fetch('/api/admin' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('adminToken');
    location.hash = 'admin-login';
    render();
    throw new Error('Sessão de admin expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

function renderAdminArea(hash) {
  if (!isAdminLoggedIn()) return renderAdminLogin();
  if (hash.startsWith('admin-client-')) return renderAdminShell('client', hash.replace('admin-client-', ''));
  return renderAdminShell(hash === 'admin' ? 'clients' : hash.replace('admin-', ''));
}

function renderAdminLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <div class="login-logo">ConversIA</div>
        <div class="sub">Painel administrativo</div>
        <div id="login-error" class="error" style="display:none"></div>
        <input id="ausername" placeholder="Usuário" />
        <input id="apassword" type="password" placeholder="Senha" />
        <button id="alogin-btn" style="width:100%">Entrar como admin</button>
        <div class="admin-toggle"><button class="link-btn" id="back-client">Voltar ao login do cliente</button></div>
      </div>
    </div>`;
  document.getElementById('back-client').onclick = () => { location.hash = ''; render(); };
  document.getElementById('alogin-btn').onclick = async () => {
    const username = document.getElementById('ausername').value.trim();
    const password = document.getElementById('apassword').value;
    const errBox = document.getElementById('login-error');
    errBox.style.display = 'none';
    try {
      const data = await adminRequestLogin(username, password);
      localStorage.setItem('adminToken', data.token);
      location.hash = 'admin';
      render();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.style.display = 'block';
    }
  };
}

async function adminRequestLogin(username, password) {
  const res = await fetch('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro no login');
  return data;
}

function renderAdminShell(page, param) {
  app.innerHTML = `
    <div class="shell">
      <div class="sidebar">
        <div class="brand">ConversIA<span class="admin-badge">ADMIN</span></div>
        <div class="brand-sub">Painel do administrador</div>
        <a data-page="admin" class="${page === 'clients' ? 'active' : ''}"><span class="ic">🏢</span>Clientes</a>
        <a data-page="admin-overview" class="${page === 'overview' ? 'active' : ''}"><span class="ic">📈</span>Visão geral</a>
        <div class="spacer"></div>
        <a id="logout"><span class="ic">🚪</span>Sair</a>
      </div>
      <div class="main" id="main"></div>
    </div>`;
  app.querySelectorAll('.sidebar a[data-page]').forEach(a => {
    a.onclick = () => { location.hash = a.dataset.page; };
  });
  document.getElementById('logout').onclick = () => { localStorage.removeItem('adminToken'); location.hash = ''; render(); };

  if (page === 'clients') renderAdminClients();
  else if (page === 'overview') renderAdminOverview();
  else if (page === 'client') renderAdminClientEdit(param);
}

async function renderAdminClients() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Clientes da ConversIA</div>
    <div class="page-sub">Gerencie o agente de cada empresa</div>
    <div class="client-list" id="client-list">Carregando...</div>`;
  const clients = await adminRequest('/clients');
  const list = document.getElementById('client-list');
  list.innerHTML = clients.map(c => `
    <div class="client-row" data-id="${c.client_id}">
      <div class="avatar">${initials(c.nome_empresa || c.client_id)}</div>
      <div class="info">
        <div class="n">${escapeHtml(c.nome_empresa || c.client_id)}</div>
        <div class="s">${escapeHtml(c.nicho || '-')} · ${c.active ? 'Ativo' : 'Pausado'}</div>
      </div>
      <div class="stats">
        <div><b>${c.total_leads}</b>leads</div>
        <div><b>${c.total_mensagens}</b>mensagens</div>
      </div>
    </div>`).join('') || '<div style="color:var(--muted)">Nenhum cliente cadastrado</div>';
  list.querySelectorAll('.client-row').forEach(row => {
    row.onclick = () => { location.hash = 'admin-client-' + row.dataset.id; };
  });
}

async function renderAdminOverview() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  const o = await adminRequest('/overview');
  main.innerHTML = `
    <div class="page-title">Visão geral</div>
    <div class="page-sub">Números de toda a plataforma</div>
    <div class="cards">
      <div class="card"><div class="label">Clientes totais</div><div class="value">${o.clientes_total}</div></div>
      <div class="card"><div class="label">Clientes ativos</div><div class="value">${o.clientes_ativos}</div></div>
      <div class="card"><div class="label">Leads (30 dias)</div><div class="value">${o.leads_30_dias ?? '-'}</div></div>
      <div class="card"><div class="label">Mensagens (30 dias)</div><div class="value">${o.mensagens_30_dias}</div></div>
    </div>`;
}

async function renderAdminClientEdit(clientId) {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  const c = await adminRequest('/clients/' + encodeURIComponent(clientId));
  main.innerHTML = `
    <div class="page-title">${escapeHtml(c.nome_empresa || c.client_id)}</div>
    <div class="page-sub">ID: ${escapeHtml(c.client_id)}</div>
    <div class="form-card">
      <label>Nome da empresa</label>
      <input id="c-nome" value="${escapeHtml(c.nome_empresa || '')}" />
      <label>Nicho</label>
      <input id="c-nicho" value="${escapeHtml(c.nicho || '')}" />
      <label>Instância Evolution API</label>
      <input id="c-instance" value="${escapeHtml(c.evolution_instance || '')}" />
      <label>Prompt do agente</label>
      <textarea id="c-prompt">${escapeHtml(c.system_prompt || '')}</textarea>
      <div class="toggle-row">
        <div class="switch ${c.active ? 'on' : ''}" id="c-toggle"><div class="knob"></div></div>
        <span id="c-toggle-label">${c.active ? 'Agente ativo' : 'Agente pausado'}</span>
      </div>
      <div class="save-row">
        <button id="c-save">Salvar alterações</button>
        <button class="ghost" id="c-back">Voltar</button>
        <span class="saved-msg" id="c-saved" style="display:none">Salvo com sucesso ✓</span>
      </div>
    </div>`;

  let active = !!c.active;
  const toggle = document.getElementById('c-toggle');
  toggle.onclick = () => {
    active = !active;
    toggle.classList.toggle('on', active);
    document.getElementById('c-toggle-label').textContent = active ? 'Agente ativo' : 'Agente pausado';
  };
  document.getElementById('c-back').onclick = () => { location.hash = 'admin'; };
  document.getElementById('c-save').onclick = async () => {
    await adminRequest('/clients/' + encodeURIComponent(clientId), {
      method: 'PUT',
      body: {
        nome_empresa: document.getElementById('c-nome').value,
        nicho: document.getElementById('c-nicho').value,
        evolution_instance: document.getElementById('c-instance').value,
        system_prompt: document.getElementById('c-prompt').value,
        active
      }
    });
    const saved = document.getElementById('c-saved');
    saved.style.display = 'inline';
    setTimeout(() => (saved.style.display = 'none'), 2500);
  };
}

render();
