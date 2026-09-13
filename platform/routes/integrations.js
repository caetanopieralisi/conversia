// Gestão de integrações, chaves de API e webhooks — tudo pelo painel do cliente.

const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../auth');
const cryptoLib = require('../lib/crypto');
const crm = require('../lib/crm');

const router = express.Router();
router.use(requireAuth);

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------- catálogo -----

router.get('/providers', (req, res) => res.json(crm.list()));

// --------------------------------------------------------- integrações ------

router.get('/', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'select * from public.integrations where client_id = $1 order by created_at desc',
    [req.user.clientId]
  );
  // Nunca devolve credencial em claro para o navegador
  res.json(rows.map(r => ({ ...r, credentials: cryptoLib.maskObject(r.credentials) })));
}));

router.post('/', asyncH(async (req, res) => {
  const { provider, label, credentials, config, field_map, events: evts, direction } = req.body || {};
  const adapter = crm.get(provider);
  if (!adapter) return res.status(400).json({ error: 'Integração desconhecida' });

  const faltando = (adapter.campos || [])
    .filter(c => c.obrigatorio && !credentials?.[c.nome] && !config?.[c.nome])
    .map(c => c.label);
  if (faltando.length) return res.status(400).json({ error: `Faltou preencher: ${faltando.join(', ')}` });

  // Valida a credencial ANTES de salvar — descobrir que o token está errado
  // só na primeira venda perdida é caro demais.
  if (adapter.test) {
    try {
      await adapter.test({ ...config, ...credentials });
    } catch (e) {
      return res.status(400).json({ error: `Não consegui conectar: ${e.message}` });
    }
  }

  const { rows } = await pool.query(
    `insert into public.integrations (client_id, provider, label, credentials, config, field_map, events, direction)
     values ($1,$2,$3,$4,$5,$6, coalesce($7, array['lead.created','lead.qualified','lead.won','handoff.requested']), coalesce($8,'outbound'))
     returning *`,
    [req.user.clientId, provider, label || adapter.label,
     JSON.stringify(cryptoLib.encryptObject(credentials || {})),
     JSON.stringify(config || {}), JSON.stringify(field_map || {}),
     Array.isArray(evts) && evts.length ? evts : null, direction || null]
  );
  res.json({ ...rows[0], credentials: cryptoLib.maskObject(rows[0].credentials) });
}));

router.put('/:id', asyncH(async (req, res) => {
  const { label, credentials, config, field_map, events: evts, active } = req.body || {};
  const atual = await pool.query('select * from public.integrations where id = $1 and client_id = $2',
    [req.params.id, req.user.clientId]);
  if (!atual.rows[0]) return res.status(404).json({ error: 'Integração não encontrada' });

  // Campos mascarados (••••) voltam do formulário sem alteração: mantém o valor
  // salvo em vez de gravar a máscara por cima do segredo.
  const novasCreds = { ...atual.rows[0].credentials };
  for (const [k, v] of Object.entries(credentials || {})) {
    if (typeof v === 'string' && v.includes('•')) continue;
    novasCreds[k] = v ? cryptoLib.encrypt(v) : v;
  }

  const { rows } = await pool.query(
    `update public.integrations set
       label = coalesce($1, label), credentials = $2,
       config = coalesce($3, config), field_map = coalesce($4, field_map),
       events = coalesce($5, events), active = coalesce($6, active)
     where id = $7 and client_id = $8 returning *`,
    [label ?? null, JSON.stringify(novasCreds),
     config ? JSON.stringify(config) : null, field_map ? JSON.stringify(field_map) : null,
     Array.isArray(evts) && evts.length ? evts : null, active ?? null,
     req.params.id, req.user.clientId]
  );
  res.json({ ...rows[0], credentials: cryptoLib.maskObject(rows[0].credentials) });
}));

router.delete('/:id', asyncH(async (req, res) => {
  await pool.query('delete from public.integrations where id = $1 and client_id = $2',
    [req.params.id, req.user.clientId]);
  res.json({ ok: true });
}));

/** Envia um lead de teste para conferir se chega do outro lado. */
router.post('/:id/test', asyncH(async (req, res) => {
  const { rows } = await pool.query('select * from public.integrations where id = $1 and client_id = $2',
    [req.params.id, req.user.clientId]);
  const integration = rows[0];
  if (!integration) return res.status(404).json({ error: 'Integração não encontrada' });

  const { rows: leads } = await pool.query(
    'select phone from public.leads where client_id = $1 order by last_inbound_at desc nulls last limit 1',
    [req.user.clientId]
  );
  if (!leads[0]) return res.status(400).json({ error: 'Você ainda não tem nenhum lead para usar como teste' });

  const resultado = await crm.push(integration, 'lead.qualified', {
    clientId: req.user.clientId, phone: leads[0].phone
  });
  res.json(resultado.ok
    ? { ok: true, mensagem: 'Lead de teste enviado. Confira no seu CRM.', detalhe: resultado }
    : { ok: false, error: resultado.error });
}));

router.get('/:id/logs', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `select event, phone, status, http_status, response_body, attempts, created_at
       from public.integration_log
      where client_id = $1 and integration_id = $2
      order by created_at desc limit 50`,
    [req.user.clientId, req.params.id]
  );
  res.json(rows);
}));

// ------------------------------------------------------- chaves de API ------

router.get('/api-keys/list', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'select id, name, key_prefix, scopes, last_used_at, revoked, created_at from public.api_keys where client_id = $1 order by created_at desc',
    [req.user.clientId]
  );
  res.json(rows);
}));

router.post('/api-keys', asyncH(async (req, res) => {
  const { name, scopes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Dê um nome para a chave (ex: "Integração do site")' });

  const permitidos = ['leads:read', 'leads:write', 'messages:send', 'conversations:read'];
  const escopos = Array.isArray(scopes) && scopes.length
    ? scopes.filter(s => permitidos.includes(s))
    : permitidos;

  const gerada = cryptoLib.generateApiKey();
  await pool.query(
    'insert into public.api_keys (client_id, name, key_prefix, key_hash, scopes) values ($1,$2,$3,$4,$5)',
    [req.user.clientId, name, gerada.keyPrefix, gerada.keyHash, escopos]
  );

  // A chave em claro aparece UMA vez. Depois só existe o hash.
  res.json({
    key: gerada.key,
    key_prefix: gerada.keyPrefix,
    scopes: escopos,
    aviso: 'Copie agora — esta chave não será exibida novamente.'
  });
}));

router.delete('/api-keys/:id', asyncH(async (req, res) => {
  await pool.query('update public.api_keys set revoked = true where id = $1 and client_id = $2',
    [req.params.id, req.user.clientId]);
  res.json({ ok: true });
}));

// ------------------------------------------------ webhooks de saída ---------

router.get('/webhooks/list', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'select id, url, events, active, failure_count, created_at from public.webhook_endpoints where client_id = $1',
    [req.user.clientId]
  );
  res.json(rows);
}));

router.post('/webhooks', asyncH(async (req, res) => {
  const { url, events: evts } = req.body || {};
  if (!/^https:\/\//.test(url || '')) {
    return res.status(400).json({ error: 'Informe uma URL https:// válida' });
  }
  const secret = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `insert into public.webhook_endpoints (client_id, url, secret, events)
     values ($1,$2,$3, coalesce($4, array['lead.created','lead.qualified','lead.won','handoff.requested','message.received']))
     returning id, url, events, active`,
    [req.user.clientId, url, secret, Array.isArray(evts) && evts.length ? evts : null]
  );
  res.json({
    ...rows[0],
    secret,
    aviso: 'Guarde este segredo: use-o para validar o header X-ConversIA-Signature. Não será exibido de novo.'
  });
}));

router.delete('/webhooks/:id', asyncH(async (req, res) => {
  await pool.query('delete from public.webhook_endpoints where id = $1 and client_id = $2',
    [req.params.id, req.user.clientId]);
  res.json({ ok: true });
}));

module.exports = router;
