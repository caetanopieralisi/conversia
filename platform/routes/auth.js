const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Informe email e senha' });

  const { rows } = await pool.query('select * from public.users where email = $1', [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });

  const clientRes = await pool.query('select * from public.clients where client_id = $1', [user.client_id]);
  const client = clientRes.rows[0];

  const token = jwt.sign(
    { userId: user.id, clientId: user.client_id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: { email: user.email, name: user.name, role: user.role },
    client: client ? { client_id: client.client_id, nome_empresa: client.nome_empresa, nicho: client.nicho } : null
  });
});

module.exports = router;
