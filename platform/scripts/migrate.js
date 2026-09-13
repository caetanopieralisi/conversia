#!/usr/bin/env node
// Aplica os arquivos de schema em ordem, uma vez cada, registrando o que já rodou.
//   npm run migrate
// Idempotente: rodar de novo não faz nada.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db');

const ORDEM = [
  'schema_00_base.sql',
  'schema_platform.sql',
  'schema_platform_v2.sql',
  'schema_platform_v3.sql',
  'schema_platform_v4.sql',
  'schema_platform_v5.sql',
  'schema_platform_v6.sql',
  'schema_platform_v7.sql'
];

async function main() {
  const raiz = path.join(__dirname, '..');

  await pool.query(`
    create table if not exists public.schema_migrations (
      arquivo   text primary key,
      hash      text not null,
      aplicado_em timestamptz default now()
    )`);

  const { rows } = await pool.query('select arquivo, hash from public.schema_migrations');
  const aplicadas = new Map(rows.map(r => [r.arquivo, r.hash]));

  let novas = 0;
  for (const arquivo of ORDEM) {
    const caminho = path.join(raiz, arquivo);
    if (!fs.existsSync(caminho)) {
      console.log(`  ⊘ ${arquivo} (não encontrado, pulando)`);
      continue;
    }
    const sql = fs.readFileSync(caminho, 'utf8');
    const hash = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 12);

    if (aplicadas.has(arquivo)) {
      if (aplicadas.get(arquivo) !== hash) {
        console.log(`  ⚠ ${arquivo} MUDOU desde que foi aplicado (${aplicadas.get(arquivo)} → ${hash}).`);
        console.log('     Migrações já aplicadas não são reexecutadas. Crie um arquivo novo para a mudança.');
      } else {
        console.log(`  ✓ ${arquivo} (já aplicado)`);
      }
      continue;
    }

    process.stdout.write(`  → ${arquivo} ... `);
    try {
      await pool.query(sql);
      await pool.query(
        'insert into public.schema_migrations (arquivo, hash) values ($1,$2) on conflict (arquivo) do update set hash = $2',
        [arquivo, hash]
      );
      console.log('ok');
      novas++;
    } catch (e) {
      console.log('FALHOU');
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
  }

  console.log(novas ? `\n${novas} migração(ões) aplicada(s).` : '\nBanco já estava atualizado.');

  // Diagnóstico útil logo após migrar
  const { rows: check } = await pool.query(`
    select
      (select count(*) from public.clients)::int as clientes,
      (select count(*) from public.clients where inbound_token is not null)::int as com_token,
      (select exists(select 1 from pg_extension where extname='vector')) as pgvector,
      (select count(*) from public.playbook_templates)::int as templates`);
  const c = check[0];
  console.log(`\nEstado: ${c.clientes} cliente(s), ${c.com_token} com token de webhook, ` +
              `${c.templates} template(s) de playbook.`);
  console.log(`Busca vetorial: ${c.pgvector ? 'pgvector ativo (rápido)' : 'fallback jsonb (funciona; ative pgvector se a base crescer)'}`);

  if (!process.env.ENCRYPTION_KEY) {
    console.log('\n⚠ ENCRYPTION_KEY não está definida — as credenciais de CRM não poderão ser salvas.');
    console.log('  Gere uma com: openssl rand -hex 32');
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
