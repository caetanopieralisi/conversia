// =============================================================================
// Telas novas da v6 — Vendedor (playbook), Arquivos e Integrações.
// Carregado depois de app.js e usa os mesmos helpers globais (api, escapeHtml…).
// =============================================================================

/* global api, escapeHtml, initials */

function toast(msg, tipo = 'ok') {
  let el = document.getElementById('cv-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cv-toast';
    el.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'padding:12px 20px;border-radius:10px;font-size:14px;font-weight:500;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.4);transition:opacity .2s;max-width:80vw';
    document.body.appendChild(el);
  }
  el.style.background = tipo === 'erro' ? 'var(--red)' : 'var(--green)';
  el.style.color = '#fff';
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
}

const val = id => document.getElementById(id)?.value?.trim() || '';
const setBusy = (btn, on, label) => {
  if (!btn) return;
  btn.disabled = on;
  if (on) { btn._label = btn.textContent; btn.textContent = label || 'Aguarde...'; }
  else if (btn._label) btn.textContent = btn._label;
};

// =============================================================================
// VENDEDOR — o playbook
// =============================================================================

async function renderVendedor() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';

  let d;
  try { d = await api.request('/playbook'); }
  catch (e) { main.innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`; return; }

  const pb = d.playbook && Object.keys(d.playbook).length ? d.playbook : {};
  const perguntas = pb.perguntas_qualificacao || [];
  const objecoes = pb.objecoes || [];
  const provas = pb.provas || [];

  main.innerHTML = `
    <div class="page-title">Seu vendedor</div>
    <div class="page-sub">
      Preencha aqui e o agente aprende a vender do seu jeito. Não é preciso escrever prompt —
      a plataforma monta as instruções a partir destes campos.
    </div>

    ${!Object.keys(pb).length ? `
      <div class="form-card" style="border-left:3px solid var(--accent)">
        <div style="font-weight:600;margin-bottom:6px">Comece por um modelo pronto</div>
        <div style="color:var(--muted);font-size:13px;margin-bottom:12px">
          Escolha o mais próximo do seu negócio e ajuste depois. Leva 30 segundos.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${(d.templates || []).map(t =>
            `<button class="ghost" data-tpl="${t.slug}">${escapeHtml(t.nome)}</button>`).join('')}
        </div>
      </div>` : ''}

    <div class="form-card">
      <label>O que a empresa vende</label>
      <textarea id="pb-oferta" placeholder="Ex: Consultoria de recrutamento e seleção para empresas de 20 a 500 funcionários, com garantia de reposição de 90 dias."
        >${escapeHtml(pb.oferta || '')}</textarea>

      <label>Objetivo do agente nesta conversa</label>
      <input id="pb-objetivo" value="${escapeHtml(pb.objetivo || '')}"
        placeholder="Ex: Entender a necessidade e agendar uma reunião com o diretor" />

      <label>Tom de voz</label>
      <input id="pb-tom" value="${escapeHtml(pb.tom || '')}"
        placeholder="Ex: consultivo, direto, caloroso" />
    </div>

    <div class="page-title" style="margin-top:28px;font-size:16px">O que ele precisa descobrir</div>
    <div class="page-sub" style="margin-bottom:12px">
      Uma pergunta por vez, na ordem. Marque como essencial só o que realmente trava a venda —
      lista longa afasta a pessoa.
    </div>
    <div class="form-card">
      <div id="pb-perguntas"></div>
      <button class="ghost" id="pb-add-pergunta" style="margin-top:8px">+ Adicionar pergunta</button>

      <label style="margin-top:20px">Quando considerar o lead qualificado</label>
      <input id="pb-criterio" value="${escapeHtml(pb.criterio_qualificado || '')}"
        placeholder="Ex: nome e empresa e (email ou telefone)" />
      <div style="color:var(--muted);font-size:12px;margin-top:-8px">
        Use os nomes dos campos acima com <b>e</b> / <b>ou</b> e parênteses.
        Ao qualificar, o lead é enviado ao seu CRM automaticamente.
      </div>
    </div>

    <div class="page-title" style="margin-top:28px;font-size:16px">Objeções</div>
    <div class="page-sub" style="margin-bottom:12px">
      O que as pessoas dizem quando hesitam — e a melhor resposta que seu time dá hoje.
      É o campo que mais muda a taxa de fechamento.
    </div>
    <div class="form-card">
      <div id="pb-objecoes"></div>
      <button class="ghost" id="pb-add-objecao" style="margin-top:8px">+ Adicionar objeção</button>
    </div>

    <div class="page-title" style="margin-top:28px;font-size:16px">Provas e diferenciais</div>
    <div class="form-card">
      <label>Uma por linha (casos, números, garantias, clientes conhecidos)</label>
      <textarea id="pb-provas" placeholder="Atendemos mais de 300 empresas na região&#10;Garantia de reposição em 90 dias&#10;Tempo médio de fechamento de vaga: 18 dias"
        >${escapeHtml(provas.join('\n'))}</textarea>
    </div>

    <div class="page-title" style="margin-top:28px;font-size:16px">Limites</div>
    <div class="form-card">
      <label>Assuntos que o agente NUNCA deve tratar (um por linha)</label>
      <textarea id="pb-nunca" placeholder="valores e condições comerciais&#10;prazos de entrega específicos"
        >${escapeHtml((pb.nunca_falar || []).join('\n'))}</textarea>

      <label>Quando passar para um humano (um por linha)</label>
      <textarea id="pb-handoff" placeholder="lead qualificado&#10;pediu desconto&#10;reclamação"
        >${escapeHtml((pb.handoff_quando || []).join('\n'))}</textarea>

      <label>WhatsApp que recebe o aviso de transferência</label>
      <input id="pb-responsavel" value="${escapeHtml((d.numero_responsavel || '').split('@')[0])}"
        placeholder="5517999999999 (com DDI e DDD)" />
    </div>

    <div class="page-title" style="margin-top:28px;font-size:16px">Configurações técnicas</div>
    <div class="form-card">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <label>Modelo de IA</label>
          <select id="pb-modelo" style="width:100%;padding:10px;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:8px">
            ${['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o', 'claude-sonnet-4', 'claude-haiku-4']
              .map(m => `<option ${d.llm_model === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
          <div style="color:var(--muted);font-size:12px;margin-top:6px">
            Mais barato: gpt-4.1-mini. Vendas complexas: gpt-4.1 ou claude-sonnet-4.
          </div>
        </div>
        <div>
          <label>Segundos de espera antes de responder</label>
          <input id="pb-debounce" type="number" min="2" max="60" value="${d.debounce_segundos || 12}" />
          <div style="color:var(--muted);font-size:12px;margin-top:-8px">
            Agrupa mensagens enviadas em sequência numa resposta só.
          </div>
        </div>
      </div>

      <label style="margin-top:16px">Máximo de respostas do agente por conversa</label>
      <input id="pb-turnos" type="number" min="3" max="60" value="${d.max_agent_turns || 12}" />
      <div style="color:var(--muted);font-size:12px;margin-top:-8px">
        Passando disso, ele oferece um humano em vez de continuar sozinho.
      </div>

      <div class="toggle-row" style="margin-top:16px">
        <div class="switch ${d.audio_enabled !== false ? 'on' : ''}" id="pb-audio"><div class="knob"></div></div>
        <span>Ouvir e transcrever áudios recebidos</span>
      </div>
      <div class="toggle-row">
        <div class="switch ${d.vision_enabled !== false ? 'on' : ''}" id="pb-visao"><div class="knob"></div></div>
        <span>Ler imagens e prints enviados pelo cliente</span>
      </div>
      <div class="toggle-row">
        <div class="switch ${d.agent_enabled !== false ? 'on' : ''}" id="pb-ativo"><div class="knob"></div></div>
        <span>Agente respondendo automaticamente</span>
      </div>
    </div>

    <div class="save-row" style="margin-top:20px;gap:10px">
      <button id="pb-save">Salvar vendedor</button>
      <button class="ghost" id="pb-preview">Ver as instruções geradas</button>
    </div>
    <div id="pb-preview-box" style="display:none;margin-top:16px"></div>`;

  // --- lista dinâmica de perguntas ---
  const boxP = document.getElementById('pb-perguntas');
  function linhaPergunta(p = {}) {
    const div = document.createElement('div');
    div.className = 'pb-linha';
    div.style.cssText = 'display:grid;grid-template-columns:150px 1fr auto auto;gap:8px;align-items:center;margin-bottom:8px';
    div.innerHTML = `
      <input class="pb-campo" placeholder="campo" value="${escapeHtml(p.campo || '')}" style="margin:0" />
      <input class="pb-pergunta" placeholder="Como ele pergunta isso?" value="${escapeHtml(p.pergunta || '')}" style="margin:0" />
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);white-space:nowrap">
        <input type="checkbox" class="pb-obrig" ${p.obrigatorio ? 'checked' : ''} /> essencial
      </label>
      <button class="ghost pb-del" type="button" style="padding:6px 10px">✕</button>`;
    div.querySelector('.pb-del').onclick = () => div.remove();
    boxP.appendChild(div);
  }
  (perguntas.length ? perguntas : [{}]).forEach(linhaPergunta);
  document.getElementById('pb-add-pergunta').onclick = () => linhaPergunta();

  // --- lista dinâmica de objeções ---
  const boxO = document.getElementById('pb-objecoes');
  function linhaObjecao(o = {}) {
    const div = document.createElement('div');
    div.className = 'pb-obj';
    div.style.cssText = 'display:grid;grid-template-columns:1fr 1.6fr auto;gap:8px;align-items:start;margin-bottom:8px';
    div.innerHTML = `
      <input class="pb-o-txt" placeholder='O que o cliente diz: "está caro"' value="${escapeHtml(o.objecao || '')}" style="margin:0" />
      <input class="pb-o-resp" placeholder="Como responder" value="${escapeHtml(o.resposta || '')}" style="margin:0" />
      <button class="ghost pb-del" type="button" style="padding:6px 10px">✕</button>`;
    div.querySelector('.pb-del').onclick = () => div.remove();
    boxO.appendChild(div);
  }
  (objecoes.length ? objecoes : [{}]).forEach(linhaObjecao);
  document.getElementById('pb-add-objecao').onclick = () => linhaObjecao();

  // --- toggles ---
  const toggles = {};
  ['pb-audio', 'pb-visao', 'pb-ativo'].forEach(id => {
    const el = document.getElementById(id);
    toggles[id] = el.classList.contains('on');
    el.onclick = () => { toggles[id] = !toggles[id]; el.classList.toggle('on', toggles[id]); };
  });

  // --- templates ---
  main.querySelectorAll('[data-tpl]').forEach(b => {
    b.onclick = async () => {
      setBusy(b, true, 'Aplicando...');
      try {
        await api.request(`/playbook/apply-template/${b.dataset.tpl}`, { method: 'POST' });
        toast('Modelo aplicado. Ajuste o que precisar e salve.');
        renderVendedor();
      } catch (e) { toast(e.message, 'erro'); setBusy(b, false); }
    };
  });

  function coletar() {
    const linhas = [...boxP.querySelectorAll('.pb-linha')].map(l => ({
      campo: l.querySelector('.pb-campo').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      pergunta: l.querySelector('.pb-pergunta').value.trim(),
      obrigatorio: l.querySelector('.pb-obrig').checked
    })).filter(p => p.campo);

    const objs = [...boxO.querySelectorAll('.pb-obj')].map(l => ({
      objecao: l.querySelector('.pb-o-txt').value.trim(),
      resposta: l.querySelector('.pb-o-resp').value.trim()
    })).filter(o => o.objecao && o.resposta);

    const linhasDe = id => val(id).split('\n').map(s => s.trim()).filter(Boolean);

    return {
      playbook: {
        ...pb,
        oferta: val('pb-oferta'),
        objetivo: val('pb-objetivo'),
        tom: val('pb-tom'),
        perguntas_qualificacao: linhas,
        criterio_qualificado: val('pb-criterio'),
        objecoes: objs,
        provas: linhasDe('pb-provas'),
        nunca_falar: linhasDe('pb-nunca'),
        handoff_quando: linhasDe('pb-handoff')
      },
      llm_model: val('pb-modelo'),
      llm_provider: val('pb-modelo').startsWith('claude') ? 'anthropic' : 'openai',
      debounce_segundos: Number(val('pb-debounce')) || 12,
      max_agent_turns: Number(val('pb-turnos')) || 12,
      audio_enabled: toggles['pb-audio'],
      vision_enabled: toggles['pb-visao'],
      agent_enabled: toggles['pb-ativo'],
      numero_responsavel: val('pb-responsavel') || null
    };
  }

  document.getElementById('pb-save').onclick = async (e) => {
    setBusy(e.target, true, 'Salvando...');
    try {
      await api.request('/playbook', { method: 'PUT', body: coletar() });
      toast('Vendedor salvo. Teste em "Testar agente" antes de soltar no WhatsApp.');
    } catch (err) { toast(err.message, 'erro'); }
    finally { setBusy(e.target, false); }
  };

  document.getElementById('pb-preview').onclick = async (e) => {
    setBusy(e.target, true, 'Gerando...');
    const box = document.getElementById('pb-preview-box');
    try {
      const r = await api.request('/playbook/preview', { method: 'POST', body: { playbook: coletar().playbook } });
      box.style.display = 'block';
      box.innerHTML = `
        <div class="form-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <b>Instruções que o agente recebe</b>
            <span style="color:var(--muted);font-size:12px">~${r.tokens_estimados} tokens por mensagem</span>
          </div>
          <pre style="white-space:pre-wrap;font-size:12px;line-height:1.5;color:var(--muted);max-height:420px;overflow:auto;margin:0">${escapeHtml(r.prompt)}</pre>
        </div>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) { toast(err.message, 'erro'); }
    finally { setBusy(e.target, false); }
  };
}

// =============================================================================
// ARQUIVOS
// =============================================================================

async function renderArquivos() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';

  let lista;
  try { lista = await api.request('/assets'); }
  catch (e) { main.innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`; return; }

  main.innerHTML = `
    <div class="page-title">Arquivos do agente</div>
    <div class="page-sub">
      Materiais que o agente envia sozinho no meio da conversa. O campo
      <b>“quando enviar”</b> é o mais importante: é por ele que o agente decide a hora certa.
    </div>

    <div class="form-card" style="margin-bottom:20px">
      <label>Nome do arquivo</label>
      <input id="as-nome" placeholder="Ex: Catálogo 2026" />

      <label>Quando o agente deve enviar</label>
      <input id="as-desc" placeholder="Ex: quando o cliente pedir para ver os produtos ou perguntar o que temos disponível" />
      <div style="color:var(--muted);font-size:12px;margin-top:-8px">
        Escreva como você explicaria a um vendedor novo. Evite só “catálogo”.
      </div>

      <label>Tipo</label>
      <select id="as-tipo" style="width:100%;padding:10px;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:8px;margin-bottom:14px">
        <option value="document">Documento (PDF, planilha…)</option>
        <option value="image">Imagem</option>
        <option value="video">Vídeo</option>
        <option value="audio">Áudio</option>
      </select>

      <label>Arquivo</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="as-url" placeholder="Cole um link público ou envie o arquivo" style="margin:0" />
        <button class="ghost" type="button" id="as-upload-btn" style="white-space:nowrap">Enviar arquivo</button>
        <input type="file" id="as-file" style="display:none" />
      </div>

      <div class="save-row" style="margin-top:16px">
        <button id="as-add">Adicionar</button>
      </div>
    </div>

    <div id="as-lista">
      ${lista.length ? lista.map(a => `
        <div class="client-row" style="${a.active ? '' : 'opacity:.5'}">
          <div class="avatar">${a.kind === 'image' ? '🖼️' : a.kind === 'video' ? '🎬' : a.kind === 'audio' ? '🎧' : '📄'}</div>
          <div class="info">
            <div class="n">${escapeHtml(a.name)}
              <span style="color:var(--muted);font-weight:400;font-size:12px;margin-left:8px">enviado ${a.send_count || 0}×</span>
            </div>
            <div class="s">${escapeHtml(a.description)}</div>
          </div>
          <button class="ghost" data-toggle="${a.id}" data-active="${a.active}">${a.active ? 'Desativar' : 'Ativar'}</button>
          <button class="ghost" data-del="${a.id}" style="color:var(--red)">Excluir</button>
        </div>`).join('')
      : `<div class="empty-state">
           Nenhum arquivo ainda. Suba seu catálogo ou tabela de preços — é o que permite ao
           agente responder “te mando aqui” em vez de “vou verificar”.
         </div>`}
    </div>`;

  const fileInput = document.getElementById('as-file');
  document.getElementById('as-upload-btn').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    if (!f) return;
    const btn = document.getElementById('as-upload-btn');
    setBusy(btn, true, 'Enviando...');
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      const { url } = await api.request('/upload', {
        method: 'POST', body: { filename: f.name, dataBase64: b64, contentType: f.type }
      });
      document.getElementById('as-url').value = url;
      if (!val('as-nome')) document.getElementById('as-nome').value = f.name.replace(/\.[^.]+$/, '');
      if (f.type.startsWith('image/')) document.getElementById('as-tipo').value = 'image';
      else if (f.type.startsWith('video/')) document.getElementById('as-tipo').value = 'video';
      toast('Arquivo enviado. Agora descreva quando o agente deve usá-lo.');
    } catch (e) { toast(e.message, 'erro'); }
    finally { setBusy(btn, false); }
  };

  document.getElementById('as-add').onclick = async (e) => {
    if (!val('as-nome') || !val('as-url')) return toast('Informe o nome e o arquivo', 'erro');
    if (val('as-desc').length < 10) return toast('Descreva quando o agente deve enviar este arquivo', 'erro');
    setBusy(e.target, true, 'Salvando...');
    try {
      await api.request('/assets', {
        method: 'POST',
        body: {
          name: val('as-nome'), description: val('as-desc'),
          url: val('as-url'), kind: val('as-tipo'),
          file_name: val('as-url').split('/').pop().split('?')[0]
        }
      });
      renderArquivos();
    } catch (err) { toast(err.message, 'erro'); setBusy(e.target, false); }
  };

  main.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Excluir este arquivo da biblioteca do agente?')) return;
      await api.request(`/assets/${b.dataset.del}`, { method: 'DELETE' });
      renderArquivos();
    };
  });
  main.querySelectorAll('[data-toggle]').forEach(b => {
    b.onclick = async () => {
      await api.request(`/assets/${b.dataset.toggle}`, {
        method: 'PUT', body: { active: b.dataset.active !== 'true' }
      });
      renderArquivos();
    };
  });
}

// =============================================================================
// INTEGRAÇÕES
// =============================================================================

async function renderIntegracoes() {
  const main = document.getElementById('main');
  main.innerHTML = 'Carregando...';

  let providers, atuais, chaves, webhooks;
  try {
    [providers, atuais, chaves, webhooks] = await Promise.all([
      api.request('/integrations/providers'),
      api.request('/integrations'),
      api.request('/integrations/api-keys/list'),
      api.request('/integrations/webhooks/list')
    ]);
  } catch (e) { main.innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`; return; }

  main.innerHTML = `
    <div class="page-title">Integrações</div>
    <div class="page-sub">Conecte seu CRM para que cada lead qualificado chegue lá sozinho.</div>

    <div id="int-conectadas" style="margin-bottom:24px">
      ${atuais.length ? atuais.map(i => `
        <div class="client-row">
          <div class="avatar">${i.active ? '🔗' : '⛔'}</div>
          <div class="info">
            <div class="n">${escapeHtml(i.label || i.provider)}</div>
            <div class="s">
              ${i.last_sync_at ? 'Última sincronização: ' + new Date(i.last_sync_at).toLocaleString('pt-BR') : 'Ainda não sincronizou'}
              ${i.last_error ? `<span style="color:var(--red)"> · ${escapeHtml(i.last_error.slice(0, 80))}</span>` : ''}
            </div>
          </div>
          <button class="ghost" data-test="${i.id}">Testar</button>
          <button class="ghost" data-logs="${i.id}">Histórico</button>
          <button class="ghost" data-int-del="${i.id}" style="color:var(--red)">Remover</button>
        </div>`).join('')
      : '<div class="empty-state">Nenhum CRM conectado ainda.</div>'}
    </div>
    <div id="int-logs"></div>

    <div class="page-title" style="font-size:16px">Conectar um CRM</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:28px">
      ${providers.map(p => `
        <div class="card" style="cursor:pointer" data-prov="${p.provider}">
          <div style="font-weight:600;margin-bottom:6px">${escapeHtml(p.label)}</div>
          <div style="color:var(--muted);font-size:12px;line-height:1.5">${escapeHtml(p.descricao)}</div>
        </div>`).join('')}
    </div>
    <div id="int-form"></div>

    <div class="page-title" style="font-size:16px;margin-top:28px">Chaves de API</div>
    <div class="page-sub" style="margin-bottom:12px">
      Para o seu site, ERP ou automação criarem leads e dispararem mensagens.
      Documentação em <code>/api/v1</code>.
    </div>
    <div class="form-card">
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div style="flex:1">
          <label>Nome da chave</label>
          <input id="ak-nome" placeholder="Ex: Formulário do site" style="margin:0" />
        </div>
        <button id="ak-criar">Gerar chave</button>
      </div>
      <div id="ak-nova"></div>
    </div>
    <div id="ak-lista" style="margin-top:12px">
      ${chaves.filter(k => !k.revoked).map(k => `
        <div class="client-row">
          <div class="avatar">🔑</div>
          <div class="info">
            <div class="n">${escapeHtml(k.name)}</div>
            <div class="s"><code>${escapeHtml(k.key_prefix)}…</code> · ${k.scopes.join(', ')} ·
              ${k.last_used_at ? 'usada em ' + new Date(k.last_used_at).toLocaleDateString('pt-BR') : 'nunca usada'}</div>
          </div>
          <button class="ghost" data-ak-del="${k.id}" style="color:var(--red)">Revogar</button>
        </div>`).join('') || '<div class="empty-state">Nenhuma chave criada.</div>'}
    </div>

    <div class="page-title" style="font-size:16px;margin-top:28px">Webhooks de saída</div>
    <div class="page-sub" style="margin-bottom:12px">
      Avisamos seu sistema a cada evento (lead novo, qualificado, venda, transferência).
      Cada envio vai assinado em <code>X-ConversIA-Signature</code>.
    </div>
    <div class="form-card">
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div style="flex:1">
          <label>URL de destino (https)</label>
          <input id="wh-url" placeholder="https://seusistema.com/webhooks/conversia" style="margin:0" />
        </div>
        <button id="wh-criar">Adicionar</button>
      </div>
      <div id="wh-novo"></div>
    </div>
    <div id="wh-lista" style="margin-top:12px">
      ${webhooks.map(w => `
        <div class="client-row">
          <div class="avatar">${w.active ? '📡' : '⛔'}</div>
          <div class="info">
            <div class="n">${escapeHtml(w.url)}</div>
            <div class="s">${w.events.join(', ')}${w.failure_count ? ` · ${w.failure_count} falha(s)` : ''}</div>
          </div>
          <button class="ghost" data-wh-del="${w.id}" style="color:var(--red)">Remover</button>
        </div>`).join('') || '<div class="empty-state">Nenhum webhook configurado.</div>'}
    </div>`;

  // --- formulário do provedor escolhido ---
  main.querySelectorAll('[data-prov]').forEach(card => {
    card.onclick = () => {
      const p = providers.find(x => x.provider === card.dataset.prov);
      const box = document.getElementById('int-form');
      box.innerHTML = `
        <div class="form-card" style="border-left:3px solid var(--accent)">
          <div style="font-weight:600;margin-bottom:4px">${escapeHtml(p.label)}</div>
          <div style="color:var(--muted);font-size:13px;margin-bottom:14px">${escapeHtml(p.descricao)}</div>
          ${p.campos.map(c => `
            <label>${escapeHtml(c.label)}${c.obrigatorio ? ' *' : ''}</label>
            ${c.tipo === 'select'
              ? `<select id="cf-${c.nome}" style="width:100%;padding:10px;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:8px;margin-bottom:14px">
                   ${c.opcoes.map(o => `<option ${o === c.padrao ? 'selected' : ''}>${o}</option>`).join('')}</select>`
              : c.tipo === 'boolean'
              ? `<div style="margin-bottom:14px"><input type="checkbox" id="cf-${c.nome}" ${c.padrao ? 'checked' : ''} /> sim</div>`
              : `<input id="cf-${c.nome}" type="${c.tipo === 'password' ? 'password' : 'text'}" />`}
            ${c.ajuda ? `<div style="color:var(--muted);font-size:12px;margin-top:-8px;margin-bottom:12px">${escapeHtml(c.ajuda)}</div>` : ''}
          `).join('')}
          <div class="save-row"><button id="int-salvar">Conectar e testar</button></div>
        </div>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      document.getElementById('int-salvar').onclick = async (e) => {
        const credentials = {}, config = {};
        for (const c of p.campos) {
          const el = document.getElementById(`cf-${c.nome}`);
          const v = c.tipo === 'boolean' ? el.checked : el.value.trim();
          if (c.tipo === 'password' || /token|key|secret|senha/i.test(c.nome)) credentials[c.nome] = v;
          else config[c.nome] = v;
        }
        setBusy(e.target, true, 'Testando conexão...');
        try {
          await api.request('/integrations', {
            method: 'POST', body: { provider: p.provider, label: p.label, credentials, config }
          });
          toast('Conectado! Os próximos leads qualificados vão direto para lá.');
          renderIntegracoes();
        } catch (err) { toast(err.message, 'erro'); setBusy(e.target, false); }
      };
    };
  });

  main.querySelectorAll('[data-test]').forEach(b => {
    b.onclick = async () => {
      setBusy(b, true, 'Enviando...');
      try {
        const r = await api.request(`/integrations/${b.dataset.test}/test`, { method: 'POST' });
        toast(r.ok ? r.mensagem : r.error, r.ok ? 'ok' : 'erro');
      } catch (e) { toast(e.message, 'erro'); }
      finally { setBusy(b, false); }
    };
  });

  main.querySelectorAll('[data-logs]').forEach(b => {
    b.onclick = async () => {
      const logs = await api.request(`/integrations/${b.dataset.logs}/logs`);
      document.getElementById('int-logs').innerHTML = `
        <div class="form-card">
          <b style="display:block;margin-bottom:10px">Últimos envios</b>
          ${logs.length ? logs.map(l => `
            <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
              <span style="color:${l.status === 'ok' ? 'var(--green)' : 'var(--red)'}">${l.status === 'ok' ? '✓' : '✕'}</span>
              <span style="flex:1">${escapeHtml(l.event)} · ${escapeHtml(l.phone || '')}</span>
              <span style="color:var(--muted)">${new Date(l.created_at).toLocaleString('pt-BR')}</span>
            </div>`).join('')
          : '<div style="color:var(--muted)">Nada enviado ainda.</div>'}
        </div>`;
    };
  });

  main.querySelectorAll('[data-int-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Remover esta integração?')) return;
      await api.request(`/integrations/${b.dataset.intDel}`, { method: 'DELETE' });
      renderIntegracoes();
    };
  });

  document.getElementById('ak-criar').onclick = async (e) => {
    if (!val('ak-nome')) return toast('Dê um nome à chave', 'erro');
    setBusy(e.target, true, 'Gerando...');
    try {
      const r = await api.request('/integrations/api-keys', { method: 'POST', body: { name: val('ak-nome') } });
      document.getElementById('ak-nova').innerHTML = `
        <div style="margin-top:14px;padding:14px;background:var(--panel3);border-radius:8px;border-left:3px solid var(--yellow)">
          <div style="font-size:12px;color:var(--yellow);margin-bottom:6px">${escapeHtml(r.aviso)}</div>
          <code style="font-size:13px;word-break:break-all;user-select:all">${escapeHtml(r.key)}</code>
        </div>`;
    } catch (err) { toast(err.message, 'erro'); }
    finally { setBusy(e.target, false); }
  };

  main.querySelectorAll('[data-ak-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Revogar esta chave? Sistemas que a usam vão parar de funcionar.')) return;
      await api.request(`/integrations/api-keys/${b.dataset.akDel}`, { method: 'DELETE' });
      renderIntegracoes();
    };
  });

  document.getElementById('wh-criar').onclick = async (e) => {
    setBusy(e.target, true, 'Salvando...');
    try {
      const r = await api.request('/integrations/webhooks', { method: 'POST', body: { url: val('wh-url') } });
      document.getElementById('wh-novo').innerHTML = `
        <div style="margin-top:14px;padding:14px;background:var(--panel3);border-radius:8px;border-left:3px solid var(--yellow)">
          <div style="font-size:12px;color:var(--yellow);margin-bottom:6px">${escapeHtml(r.aviso)}</div>
          <code style="font-size:13px;word-break:break-all;user-select:all">${escapeHtml(r.secret)}</code>
        </div>`;
      setTimeout(renderIntegracoes, 12000);
    } catch (err) { toast(err.message, 'erro'); }
    finally { setBusy(e.target, false); }
  };

  main.querySelectorAll('[data-wh-del]').forEach(b => {
    b.onclick = async () => {
      await api.request(`/integrations/webhooks/${b.dataset.whDel}`, { method: 'DELETE' });
      renderIntegracoes();
    };
  });
}

// =============================================================================
// SIMULADOR v6 — mostra o diagnóstico do que o agente fez
// =============================================================================

async function renderSimuladorV6() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">Testar agente</div>
    <div class="page-sub">
      Conversa real com o agente — mesma IA, mesma base de conhecimento, mesmas ferramentas —
      só que nada é enviado no WhatsApp.
    </div>
    <div style="display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start">
      <div>
        <div class="chat" style="height:60vh;display:flex;flex-direction:column">
          <div class="chat-msgs" id="sim-msgs" style="flex:1;overflow:auto;padding:16px"></div>
          <div class="chat-input" style="display:flex;gap:8px;padding:12px;border-top:1px solid var(--border)">
            <textarea id="sim-input" placeholder="Escreva como se fosse um cliente..." rows="1" style="flex:1"></textarea>
            <button id="sim-send">Enviar</button>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="ghost" id="sim-reset">Recomeçar conversa</button>
          <button class="ghost" id="sim-kb">Testar só a base de conhecimento</button>
        </div>
        <div id="sim-kb-box"></div>
      </div>
      <div id="sim-diag" class="form-card" style="position:sticky;top:16px">
        <b>Diagnóstico</b>
        <div style="color:var(--muted);font-size:13px;margin-top:8px">
          Mande uma mensagem para ver o que o agente consultou, quais ferramentas usou e quanto custou.
        </div>
      </div>
    </div>`;

  const msgs = document.getElementById('sim-msgs');
  const input = document.getElementById('sim-input');

  function bolha(texto, lado) {
    const d = document.createElement('div');
    d.style.cssText =
      `max-width:75%;margin:6px 0;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;` +
      (lado === 'user'
        ? 'margin-left:auto;background:var(--accent);color:#fff'
        : 'background:var(--panel3)');
    d.textContent = texto;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  try {
    (await api.request('/simulate/history')).forEach(m => bolha(m.content, m.direction === 'inbound' ? 'user' : 'bot'));
  } catch { /* primeira vez */ }

  async function enviar() {
    const texto = input.value.trim();
    if (!texto) return;
    input.value = '';
    bolha(texto, 'user');

    const pensando = document.createElement('div');
    pensando.style.cssText = 'color:var(--muted);font-size:13px;margin:8px 0';
    pensando.textContent = 'digitando...';
    msgs.appendChild(pensando);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      const r = await api.request('/simulate', { method: 'POST', body: { message: texto } });
      pensando.remove();
      r.messages.forEach(m => bolha(m, 'bot'));

      const d = r.diagnostico || {};
      document.getElementById('sim-diag').innerHTML = `
        <b>Diagnóstico</b>
        <div style="font-size:13px;margin-top:12px;line-height:1.9">
          <div><span style="color:var(--muted)">Estágio:</span> <b>${escapeHtml(d.estagio || '—')}</b></div>
          <div><span style="color:var(--muted)">Trechos da base usados:</span> <b>${d.trechos_de_conhecimento ?? 0}</b></div>
          <div><span style="color:var(--muted)">Modelo:</span> ${escapeHtml(d.modelo || '—')}</div>
          <div><span style="color:var(--muted)">Tempo:</span> ${d.tempo_ms} ms</div>
          <div><span style="color:var(--muted)">Custo:</span> US$ ${(d.custo_usd || 0).toFixed(5)}</div>
          ${d.handoff ? `<div style="color:var(--yellow)">⚠ Pediu humano: ${escapeHtml(d.handoff.motivo || '')}</div>` : ''}
          ${d.arquivos_enviados?.length ? `<div style="color:var(--green)">📎 Enviaria: ${d.arquivos_enviados.map(escapeHtml).join(', ')}</div>` : ''}
        </div>
        ${Object.keys(d.coletado || {}).length ? `
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
            <div style="color:var(--muted);font-size:12px;margin-bottom:6px">JÁ DESCOBRIU</div>
            ${Object.entries(d.coletado).map(([k, v]) =>
              `<div style="font-size:13px">${escapeHtml(k)}: <b>${escapeHtml(String(v))}</b></div>`).join('')}
          </div>` : ''}
        ${d.ferramentas_usadas?.length ? `
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
            <div style="color:var(--muted);font-size:12px;margin-bottom:6px">FERRAMENTAS</div>
            ${d.ferramentas_usadas.map(t => `<div style="font-size:12px;color:var(--muted)">${escapeHtml(JSON.stringify(t))}</div>`).join('')}
          </div>` : ''}`;
    } catch (e) {
      pensando.remove();
      bolha('Erro: ' + e.message, 'bot');
    }
  }

  document.getElementById('sim-send').onclick = enviar;
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } };

  document.getElementById('sim-reset').onclick = async () => {
    await api.request('/simulate', { method: 'POST', body: { reset: true } });
    msgs.innerHTML = '';
    toast('Conversa reiniciada');
  };

  document.getElementById('sim-kb').onclick = async () => {
    const pergunta = prompt('O que você quer perguntar à base de conhecimento?');
    if (!pergunta) return;
    const r = await api.request('/simulate/knowledge', { method: 'POST', body: { pergunta } });
    document.getElementById('sim-kb-box').innerHTML = `
      <div class="form-card" style="margin-top:12px">
        <b>Trechos encontrados (${r.total})</b>
        <div style="color:var(--muted);font-size:12px;margin:6px 0 12px">estratégia: ${escapeHtml(r.estrategia)}</div>
        ${r.aviso ? `<div style="color:var(--yellow);font-size:13px;margin-bottom:10px">${escapeHtml(r.aviso)}</div>` : ''}
        ${r.trechos.map(t => `
          <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
            <span style="color:var(--muted)">${t.score}</span> — ${escapeHtml(t.conteudo)}
          </div>`).join('')}
      </div>`;
  };
}
