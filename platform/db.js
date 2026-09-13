require('dotenv').config();
const { Pool } = require('pg');

// max baixo porque em serverless (Vercel) cada invocacao pode abrir sua propria
// conexao — um pool grande aqui pode esgotar as conexoes do Postgres sob trafego.
// Se a Cloudify oferecer um endpoint com PgBouncer/connection pooling, use ele aqui.
const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 3),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

module.exports = pool;
