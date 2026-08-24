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
    if (!res.ok) throw new Error(data.error ? (data.error + (data.detail ? ' — ' + data.detail : '')) : 'Erro na requisição');
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
        <a data-page="radar" class="${page === 'radar' ? 'active' : ''}"><span class="ic">📡</span>Radar</a>
        <a data-page="dashboard" class="${page === 'dashboard' ? 'active' : ''}"><span class="ic">📊</span>Dashboard</a>
        <a data-page="agente" class="${page === 'agente' ? 'active' : ''}"><span class="ic">🤖</span>Agente</a>
        <a data-page="followup" class="${page === 'followup' ? 'active' : ''}"><span class="ic">⏱️</span>Follow-up</a>
        <a data-page="conhecimento" class="${page === 'conhecimento' ? 'active' : ''}"><span class="ic">📚</span>Base de conhecimento</a>
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
  else if (page === 'radar') renderRadar();
  else if (page === 'dashboard') renderDashboard();
  else if (page === 'agente') renderAgente();
  else if (page === 'followup') renderFollowUp();
  else if (page === 'conhecimento') renderKnowledge();
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
  if (activePhone) await loadChat(activePhone).catch(() => {});
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
  let msgs, pauseState, quickReplies, notes;
  try {
    [msgs, pauseState, quickReplies, notes] = await Promise.all([
      api.request('/conversations/' + encodeURIComponent(phone)),
      api.request('/conversations/' + encodeURIComponent(phone) + '/pause').catch(() => ({ paused: false })),
      api.request('/quick-replies').catch(() => []),
      api.request('/lead-notes/' + encodeURIComponent(phone)).catch(() => [])
    ]);
  } catch (e) {
    chat.innerHTML = `<div class="empty-state" style="color:var(--red)">Erro ao carregar conversa: ${escapeHtml(e.message)}</div>`;
    return;
  }
  chat.innerHTML = `
    <div class="chat-header" style="display:flex;justify-content:space-between;align-items:center">
      <span>${escapeHtml(phone)}</span>
      <div style="display:flex;align-items:center;gap:14px">
        <button class="ghost" id="notes-toggle-btn" style="font-size:12px;padding:6px 10px">📝 Notas (${notes.length})</button>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer">
          <span>Bot pausado nesta conversa</span>
          <div class="switch ${pauseState.paused ? 'on' : ''}" id="pause-toggle"><div class="knob"></div></div>
        </label>
      </div>
    </div>
    <div id="notes-panel" style="display:none;background:var(--panel2);border-bottom:1px solid var(--border);padding:12px 18px">
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <input id="note-input" placeholder="Escrever nota interna (a equipe vê, o cliente não)..." style="margin:0" />
        <button id="note-add" style="white-space:nowrap">Adicionar</button>
      </div>
      <div id="notes-items" style="display:flex;flex-direction:column;gap:6px;max-height:160px;overflow-y:auto">
        ${notes.map(n => `
          <div style="background:var(--panel3);border-radius:8px;padding:8px 10px;font-size:13px">
            <div>${escapeHtml(n.note)}</div>
            <div style="color:var(--muted);font-size:11px;margin-top:4px">${escapeHtml(n.author || '')} · ${fmtTime(n.created_at)} <button class="link-btn" data-noteid="${n.id}" style="margin-left:8px;color:var(--red)">excluir</button></div>
          </div>`).join('') || '<div style="color:var(--muted);font-size:12px">Nenhuma nota ainda</div>'}
      </div>
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
      <button class="ghost" id="attach-btn" title="Enviar arquivo">📎</button>
      <input type="file" id="chat-file" style="display:none" />
      <textarea id="msg-input" placeholder="Digite uma mensagem manual..."></textarea>
      <button id="send-btn">Enviar</button>
    </div>`;
  const msgsBox = document.getElementById('chat-msgs');
  msgsBox.scrollTop = msgsBox.scrollHeight;

  document.getElementById('notes-toggle-btn').onclick = () => {
    const panel = document.getElementById('notes-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  };
  document.getElementById('note-add').onclick = async () => {
    const input = document.getElementById('note-input');
    const note = input.value.trim();
    if (!note) return;
    input.value = '';
    try {
      await api.request('/lead-notes/' + encodeURIComponent(phone), { method: 'POST', body: { note } });
      await loadChat(phone);
      document.getElementById('notes-panel').style.display = 'block';
    } catch (e) {
      alert('Erro ao salvar nota: ' + e.message);
    }
  };
  chat.querySelectorAll('[data-noteid]').forEach(b => {
    b.onclick = async () => {
      await api.request('/lead-notes/' + b.dataset.noteid, { method: 'DELETE' });
      await loadChat(phone);
      document.getElementById('notes-panel').style.display = 'block';
    };
  });

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

  document.getElementById('attach-btn').onclick = () => document.getElementById('chat-file').click();
  document.getElementById('chat-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const caption = prompt('Legenda (opcional):') || '';
    try {
      const url = await uploadFile(file);
      await api.request('/conversations/' + encodeURIComponent(phone) + '/send-media', { method: 'POST', body: { url, caption } });
      await loadChat(phone);
    } catch (err) {
      alert('Erro ao enviar arquivo: ' + err.message);
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
        <option value="vendido">Vendido</option>
      </select>
      <button class="ghost" type="button" id="export-csv" style="margin-left:auto">Exportar CSV</button>
    </div>
    <div class="panel-box">
      <table>
        <thead><tr><th>Nome</th><th>Telefone</th><th>Score</th><th>Email</th><th>Status</th><th></th></tr></thead>
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
          <td><span class="badge ${l.score === 'quente' ? 'aguardando_humano' : l.score === 'morno' ? 'ativo' : 'fechado'}">${l.score}</span></td>
          <td>${escapeHtml(l.email) || '-'}</td>
          <td><span class="badge ${l.status}">${l.status}${l.status === 'vendido' && l.sale_value ? ' · ' + fmtMoney(l.sale_value) : ''}</span></td>
          <td>
            <select data-phone="${l.phone}" class="status-select">
              <option value="ativo" ${l.status === 'ativo' ? 'selected' : ''}>Ativo</option>
              <option value="aguardando_humano" ${l.status === 'aguardando_humano' ? 'selected' : ''}>Aguardando humano</option>
              <option value="fechado" ${l.status === 'fechado' ? 'selected' : ''}>Fechado</option>
              <option value="vendido" ${l.status === 'vendido' ? 'selected' : ''}>Vendido</option>
            </select>
          </td>
        </tr>`).join('') || '<tr><td colspan="6">Nenhum lead encontrado</td></tr>';
      body.querySelectorAll('.status-select').forEach(sel => {
        sel.onchange = async () => {
          const body = { status: sel.value };
          if (sel.value === 'vendido') {
            const val = prompt('Valor da venda (R$):');
            if (val === null) { load(); return; }
            body.sale_value = parseFloat(val.replace(',', '.')) || 0;
          }
          await api.request('/leads/' + encodeURIComponent(sel.dataset.phone) + '/status', {
            method: 'PATCH', body
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
function fmtMoney(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function pctChange(atual, anterior) {
  if (!anterior) return null;
  return Math.round(((atual - anterior) / anterior) * 100);
}

async function renderDashboard() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  try {
    const [m, rev] = await Promise.all([api.request('/metrics'), api.request('/metrics/revenue')]);
    const porStatus = Object.fromEntries((m.leads_por_status || []).map(s => [s.status, s.total]));
    const tempoMin = m.tempo_medio_primeira_resposta_segundos != null
      ? Math.round(m.tempo_medio_primeira_resposta_segundos / 60) + ' min'
      : '-';
    const varReceita = pctChange(rev.receita_mes, rev.receita_mes_anterior);
    const varVendas = pctChange(rev.vendas_mes, rev.vendas_mes_anterior);

    main.innerHTML = `
    <div class="page-title">Dashboard</div>
    <div class="page-sub">Visão geral de conversão e faturamento</div>

    <div class="cards">
      <div class="card"><div class="label">Receita este mês</div><div class="value">${fmtMoney(rev.receita_mes)}</div>${varReceita !== null ? `<div style="font-size:12px;color:${varReceita >= 0 ? 'var(--green)' : 'var(--red)'};margin-top:4px">${varReceita >= 0 ? '▲' : '▼'} ${Math.abs(varReceita)}% vs mês anterior</div>` : ''}</div>
      <div class="card"><div class="label">Vendas este mês</div><div class="value">${rev.vendas_mes}</div>${varVendas !== null ? `<div style="font-size:12px;color:${varVendas >= 0 ? 'var(--green)' : 'var(--red)'};margin-top:4px">${varVendas >= 0 ? '▲' : '▼'} ${Math.abs(varVendas)}% vs mês anterior</div>` : ''}</div>
      <div class="card"><div class="label">Ticket médio</div><div class="value">${fmtMoney(rev.ticket_medio)}</div></div>
      <div class="card"><div class="label">Taxa de conversão</div><div class="value">${rev.taxa_conversao_pct != null ? rev.taxa_conversao_pct + '%' : '-'}</div></div>
    </div>

    ${rev.meta_mensal > 0 ? `
    <div class="panel-box" style="padding:18px;margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);margin-bottom:8px">
        <span>Meta do mês</span><span>${fmtMoney(rev.receita_mes)} / ${fmtMoney(rev.meta_mensal)}</span>
      </div>
      <div style="background:var(--panel3);border-radius:999px;height:10px;overflow:hidden">
        <div style="width:${rev.progresso_meta_pct}%;height:100%;background:var(--gradient)"></div>
      </div>
    </div>` : `<div class="page-sub">Defina uma meta mensal na página <a href="#agente" style="color:var(--accent2)">Agente</a> pra acompanhar o progresso aqui.</div>`}

    <div class="cards">
      <div class="card"><div class="label">Leads (30 dias)</div><div class="value">${m.leads_30_dias ?? '-'}</div></div>
      <div class="card"><div class="label">Ativos</div><div class="value">${porStatus.ativo || 0}</div></div>
      <div class="card"><div class="label">Aguardando humano</div><div class="value">${porStatus.aguardando_humano || 0}</div></div>
      <div class="card"><div class="label">Tempo médio 1ª resposta</div><div class="value">${tempoMin}</div></div>
    </div>

    <div class="panel-box" style="padding:18px;margin-bottom:24px">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px">Receita e leads (últimos 30 dias)</div>
      <canvas id="chart-timeseries" height="90"></canvas>
    </div>

    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px">
      <div class="panel-box" style="padding:18px;flex:1;min-width:320px">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px">Esta semana vs. semana passada</div>
        <canvas id="chart-week" height="140"></canvas>
      </div>
      <div class="panel-box" style="padding:18px;flex:1;min-width:320px">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px">Este mês vs. mês passado</div>
        <canvas id="chart-month" height="140"></canvas>
      </div>
    </div>

    <div class="panel-box" style="padding:18px;margin-bottom:24px">
      <div style="font-size:14px;font-weight:600;margin-bottom:4px">Quando os leads mais conversam</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Mensagens recebidas por dia da semana e hora (últimos 90 dias)</div>
      <div id="heatmap-leads"></div>
    </div>

    <div class="panel-box" style="padding:18px">
      <div style="font-size:14px;font-weight:600;margin-bottom:4px">Quando mais se fecha venda</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Vendas registradas por dia da semana e hora</div>
      <div id="heatmap-vendas"></div>
    </div>`;

    renderCharts();
  } catch (e) {
    main.innerHTML = `<div style="color:var(--red)">Erro ao carregar dashboard: ${escapeHtml(e.message)}</div>`;
  }
}

async function renderCharts() {
  try {
    const ts = await api.request('/metrics/timeseries?days=30');
    new Chart(document.getElementById('chart-timeseries'), {
      type: 'line',
      data: {
        labels: ts.labels,
        datasets: [
          { label: 'Receita (R$)', data: ts.receita, borderColor: '#6c5ce7', backgroundColor: 'rgba(108,92,231,.15)', yAxisID: 'y', tension: 0.3, fill: true },
          { label: 'Leads', data: ts.leads, borderColor: '#4f7cff', backgroundColor: 'rgba(79,124,255,.1)', yAxisID: 'y1', tension: 0.3 }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: { position: 'left', ticks: { color: '#8b93a7' }, grid: { color: '#2a2f3c' } },
          y1: { position: 'right', ticks: { color: '#8b93a7' }, grid: { display: false } },
          x: { ticks: { color: '#8b93a7' }, grid: { display: false } }
        },
        plugins: { legend: { labels: { color: '#eef0f5' } } }
      }
    });
  } catch (e) { /* silencioso: gráfico é complemento, não bloqueia o resto */ }

  try {
    const cmp = await api.request('/metrics/compare');
    const barOptions = (labels) => ({
      responsive: true,
      scales: {
        y: { ticks: { color: '#8b93a7' }, grid: { color: '#2a2f3c' } },
        x: { ticks: { color: '#8b93a7' }, grid: { display: false } }
      },
      plugins: { legend: { labels: { color: '#eef0f5' } } }
    });
    new Chart(document.getElementById('chart-week'), {
      type: 'bar',
      data: {
        labels: cmp.semana.labels,
        datasets: [
          { label: 'Esta semana', data: cmp.semana.leads_atual, backgroundColor: '#6c5ce7' },
          { label: 'Semana passada', data: cmp.semana.leads_anterior, backgroundColor: '#3a3f4d' }
        ]
      },
      options: barOptions(cmp.semana.labels)
    });
    new Chart(document.getElementById('chart-month'), {
      type: 'bar',
      data: {
        labels: cmp.mes.labels,
        datasets: [
          { label: 'Este mês', data: cmp.mes.leads_atual, backgroundColor: '#4f7cff' },
          { label: 'Mês passado', data: cmp.mes.leads_anterior, backgroundColor: '#3a3f4d' }
        ]
      },
      options: barOptions(cmp.mes.labels)
    });
  } catch (e) { /* silencioso */ }

  try {
    const heat = await api.request('/metrics/heatmap');
    renderHeatmap('heatmap-leads', heat.leads);
    renderHeatmap('heatmap-vendas', heat.vendas);
  } catch (e) { /* silencioso */ }
}

function renderHeatmap(elId, data) {
  const el = document.getElementById(elId);
  if (!el) return;
  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const grid = {};
  let max = 1;
  data.forEach(d => { grid[`${d.dow}-${d.hora}`] = d.total; if (d.total > max) max = d.total; });

  if (data.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:13px">Sem dados suficientes ainda</div>';
    return;
  }

  let html = '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:10px"><tbody>';
  for (let dow = 0; dow < 7; dow++) {
    html += `<tr><td style="padding:2px 6px;color:var(--muted);white-space:nowrap">${dias[dow]}</td>`;
    for (let hora = 0; hora < 24; hora++) {
      const v = grid[`${dow}-${hora}`] || 0;
      const alpha = v === 0 ? 0.06 : 0.15 + (v / max) * 0.85;
      html += `<td title="${dias[dow]} ${hora}h: ${v}" style="width:14px;height:14px;background:rgba(108,92,231,${alpha});border-radius:2px;padding:0"></td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  el.innerHTML = html;
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
    </div>

    <div class="page-title" style="margin-top:28px;font-size:16px">Metas & crescimento</div>
    <div class="form-card">
      <label>Meta de faturamento mensal (R$)</label>
      <input id="ag-meta" type="number" step="0.01" value="${a.monthly_goal || ''}" placeholder="Ex: 20000" />
      <label>Considerar lead "esfriando" após quantas horas sem resposta?</label>
      <input id="ag-radar" type="number" value="${a.radar_hours || 24}" />
      <label>E-mail para receber o relatório semanal</label>
      <input id="ag-report-email" type="email" value="${escapeHtml(a.report_email || '')}" placeholder="voce@empresa.com" />
      <div class="toggle-row">
        <div class="switch ${a.report_enabled ? 'on' : ''}" id="ag-report-toggle"><div class="knob"></div></div>
        <span id="ag-report-toggle-label">${a.report_enabled ? 'Relatório semanal ativado' : 'Relatório semanal desativado'}</span>
      </div>
      <div class="save-row">
        <button id="ag-growth-save">Salvar</button>
        <span class="saved-msg" id="ag-growth-saved" style="display:none">Salvo com sucesso ✓</span>
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

  let reportEnabled = !!a.report_enabled;
  const reportToggle = document.getElementById('ag-report-toggle');
  reportToggle.onclick = () => {
    reportEnabled = !reportEnabled;
    reportToggle.classList.toggle('on', reportEnabled);
    document.getElementById('ag-report-toggle-label').textContent = reportEnabled ? 'Relatório semanal ativado' : 'Relatório semanal desativado';
  };

  document.getElementById('ag-growth-save').onclick = async () => {
    await api.request('/agent', {
      method: 'PUT',
      body: {
        monthly_goal: parseFloat(document.getElementById('ag-meta').value) || 0,
        radar_hours: parseInt(document.getElementById('ag-radar').value) || 24,
        report_email: document.getElementById('ag-report-email').value || null,
        report_enabled: reportEnabled
      }
    });
    const saved = document.getElementById('ag-growth-saved');
    saved.style.display = 'inline';
    setTimeout(() => (saved.style.display = 'none'), 2500);
  };
}

// ---------- RADAR (leads esfriando) ----------
async function renderRadar() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';
  try {
    const { radar_hours, leads } = await api.request('/leads/radar');
    main.innerHTML = `
      <div class="page-title">Radar de leads</div>
      <div class="page-sub">Leads que não respondem há mais de ${radar_hours}h — hora de dar um empurrão</div>
      <div id="radar-list">
        ${leads.map(l => `
          <div class="client-row">
            <div class="avatar">${initials(l.name || l.phone)}</div>
            <div class="info">
              <div class="n">${escapeHtml(l.name || l.phone)} <span class="badge ${l.score === 'quente' ? 'aguardando_humano' : l.score === 'morno' ? 'ativo' : 'fechado'}" style="margin-left:6px">${l.score}</span></div>
              <div class="s">${escapeHtml(l.phone)} · silencioso há ${Math.round(l.hours_silent)}h</div>
            </div>
            <button class="ghost" data-phone="${l.phone}">Abrir conversa</button>
          </div>`).join('') || '<div style="color:var(--muted)">Nenhum lead esfriando agora 🎉</div>'}
      </div>`;
    main.querySelectorAll('#radar-list button[data-phone]').forEach(b => {
      b.onclick = () => { activePhone = b.dataset.phone; location.hash = 'conversas'; };
    });
  } catch (e) {
    main.innerHTML = `<div style="color:var(--red)">Erro ao carregar radar: ${escapeHtml(e.message)}</div>`;
  }
}

// ---------- FOLLOW-UP DE RESGATE ----------
async function renderFollowUp() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Follow-up de resgate</div>
    <div class="page-sub">Mensagens automáticas enviadas quando o lead para de responder</div>
    <div class="form-card" style="margin-bottom:20px">
      <label>Nome da regra</label>
      <input id="fu-name" placeholder="Ex: Lembrete 24h" />
      <label>Enviar após quantas horas sem resposta do lead</label>
      <input id="fu-hours" type="number" placeholder="Ex: 24" />
      <label>Mensagem</label>
      <textarea id="fu-message" placeholder="Ex: Oi! Ainda tem interesse? Posso te ajudar com mais alguma coisa? 😊"></textarea>
      <label>Anexo (opcional)</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="fu-media" placeholder="Cole um link ou envie um arquivo" style="margin:0" />
        <button class="ghost" type="button" id="fu-upload-btn" style="white-space:nowrap">Enviar arquivo</button>
        <input type="file" id="fu-file" style="display:none" />
      </div>
      <div class="save-row"><button id="fu-add">Criar regra</button></div>
    </div>
    <div id="fu-list">Carregando...</div>`;

  document.getElementById('fu-upload-btn').onclick = () => document.getElementById('fu-file').click();
  document.getElementById('fu-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadFile(file);
      document.getElementById('fu-media').value = url;
    } catch (err) {
      alert('Erro no upload: ' + err.message);
    }
  };

  async function load() {
    try {
      const rules = await api.request('/follow-up-rules');
      document.getElementById('fu-list').innerHTML = rules.map(r => `
        <div class="client-row">
          <div class="info">
            <div class="n">${escapeHtml(r.name)} · após ${r.wait_hours}h</div>
            <div class="s">${escapeHtml(r.message)}${r.media_url ? ' 📎' : ''}</div>
          </div>
          <div class="switch ${r.active ? 'on' : ''}" data-toggle="${r.id}" title="Ativar/desativar"><div class="knob"></div></div>
          <button class="danger" data-del="${r.id}" style="margin-left:10px">Excluir</button>
        </div>`).join('') || '<div style="color:var(--muted)">Nenhuma regra de follow-up cadastrada</div>';
      document.querySelectorAll('#fu-list [data-toggle]').forEach(el => {
        el.onclick = async () => {
          const on = !el.classList.contains('on');
          await api.request('/follow-up-rules/' + el.dataset.toggle, { method: 'PUT', body: { active: on } });
          load();
        };
      });
      document.querySelectorAll('#fu-list [data-del]').forEach(b => {
        b.onclick = async () => { await api.request('/follow-up-rules/' + b.dataset.del, { method: 'DELETE' }); load(); };
      });
    } catch (e) {
      document.getElementById('fu-list').innerHTML = `<div style="color:var(--red);font-size:13px">Erro ao carregar regras: ${escapeHtml(e.message)}</div>`;
    }
  }

  document.getElementById('fu-add').onclick = async () => {
    const name = document.getElementById('fu-name').value.trim();
    const wait_hours = parseInt(document.getElementById('fu-hours').value);
    const message = document.getElementById('fu-message').value.trim();
    const media_url = document.getElementById('fu-media').value.trim() || null;
    if (!name || !wait_hours || !message) return alert('Preencha nome, horas e mensagem');
    await api.request('/follow-up-rules', { method: 'POST', body: { name, wait_hours, message, media_url } });
    document.getElementById('fu-name').value = '';
    document.getElementById('fu-hours').value = '';
    document.getElementById('fu-message').value = '';
    document.getElementById('fu-media').value = '';
    load();
  };
  await load();
}

// ---------- BASE DE CONHECIMENTO (RAG) ----------
async function renderKnowledge() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Base de conhecimento</div>
    <div class="page-sub">Envie PDFs ou textos (catálogo, FAQ, políticas) pro agente responder com precisão em vez de inventar</div>
    <div class="form-card" style="margin-bottom:20px">
      <label>Arquivo (.pdf ou .txt)</label>
      <input type="file" id="kb-file" accept=".pdf,.txt" />
      <div class="save-row"><button id="kb-upload">Enviar e processar</button></div>
      <div id="kb-result" style="margin-top:10px;font-size:13px"></div>
    </div>
    <div id="kb-list">Carregando...</div>`;

  document.getElementById('kb-upload').onclick = async () => {
    const fileInput = document.getElementById('kb-file');
    const file = fileInput.files[0];
    if (!file) return alert('Escolha um arquivo');
    const resultBox = document.getElementById('kb-result');
    resultBox.textContent = 'Processando... isso pode levar alguns segundos.';
    resultBox.style.color = 'var(--muted)';
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const data = await api.request('/knowledge', {
        method: 'POST',
        body: { filename: file.name, dataBase64, contentType: file.type }
      });
      resultBox.textContent = `Pronto! ${data.chunks} trechos indexados.`;
      resultBox.style.color = 'var(--green)';
      fileInput.value = '';
      load();
    } catch (e) {
      resultBox.textContent = 'Erro: ' + e.message;
      resultBox.style.color = 'var(--red)';
    }
  };

  async function load() {
    try {
      const sources = await api.request('/knowledge');
      document.getElementById('kb-list').innerHTML = sources.map(s => `
        <div class="client-row">
          <div class="info">
            <div class="n">${escapeHtml(s.filename)}</div>
            <div class="s">${s.status === 'pronto' ? `${s.total_chunks} trechos indexados` : s.status === 'erro' ? 'Erro: ' + escapeHtml(s.error_message || '') : 'Processando...'} · ${fmtTime(s.created_at)}</div>
          </div>
          <span class="badge ${s.status === 'pronto' ? 'ativo' : s.status === 'erro' ? 'fechado' : 'aguardando_humano'}">${s.status}</span>
          <button class="danger" data-id="${s.id}" style="margin-left:10px">Excluir</button>
        </div>`).join('') || '<div style="color:var(--muted)">Nenhum arquivo enviado ainda</div>';
      document.querySelectorAll('#kb-list button[data-id]').forEach(b => {
        b.onclick = async () => { await api.request('/knowledge/' + b.dataset.id, { method: 'DELETE' }); load(); };
      });
    } catch (e) {
      document.getElementById('kb-list').innerHTML = `<div style="color:var(--red);font-size:13px">Erro ao carregar: ${escapeHtml(e.message)}</div>`;
    }
  }
  await load();
}

// Converte um File pra base64 e envia pro backend, retornando a URL pública
async function uploadFile(file) {
  const dataBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const data = await api.request('/upload', {
    method: 'POST',
    body: { filename: file.name, dataBase64, contentType: file.type }
  });
  return data.url;
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
  if (!res.ok) throw new Error(data.error ? (data.error + (data.detail ? ' — ' + data.detail : '')) : 'Erro na requisição');
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
