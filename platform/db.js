require('dotenv').config();
const { Pool } = require('pg');

// Duas formas de configurar, nessa ordem de preferência:
//
//   1. DATABASE_URL — a "Connection string" que o Supabase te dá pronta, em
//      uma linha só. É o caminho curto: uma variável em vez de seis.
//      Use a do modo "Transaction pooler" (porta 6543): em serverless cada
//      invocação abre conexão própria, e sem pooler o banco fica sem conexões.
//
//   2. PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD — campo a campo,
//      para quem já tem as variáveis separadas.
//
// max baixo pelo mesmo motivo: um pool grande em serverless esgota o Postgres.

const url = (process.env.DATABASE_URL || '').trim();

// max 8, não 3: o orquestrador abre CINCO consultas em Promise.all logo na
// primeira etapa (cliente, estado, lead, arquivos, histórico). Com pool de 3,
// duas ficam esperando vaga e estouram o connectionTimeout — o erro aparece
// como "timeout exceeded when trying to connect", que parece banco fora do ar
// e na verdade é contenção interna. Aconteceu em produção.
//
// 8 continua conservador para serverless: o pooler do Supabase aguenta bem mais,
// e cada invocação encerra seu pool ao terminar.
const comuns = {
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000
};

// Supabase e a maioria dos provedores gerenciados usam certificado que o Node
// não valida por padrão. SSL continua ligado; só a validação da cadeia cai.
const ssl = { rejectUnauthorized: false };

// Banco local (Docker na VPS, desenvolvimento) não fala SSL. Desligue com
// PGSSL=false ou com ?sslmode=disable na própria URL.
const semSsl = process.env.PGSSL === 'false' || /[?&]sslmode=disable\b/.test(url);

const pool = url
  ? new Pool({ connectionString: url, ssl: semSsl ? false : ssl, ...comuns })
  : new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'postgres',
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: process.env.PGSSL === 'false' ? false : ssl,
      ...comuns
    });

module.exports = pool;
