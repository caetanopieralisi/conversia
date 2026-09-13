// =============================================================================
// Onboarding de cliente em um passo.
//
// ANTES (workflow "Onboarding Cliente" + README):
//   1. editar um node Set no n8n com os dados do cliente, na mão
//   2. rodar o workflow manualmente
//   3. criar a instância na Evolution API, na mão
//   4. escanear o QR, na mão
//   5. configurar o webhook da instância apontando pro workflow, na mão
//   6. rodar `node create-user.js` no terminal para criar o login
//   7. copiar a planilha modelo e compartilhar
//   → 7 passos, 3 ferramentas diferentes, e o passo 5 esquecido = cliente mudo
//     sem ninguém perceber
//
// AGORA: um POST. Cria o tenant, o login, a instância, aponta o webhook para o
// token exclusivo do cliente, aplica o playbook do nicho e devolve o QR code
// pronto para escanear.
// =============================================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db');
const { requireAdmin } = require('../auth');
const evolution = require('../lib/evolution');

const router = express.Router();
router.use(requireAdmin);

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function baseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

// ------------------------------------------------------------- templates ----

router.get('/templates', asyncH(async (req, res) => {
  const { rows } = await pool.query('select slug, nome, nicho, playbook from public.playbook_templates order by nome');
  res.json(rows);
}));

// ------------------------------------------------------------- criar --------

/**
 * POST /api/onboarding
 * body: { client_id, nome_empresa, nicho, owner_email, owner_phone,
 *         template_slug?, monthly_fee?, criar_instancia?, evolution_instance? }
 */
router.post('/', asyncH(async (req, res) => {
  const {
    client_id, nome_empresa, nicho, owner_email, owner_phone,
    template_slug, monthly_fee, billing_day, plan,
    criar_instancia = true, evolution_instance, system_prompt
  } = req.body || {};

  // --- Validação -------------------------------------------------------------
  const erros = [];
  if (!client_id) erros.push('client_id é obrigatório');
  else if (!/^[a-z0-9_-]{3,40}$/.test(client_id)) {
    erros.push('client_id deve ter 3 a 40 caracteres, só minúsculas, números, _ e -');
  }
  if (!nome_empresa) erros.push('nome_empresa é obrigatório');
  if (!owner_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner_email)) erros.push('owner_email inválido');
  if (erros.length) return res.status(400).json({ error: erros.join('; ') });

  const jaExiste = await pool.query('select 1 from public.clients where client_id = $1', [client_id]);
  if (jaExiste.rowCount) return res.status(409).json({ error: `Já existe um cliente com o id "${client_id}"` });

  const emailUsado = await pool.query('select 1 from public.users where email = $1', [owner_email]);
  if (emailUsado.rowCount) return res.status(409).json({ error: `O e-mail ${owner_email} já está em uso` });

  // --- Playbook do nicho -----------------------------------------------------
  let playbook = {};
  if (template_slug) {
    const t = await pool.query('select playbook from public.playbook_templates where slug = $1', [template_slug]);
    playbook = t.rows[0]?.playbook || {};
  }

  const instancia = (evolution_instance || client_id).replace(/[^a-zA-Z0-9_-]/g, '');
  const inboundToken = crypto.randomBytes(16).toString('hex');
  const senhaTemp = crypto.randomBytes(5).toString('base64url');

  const passos = [];
  const conn = await pool.connect();
  let criado = false;

  try {
    await conn.query('begin');

    await conn.query(
      `insert into public.clients
         (client_id, nome_empresa, nicho, evolution_instance, numero_responsavel, owner_phone,
          system_prompt, playbook, active, agent_enabled, plan, monthly_fee, billing_day,
          next_due_date, inbound_token, debounce_segundos, created_at)
       values ($1,$2,$3,$4,$5,$5,$6,$7, true, true, coalesce($8,'trial'), coalesce($9,0), coalesce($10,5),
               (current_date + interval '30 days')::date, $11, 12, now())`,
      [client_id, nome_empresa, nicho || null, instancia,
       owner_phone ? normalizeJid(owner_phone) : null,
       system_prompt || null, JSON.stringify(playbook),
       plan || null, monthly_fee != null ? Number(monthly_fee) : null,
       billing_day != null ? Number(billing_day) : null, inboundToken]
    );
    passos.push({ passo: 'cliente_criado', ok: true });

    const hash = await bcrypt.hash(senhaTemp, 10);
    await conn.query(
      `insert into public.users (client_id, email, password_hash, name, role) values ($1,$2,$3,$4,'owner')`,
      [client_id, owner_email, hash, nome_empresa]
    );
    passos.push({ passo: 'login_criado', ok: true });

    // Sequência de follow-up padrão. Sem isso, o cliente novo entra sem nenhuma
    // recuperação de lead ativa — e é justamente o que mais dá retorno.
    await conn.query(
      `insert into public.follow_up_rules (client_id, name, wait_hours, message, active) values
        ($1, 'Resgate 24h', 24, 'Oi! Passando aqui pra saber se você ainda tem interesse. Qualquer dúvida é só me chamar.', true),
        ($1, 'Resgate 3 dias', 72, 'Oi! Fiquei com a impressão de que ficou alguma dúvida. Quer que eu te explique melhor?', true)`,
      [client_id]
    );
    passos.push({ passo: 'followups_padrao', ok: true });

    await conn.query('commit');
    criado = true;
  } catch (e) {
    await conn.query('rollback');
    return res.status(500).json({ error: 'Falha ao criar o cliente', detail: String(e.message) });
  } finally {
    conn.release();
  }

  // --- Evolution API (fora da transação: é rede, pode falhar sem desfazer o
  //     cliente já criado — o admin reexecuta só este passo depois) -----------
  const webhookUrl = `${baseUrl(req)}/api/inbound/${inboundToken}`;
  let qrcode = null;
  let instanciaOk = false;

  if (criar_instancia && evolution.isConfigured()) {
    try {
      const criada = await evolution.createInstance(instancia, { webhookUrl });
      qrcode = criada?.qrcode?.base64 || criada?.qrcode?.code || null;
      instanciaOk = true;
      passos.push({ passo: 'instancia_criada', ok: true, detalhe: instancia });
    } catch (e) {
      // Instância já existente é um caso normal (reonboarding): só aponta o webhook.
      const jaExiste = /already|exists|em uso/i.test(e.message);
      passos.push({ passo: 'instancia_criada', ok: jaExiste, erro: jaExiste ? null : e.message,
        detalhe: jaExiste ? 'já existia — reaproveitada' : undefined });
    }

    try {
      await evolution.setWebhook(instancia, webhookUrl);
      passos.push({ passo: 'webhook_configurado', ok: true, detalhe: webhookUrl });
    } catch (e) {
      passos.push({ passo: 'webhook_configurado', ok: false, erro: e.message });
    }

    if (!qrcode) {
      try {
        const conectar = await evolution.connect(instancia);
        qrcode = conectar?.base64 || conectar?.qrcode?.base64 || conectar?.code || null;
      } catch (e) {
        passos.push({ passo: 'qrcode', ok: false, erro: e.message });
      }
    }
  } else {
    passos.push({
      passo: 'instancia_criada', ok: false,
      erro: evolution.isConfigured() ? 'pulado a pedido' : 'EVOLUTION_API_URL/KEY não configuradas'
    });
  }

  res.json({
    ok: criado,
    client_id,
    login: { email: owner_email, senha_temporaria: senhaTemp },
    whatsapp: {
      instancia,
      webhook_url: webhookUrl,
      qrcode,
      conectado: false,
      instrucao: qrcode
        ? 'Abra o WhatsApp do cliente > Aparelhos conectados > Conectar aparelho, e escaneie o QR.'
        : 'Crie a instância na Evolution API e aponte o webhook para a URL acima.'
    },
    playbook_aplicado: template_slug || null,
    passos,
    proximos_passos: [
      'Escanear o QR code com o WhatsApp do cliente',
      'Subir os documentos dele em Base de conhecimento (é o que evita resposta inventada)',
      'Cadastrar os arquivos que o agente pode enviar (catálogo, tabela de preços)',
      'Revisar o playbook de vendas e testar no simulador',
      `Entregar o acesso: ${owner_email} / ${senhaTemp}`
    ]
  });
}));

// -------------------------------------------------- estado da instância -----

router.get('/:clientId/whatsapp', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'select client_id, evolution_instance, inbound_token from public.clients where client_id = $1',
    [req.params.clientId]
  );
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
  if (!evolution.isConfigured()) return res.json({ configurado: false, erro: 'Evolution API não configurada' });

  let estado = null, qrcode = null;
  try {
    const st = await evolution.connectionState(client.evolution_instance);
    estado = st?.instance?.state || st?.state || null;
  } catch (e) {
    return res.json({ configurado: true, estado: 'inexistente', erro: e.message,
      webhook_url: `${baseUrl(req)}/api/inbound/${client.inbound_token}` });
  }

  if (estado !== 'open') {
    try {
      const c = await evolution.connect(client.evolution_instance);
      qrcode = c?.base64 || c?.qrcode?.base64 || c?.code || null;
    } catch { /* sem QR agora */ }
  }

  res.json({
    configurado: true,
    instancia: client.evolution_instance,
    estado,                       // open = conectado
    conectado: estado === 'open',
    qrcode,
    webhook_url: `${baseUrl(req)}/api/inbound/${client.inbound_token}`
  });
}));

/** Reaponta o webhook — conserta o passo que mais é esquecido. */
router.post('/:clientId/whatsapp/webhook', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'select evolution_instance, inbound_token from public.clients where client_id = $1',
    [req.params.clientId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' });

  const url = `${baseUrl(req)}/api/inbound/${rows[0].inbound_token}`;
  try {
    await evolution.setWebhook(rows[0].evolution_instance, url);
    res.json({ ok: true, webhook_url: url });
  } catch (e) {
    res.status(502).json({ error: e.message, webhook_url: url });
  }
}));

// ------------------------------------------------------------- checklist ----

router.get('/:clientId/checklist', asyncH(async (req, res) => {
  const { clientId } = req.params;
  const c = await pool.query('select * from public.clients where client_id = $1', [clientId]);
  const client = c.rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  const [kb, assets, leads, saidas, integr] = await Promise.all([
    pool.query(`select count(*)::int t from public.knowledge_sources where client_id=$1 and status='pronto'`, [clientId]),
    pool.query('select count(*)::int t from public.assets where client_id=$1 and active', [clientId]),
    pool.query('select count(*)::int t from public.leads where client_id=$1', [clientId]),
    pool.query(`select count(*)::int t from public.messages where client_id=$1 and direction='outbound'`, [clientId]),
    pool.query('select count(*)::int t from public.integrations where client_id=$1 and active', [clientId])
  ]);

  let whatsappOk = false;
  if (evolution.isConfigured() && client.evolution_instance) {
    try {
      const st = await evolution.connectionState(client.evolution_instance);
      whatsappOk = (st?.instance?.state || st?.state) === 'open';
    } catch { /* fica false */ }
  }

  const itens = [
    { chave: 'whatsapp_conectado', label: 'WhatsApp conectado', ok: whatsappOk, critico: true,
      ajuda: 'Escaneie o QR code na aba WhatsApp' },
    { chave: 'playbook', label: 'Playbook de vendas preenchido', critico: true,
      ok: !!(client.playbook && Object.keys(client.playbook).length > 2),
      ajuda: 'Sem playbook o agente não sabe o que perguntar nem como conduzir' },
    { chave: 'base_conhecimento', label: 'Base de conhecimento com documentos', ok: kb.rows[0].t > 0, critico: true,
      ajuda: 'É o que impede o agente de inventar preço e prazo' },
    { chave: 'arquivos', label: 'Arquivos que o agente pode enviar', ok: assets.rows[0].t > 0, critico: false,
      ajuda: 'Catálogo, tabela de preços, portfólio' },
    { chave: 'responsavel', label: 'Número do responsável pelo handoff', ok: !!(client.numero_responsavel || client.owner_phone), critico: true,
      ajuda: 'Sem isso o agente não consegue passar a conversa para um humano' },
    { chave: 'integracao_crm', label: 'CRM conectado', ok: integr.rows[0].t > 0, critico: false },
    { chave: 'cobranca', label: 'Mensalidade configurada', ok: Number(client.monthly_fee) > 0, critico: false },
    { chave: 'primeiro_lead', label: 'Primeiro lead capturado', ok: leads.rows[0].t > 0, critico: false },
    { chave: 'primeira_resposta', label: 'Agente já respondeu alguém', ok: saidas.rows[0].t > 0, critico: false }
  ];

  const criticosPendentes = itens.filter(i => i.critico && !i.ok);
  res.json({
    itens,
    completos: itens.filter(i => i.ok).length,
    total: itens.length,
    pronto_para_producao: criticosPendentes.length === 0,
    bloqueios: criticosPendentes.map(i => i.label)
  });
}));

function normalizeJid(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}

module.exports = router;
