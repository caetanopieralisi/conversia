// Uso: node create-user.js <client_id> <email> <senha> <nome>
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function main() {
  const [clientId, email, password, name] = process.argv.slice(2);
  if (!clientId || !email || !password) {
    console.log('Uso: node create-user.js <client_id> <email> <senha> [nome]');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `insert into public.users (client_id, email, password_hash, name)
     values ($1, $2, $3, $4)
     on conflict (email) do update set password_hash = excluded.password_hash`,
    [clientId, email, hash, name || null]
  );
  console.log(`Usuário ${email} criado/atualizado para o cliente ${clientId}.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
