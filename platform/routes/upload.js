const express = require('express');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Recebe um arquivo em base64 e sobe pro Vercel Blob, retornando uma URL pública.
// Usado tanto pro anexo na conversa quanto no follow-up de resgate.
router.post('/', async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(400).json({
      error: 'Upload de arquivo não configurado. Adicione um Vercel Blob Store ao projeto (Storage → Blob) ou use "colar link" como alternativa.'
    });
  }
  const { filename, dataBase64, contentType } = req.body || {};
  if (!filename || !dataBase64) return res.status(400).json({ error: 'Arquivo inválido' });

  try {
    const { put } = require('@vercel/blob');
    const buffer = Buffer.from(dataBase64, 'base64');
    const blob = await put(`uploads/${req.user.clientId}/${Date.now()}-${filename}`, buffer, {
      access: 'public',
      contentType: contentType || 'application/octet-stream'
    });
    res.json({ url: blob.url });
  } catch (e) {
    res.status(500).json({ error: 'Falha ao subir o arquivo', detail: String(e) });
  }
});

module.exports = router;
