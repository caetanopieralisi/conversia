// =============================================================================
// Criptografia de credenciais em repouso (AES-256-GCM).
//
// Sem isso, o token de HubSpot/Pipedrive de cada cliente ficaria em texto puro
// numa coluna jsonb — e qualquer backup, dump ou acesso de leitura ao banco
// entregaria as credenciais de TODOS os clientes de uma vez.
//
// GCM (e não CBC) porque ele autentica: um valor adulterado no banco falha na
// descriptografia em vez de virar lixo silencioso.
// =============================================================================

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function key() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY não configurada. Gere uma com: openssl rand -hex 32 ' +
      'e adicione às variáveis de ambiente.'
    );
  }
  // aceita hex de 64 chars ou qualquer string (derivada por sha256)
  return /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : crypto.createHash('sha256').update(raw).digest();
}

/** @returns {string} "enc:<iv>:<tag>:<ciphertext>" em base64 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value;
  const [, ivB64, tagB64, dataB64] = value.split(':');
  try {
    const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[crypto] falha ao descriptografar (ENCRYPTION_KEY mudou?):', e.message);
    return null;
  }
}

/** Criptografa todos os valores string de um objeto de credenciais. */
function encryptObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = typeof v === 'string' && v ? encrypt(v) : v;
  }
  return out;
}

/** Versão mascarada para exibir no painel sem expor o segredo. */
function maskObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'string' && v.startsWith('enc:')) {
      const plain = decrypt(v);
      out[k] = plain ? `${plain.slice(0, 4)}${'•'.repeat(Math.max(4, Math.min(16, plain.length - 8)))}${plain.slice(-4)}` : '••••';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Gera uma chave de API pública: devolve a chave em claro e o hash a guardar. */
function generateApiKey(prefix = 'cvia') {
  const secret = crypto.randomBytes(24).toString('base64url');
  const full = `${prefix}_${secret}`;
  return {
    key: full,
    keyPrefix: full.slice(0, 12),
    keyHash: crypto.createHash('sha256').update(full).digest('hex')
  };
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

module.exports = { encrypt, decrypt, encryptObject, maskObject, generateApiKey, hashApiKey };
