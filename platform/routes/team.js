const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Apenas o dono da conta pode gerenciar a equipe' });
  next();
}

router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    'select id, email, name, role, created_at from public.users where client_id = $1 order by created_at asc',
    [clientId]
  );
  res.json(rows);
});

// Convida um novo atendente (gera senha temporária e retorna pra ser repassada)
router.post('/', requireOwner, async (req, res) => {
  const { clientId } = req.user;
  const { email, name, role } = req.body || {};
  if (!email) return res.status(400).json({ error: 'E-mail é obrigatório' });
  const tempPassword = crypto.randomBytes(4).toString('hex');
  const hash = await bcrypt.hash(tempPassword, 10);

  try {
    const { rows } = await pool.query(
      `insert into public.users (client_id, email, password_hash, name, role)
       values ($1, $2, $3, $4, $5) returning id, email, name, role`,
      [clientId, email, hash, name || null, role === 'owner' ? 'owner' : 'agent']
    );
    res.json({ ...rows[0], temp_password: tempPassword });
  } catch (e) {
    if (String(e).includes('duplicate')) return res.status(409).json({ error: 'Já existe um usuário com esse e-mail' });
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

router.delete('/:id', requireOwner, async (req, res) => {
  const { clientId } = req.user;
  await pool.query('delete from public.users where id = $1 and client_id = $2', [req.params.id, clientId]);
  res.json({ ok: true });
});

module.exports = router;
