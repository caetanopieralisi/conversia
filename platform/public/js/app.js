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
        <a data-page="simulador" class="${page === 'simulador' ? 'active' : ''}"><span class="ic">🧪</span>Testar agente</a>
        <a data-page="respostas" class="${page === 'respostas' ? 'active' : ''}"><span class="ic">⚡</span>Respostas rápidas</a>
        <a data-page="equipe" class="${page === 'equipe' ? 'active' : ''}"><span class="ic">👥</span>Equipe</a>
        <a data-page="alertas" class="${page === 'alertas' ? 'active' : ''}"><span class="ic">🔔</span>Alertas</a>
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
  else if (page === 'simulador') renderSimulador();
  else if (page === 'respostas') renderRespostas();
  else if (page === 'equipe') renderEquipe();
  else if (page === 'alertas') renderAlertas();
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
    if (activePhone) await loadChat(activePhone, true).catch(() => {});
  }, 5000);

  async function loadConvoList() {
    try {
      allConvos = await api.request('/conversations');
      renderConvoItems(allConvos);
    } catch (e) {
      document.getElementById('convo-items').innerHTML = `<div style="padding:16px;color:var(--red);font-size:13px">Erro ao carregar conversas: ${escapeHtml(e.message)}</div>`;
    }
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
        <div class="name">${escapeHtml(c.contact_name || c.phone)} ${c.lead_status === 'aguardando_humano' ? '<span class="badge aguardando_humano" style="margin-left:6px">humano</span>' : ''} ${c.paused ? '<span class="badge fechado" style="margin-left:6px">pausado</span>' : ''}</div>
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
  let msgs, pauseState, quickReplies;
  try {
    [msgs, pauseState, quickReplies] = await Promise.all([
      api.request('/conversations/' + encodeURIComponent(phone)),
      api.request('/conversations/' + encodeURIComponent(phone) + '/pause').catch(() => ({ paused: false })),
      api.request('/quick-replies').catch(() => [])
    ]);
  } catch (e) {
    chat.innerHTML = `<div class="empty-state" style="color:var(--red)">Erro ao carregar conversa: ${escapeHtml(e.message)}</div>`;
    return;
  }
  chat.innerHTML = `
    <div class="chat-header" style="display:flex;justify-content:space-between;align-items:center">
      <span>${escapeHtml(phone)}</span>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer">
        <span>Bot pausado nesta conversa</span>
        <div class="switch ${pauseState.paused ? 'on' : ''}" id="pause-toggle"><div class="knob"></div></div>
      </label>
    </div>
    <div class="chat-msgs" id="chat-msgs">
      ${msgs.map(m => `
        <div class="bubble ${m.direction === 'inbound' ? 'in' : 'out'}">
          ${escapeHtml(m.content || '')}
          <div class="bubble-time">${fmtTime(m.created_at)}</div>
        </div>`).join('') || '<div class="empty-state">Sem mensagens ainda</div>'}
    </div>
    ${quickReplies.length ? `<div style="display:flex;gap:6px;padding:0 14px;overflow-x:auto">${quickReplies.map(q => `<button class="ghost" style="white-space:nowrap;font-size:12px;padding:6px 10px" data-qr="${q.id}">${escapeHtml(q.title)}</button>`).join('')}</div>` : ''}
    <div class="chat-input">
      <button class="ghost" id="attach-btn" title="Enviar imagem por link">📎</button>
      <textarea id="msg-input" placeholder="Digite uma mensagem manual..."></textarea>
      <button id="send-btn">Enviar</button>
    </div>`;
  const msgsBox = document.getElementById('chat-msgs');
  msgsBox.scrollTop = msgsBox.scrollHeight;

  document.getElementById('pause-toggle').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    await api.request('/conversations/' + encodeURIComponent(phone) + '/pause', { method: 'PUT', body: { paused: on } });
    e.currentTarget.classList.toggle('on', on);
  };

  chat.querySelectorAll('[data-qr]').forEach(btn => {
    btn.onclick = () => {
      const qr = quickReplies.find(q => String(q.id) === btn.dataset.qr);
      if (qr) document.getElementById('msg-input').value = qr.content;
    };
  });

  document.getElementById('attach-btn').onclick = async () => {
    const url = prompt('Cole a URL da imagem:');
    if (!url) return;
    const caption = prompt('Legenda (opcional):') || '';
    try {
      await api.request('/conversations/' + encodeURIComponent(phone) + '/send-media', { method: 'POST', body: { url, caption } });
      await loadChat(phone);
    } catch (e) {
      alert('Erro ao enviar imagem: ' + e.message);
    }
  };

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
      <button class="ghost" type="button" id="export-csv" style="margin-left:auto">Exportar CSV</button>
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
    try {
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
    } catch (e) {
      document.getElementById('leads-body').innerHTML = `<tr><td colspan="6" style="color:var(--red)">Erro ao carregar: ${escapeHtml(e.message)}</td></tr>`;
    }
  }
  document.getElementById('q').oninput = debounce(load, 400);
  document.getElementById('status-filter').onchange = load;
  document.getElementById('export-csv').onclick = async () => {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/leads/export.csv', { headers: { Authorization: 'Bearer ' + token } });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'leads.csv'; a.click();
    URL.revokeObjectURL(url);
  };
  await load();
}

// ---------- DASHBOARD ----------
async function renderDashboard() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  try {
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
  } catch (e) {
    main.innerHTML = `<div style="color:var(--red)">Erro ao carregar dashboard: ${escapeHtml(e.message)}</div>`;
  }
}

// ---------- AGENTE (config do cliente) ----------
async function renderAgente() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  let a;
  try {
    a = await api.request('/agent');
  } catch (e) {
    main.innerHTML = `<div style="color:var(--red)">Erro ao carregar agente: ${escapeHtml(e.message)}</div>`;
    return;
  }
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

// ---------- SIMULADOR ----------
async function renderSimulador() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Testar agente</div>
    <div class="page-sub">Converse com o agente usando o prompt atual, sem passar pelo WhatsApp</div>
    <div class="convo-layout" style="max-width:640px">
      <div class="chat">
        <div class="chat-msgs" id="sim-msgs"><div class="empty-state">Envie uma mensagem para começar o teste</div></div>
        <div class="chat-input">
          <textarea id="sim-input" placeholder="Digite como se fosse o cliente..."></textarea>
          <button id="sim-send">Enviar</button>
        </div>
      </div>
    </div>`;
  const history = [];
  const msgsBox = document.getElementById('sim-msgs');
  document.getElementById('sim-send').onclick = async () => {
    const input = document.getElementById('sim-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (msgsBox.querySelector('.empty-state')) msgsBox.innerHTML = '';
    msgsBox.insertAdjacentHTML('beforeend', `<div class="bubble out">${escapeHtml(text)}</div>`);
    history.push({ role: 'user', content: text });
    msgsBox.scrollTop = msgsBox.scrollHeight;
    try {
      const { reply } = await api.request('/simulate', { method: 'POST', body: { message: text, history: history.slice(0, -1) } });
      history.push({ role: 'assistant', content: reply });
      msgsBox.insertAdjacentHTML('beforeend', `<div class="bubble in">${escapeHtml(reply)}</div>`);
    } catch (e) {
      msgsBox.insertAdjacentHTML('beforeend', `<div class="bubble in" style="color:var(--red)">${escapeHtml(e.message)}</div>`);
    }
    msgsBox.scrollTop = msgsBox.scrollHeight;
  };
}

// ---------- RESPOSTAS RÁPIDAS ----------
async function renderRespostas() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Respostas rápidas</div>
    <div class="page-sub">Mensagens prontas pra usar no chat manual</div>
    <div class="form-card" style="margin-bottom:20px">
      <label>Título</label>
      <input id="qr-title" placeholder="Ex: Horário de funcionamento" />
      <label>Conteúdo</label>
      <textarea id="qr-content" placeholder="Ex: Funcionamos de seg a sex, das 9h às 18h."></textarea>
      <div class="save-row"><button id="qr-add">Adicionar</button></div>
    </div>
    <div id="qr-list">Carregando...</div>`;
  async function load() {
    try {
      const list = await api.request('/quick-replies');
      document.getElementById('qr-list').innerHTML = list.map(q => `
        <div class="client-row">
          <div class="info"><div class="n">${escapeHtml(q.title)}</div><div class="s">${escapeHtml(q.content)}</div></div>
          <button class="danger" data-id="${q.id}">Excluir</button>
        </div>`).join('') || '<div style="color:var(--muted)">Nenhuma resposta rápida cadastrada</div>';
      document.querySelectorAll('#qr-list button[data-id]').forEach(b => {
        b.onclick = async () => { await api.request('/quick-replies/' + b.dataset.id, { method: 'DELETE' }); load(); };
      });
    } catch (e) {
      document.getElementById('qr-list').innerHTML = `<div style="color:var(--red);font-size:13px">Erro ao carregar: ${escapeHtml(e.message)}. Confira se rodou o schema_platform_v2.sql no banco.</div>`;
    }
  }
  document.getElementById('qr-add').onclick = async () => {
    const title = document.getElementById('qr-title').value.trim();
    const content = document.getElementById('qr-content').value.trim();
    if (!title || !content) return;
    await api.request('/quick-replies', { method: 'POST', body: { title, content } });
    document.getElementById('qr-title').value = '';
    document.getElementById('qr-content').value = '';
    load();
  };
  await load();
}

// ---------- EQUIPE ----------
async function renderEquipe() {
  const main = document.getElementById('main');
  const me = JSON.parse(localStorage.getItem('user') || '{}');
  main.innerHTML = `
    <div class="page-title">Equipe</div>
    <div class="page-sub">Pessoas com acesso a esta conta</div>
    ${me.role === 'owner' ? `
    <div class="form-card" style="margin-bottom:20px">
      <label>E-mail do novo atendente</label>
      <input id="team-email" placeholder="nome@empresa.com" />
      <label>Nome</label>
      <input id="team-name" placeholder="Nome completo" />
      <div class="save-row"><button id="team-add">Convidar</button></div>
      <div id="team-result" style="margin-top:10px;font-size:13px"></div>
    </div>` : ''}
    <div id="team-list">Carregando...</div>`;

  async function load() {
    try {
      const list = await api.request('/team');
      document.getElementById('team-list').innerHTML = list.map(u => `
        <div class="client-row">
          <div class="avatar">${initials(u.name || u.email)}</div>
          <div class="info"><div class="n">${escapeHtml(u.name || u.email)}</div><div class="s">${escapeHtml(u.email)} · ${u.role === 'owner' ? 'Dono' : 'Atendente'}</div></div>
          ${me.role === 'owner' && u.role !== 'owner' ? `<button class="danger" data-id="${u.id}">Remover</button>` : ''}
        </div>`).join('');
      document.querySelectorAll('#team-list button[data-id]').forEach(b => {
        b.onclick = async () => { await api.request('/team/' + b.dataset.id, { method: 'DELETE' }); load(); };
      });
    } catch (e) {
      document.getElementById('team-list').innerHTML = `<div style="color:var(--red);font-size:13px">Erro ao carregar equipe: ${escapeHtml(e.message)}</div>`;
    }
  }
  const addBtn = document.getElementById('team-add');
  if (addBtn) addBtn.onclick = async () => {
    const email = document.getElementById('team-email').value.trim();
    const name = document.getElementById('team-name').value.trim();
    if (!email) return;
    try {
      const data = await api.request('/team', { method: 'POST', body: { email, name } });
      document.getElementById('team-result').innerHTML = `Usuário criado! Senha temporária: <b>${data.temp_password}</b> (repasse com segurança)`;
      document.getElementById('team-email').value = '';
      document.getElementById('team-name').value = '';
      load();
    } catch (e) {
      document.getElementById('team-result').innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
    }
  };
  await load();
}

// ---------- ALERTAS ----------
async function renderAlertas() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Alertas do agente</div>
    <div class="page-sub">Falhas ou avisos reportados pelo fluxo de atendimento</div>
    <div id="alerts-list">Carregando...</div>`;
  try {
    const list = await api.request('/alerts');
    document.getElementById('alerts-list').innerHTML = list.map(a => `
    <div class="client-row">
      <div class="info">
        <div class="n">${escapeHtml(a.message)}</div>
        <div class="s">${fmtTime(a.created_at)} · <span class="badge ${a.level === 'error' ? 'fechado' : 'aguardando_humano'}">${a.level}</span> ${a.resolved ? '· resolvido' : ''}</div>
      </div>
      ${!a.resolved ? `<button class="ghost" data-id="${a.id}">Marcar resolvido</button>` : ''}
    </div>`).join('') || '<div style="color:var(--muted)">Nenhum alerta registrado 🎉</div>';
    document.querySelectorAll('#alerts-list button[data-id]').forEach(b => {
      b.onclick = async () => { await api.request('/alerts/' + b.dataset.id + '/resolve', { method: 'PATCH' }); renderAlertas(); };
    });
  } catch (e) {
    document.getElementById('alerts-list').innerHTML = `<div style="color:var(--red);font-size:13px">Erro ao carregar alertas: ${escapeHtml(e.message)}</div>`;
  }
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
        <a data-page="admin-novocliente" class="${page === 'novocliente' ? 'active' : ''}"><span class="ic">➕</span>Novo cliente</a>
        <a data-page="admin-overview" class="${page === 'overview' ? 'active' : ''}"><span class="ic">📈</span>Visão geral</a>
        <a data-page="admin-config" class="${page === 'config' ? 'active' : ''}"><span class="ic">⚙️</span>Configurações</a>
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
  else if (page === 'novocliente') renderAdminNovoCliente();
  else if (page === 'config') renderAdminConfig();
}

async function renderAdminClients() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Clientes da ConversIA</div>
    <div class="page-sub">Gerencie o agente de cada empresa</div>
    <div class="client-list" id="client-list">Carregando...</div>`;
  try {
    const clients = await adminRequest('/clients');
    const list = document.getElementById('client-list');
    list.innerHTML = clients.map(c => `
      <div class="client-row" data-id="${c.client_id}">
        <div class="avatar">${initials(c.nome_empresa || c.client_id)}</div>
        <div class="info">
          <div class="n">${escapeHtml(c.nome_empresa || c.client_id)} ${c.alertas_abertos > 0 ? `<span class="badge fechado" style="margin-left:6px">${c.alertas_abertos} alerta(s)</span>` : ''}</div>
          <div class="s">${escapeHtml(c.nicho || '-')} · ${c.active ? 'Ativo' : 'Pausado'} · plano: ${escapeHtml(c.plan || 'trial')}</div>
        </div>
        <div class="stats">
          <div><b>${c.total_leads}</b>leads</div>
          <div><b>${c.total_mensagens}</b>mensagens</div>
        </div>
      </div>`).join('') || '<div style="color:var(--muted)">Nenhum cliente cadastrado</div>';
    list.querySelectorAll('.client-row').forEach(row => {
      row.onclick = () => { location.hash = 'admin-client-' + row.dataset.id; };
    });
  } catch (e) {
    document.getElementById('client-list').innerHTML = `<div style="color:var(--red);font-size:13px">Erro ao carregar clientes: ${escapeHtml(e.message)}</div>`;
  }
}

async function renderAdminOverview() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  try {
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
  } catch (e) {
    main.innerHTML = `<div style="color:var(--red)">Erro ao carregar visão geral: ${escapeHtml(e.message)}</div>`;
  }
}

async function renderAdminClientEdit(clientId) {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  let c, alerts, weekly;
  try {
    [c, alerts, weekly] = await Promise.all([
      adminRequest('/clients/' + encodeURIComponent(clientId)),
      adminRequest('/clients/' + encodeURIComponent(clientId) + '/alerts'),
      adminRequest('/clients/' + encodeURIComponent(clientId) + '/weekly')
    ]);
  } catch (e) {
    main.innerHTML = `<div style="color:var(--red)">Erro ao carregar cliente: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const maxWeek = Math.max(1, ...weekly.map(w => w.total));
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
      <label>Plano</label>
      <select id="c-plan">
        <option value="trial" ${c.plan === 'trial' ? 'selected' : ''}>Trial</option>
        <option value="pago" ${c.plan === 'pago' ? 'selected' : ''}>Pago</option>
        <option value="inadimplente" ${c.plan === 'inadimplente' ? 'selected' : ''}>Inadimplente</option>
      </select>
      <label>Prompt do agente</label>
      <textarea id="c-prompt">${escapeHtml(c.system_prompt || '')}</textarea>
      <div class="toggle-row">
        <div class="switch ${c.active ? 'on' : ''}" id="c-toggle"><div class="knob"></div></div>
        <span id="c-toggle-label">${c.active ? 'Agente ativo' : 'Agente pausado'}</span>
      </div>
      <div class="save-row">
        <button id="c-save">Salvar alterações</button>
        <button class="ghost" id="c-impersonate">Entrar como este cliente</button>
        <button class="ghost" id="c-back">Voltar</button>
        <span class="saved-msg" id="c-saved" style="display:none">Salvo com sucesso ✓</span>
      </div>
    </div>

    <div class="page-title" style="margin-top:28px;font-size:16px">Mensagens por semana</div>
    <div class="panel-box" style="padding:16px;display:flex;align-items:flex-end;gap:8px;height:120px">
      ${weekly.map(w => `<div style="flex:1;background:var(--gradient);border-radius:4px;height:${Math.max(4, (w.total / maxWeek) * 90)}px" title="${w.total} mensagens"></div>`).join('') || '<span style="color:var(--muted)">Sem dados ainda</span>'}
    </div>

    <div class="page-title" style="margin-top:28px;font-size:16px">Alertas recentes</div>
    <div>
      ${alerts.map(a => `
        <div class="client-row">
          <div class="info"><div class="n">${escapeHtml(a.message)}</div><div class="s">${fmtTime(a.created_at)} · ${a.level} ${a.resolved ? '· resolvido' : ''}</div></div>
        </div>`).join('') || '<div style="color:var(--muted)">Nenhum alerta</div>'}
    </div>`;

  let active = !!c.active;
  const toggle = document.getElementById('c-toggle');
  toggle.onclick = () => {
    active = !active;
    toggle.classList.toggle('on', active);
    document.getElementById('c-toggle-label').textContent = active ? 'Agente ativo' : 'Agente pausado';
  };
  document.getElementById('c-back').onclick = () => { location.hash = 'admin'; };
  document.getElementById('c-impersonate').onclick = async () => {
    const data = await adminRequest('/clients/' + encodeURIComponent(clientId) + '/impersonate', { method: 'POST' });
    localStorage.setItem('token', data.token);
    localStorage.setItem('client', JSON.stringify(data.client || {}));
    localStorage.setItem('user', JSON.stringify(data.user || {}));
    location.hash = 'conversas';
    render();
  };
  document.getElementById('c-save').onclick = async () => {
    await adminRequest('/clients/' + encodeURIComponent(clientId), {
      method: 'PUT',
      body: {
        nome_empresa: document.getElementById('c-nome').value,
        nicho: document.getElementById('c-nicho').value,
        evolution_instance: document.getElementById('c-instance').value,
        system_prompt: document.getElementById('c-prompt').value,
        plan: document.getElementById('c-plan').value,
        active
      }
    });
    const saved = document.getElementById('c-saved');
    saved.style.display = 'inline';
    setTimeout(() => (saved.style.display = 'none'), 2500);
  };
}

// ---------- ADMIN: novo cliente ----------
async function renderAdminNovoCliente() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Novo cliente</div>
    <div class="page-sub">Cadastra a empresa e o primeiro usuário (dono) dela</div>
    <div class="form-card">
      <label>ID do cliente (usado no n8n/Evolution, sem espaços)</label>
      <input id="n-id" placeholder="ex: pizzaria-do-joao" />
      <label>Nome da empresa</label>
      <input id="n-nome" placeholder="Pizzaria do João" />
      <label>Nicho</label>
      <input id="n-nicho" placeholder="Alimentação" />
      <label>Instância Evolution API</label>
      <input id="n-instance" placeholder="pizzaria-do-joao" />
      <label>Plano</label>
      <select id="n-plan">
        <option value="trial">Trial</option>
        <option value="pago">Pago</option>
      </select>
      <label>E-mail do dono (login da plataforma)</label>
      <input id="n-email" placeholder="dono@pizzaria.com" />
      <div class="save-row"><button id="n-save">Criar cliente</button></div>
      <div id="n-result" style="margin-top:12px;font-size:13px"></div>
    </div>`;
  document.getElementById('n-save').onclick = async () => {
    const body = {
      client_id: document.getElementById('n-id').value.trim(),
      nome_empresa: document.getElementById('n-nome').value.trim(),
      nicho: document.getElementById('n-nicho').value.trim(),
      evolution_instance: document.getElementById('n-instance').value.trim(),
      plan: document.getElementById('n-plan').value,
      owner_email: document.getElementById('n-email').value.trim()
    };
    const resultBox = document.getElementById('n-result');
    try {
      const data = await adminRequest('/clients', { method: 'POST', body });
      resultBox.innerHTML = `Cliente criado! Login: <b>${data.owner_email}</b> · Senha temporária: <b>${data.temp_password}</b>`;
      resultBox.style.color = 'var(--green)';
    } catch (e) {
      resultBox.textContent = e.message;
      resultBox.style.color = 'var(--red)';
    }
  };
}

// ---------- ADMIN: configurações globais ----------
async function renderAdminConfig() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  let settings;
  try {
    settings = await adminRequest('/settings');
  } catch (e) {
    main.innerHTML = `<div style="color:var(--red)">Erro ao carregar configurações: ${escapeHtml(e.message)}</div>`;
    return;
  }
  main.innerHTML = `
    <div class="page-title">Configurações da plataforma</div>
    <div class="page-sub">Valores padrão usados ao criar novos clientes</div>
    <div class="form-card">
      <label>Prompt padrão para novos agentes</label>
      <textarea id="s-prompt">${escapeHtml(settings.default_prompt || '')}</textarea>
      <div class="save-row"><button id="s-save">Salvar</button><span class="saved-msg" id="s-saved" style="display:none">Salvo ✓</span></div>
    </div>`;
  document.getElementById('s-save').onclick = async () => {
    await adminRequest('/settings', { method: 'PUT', body: { default_prompt: document.getElementById('s-prompt').value } });
    const saved = document.getElementById('s-saved');
    saved.style.display = 'inline';
    setTimeout(() => (saved.style.display = 'none'), 2000);
  };
}

render();
