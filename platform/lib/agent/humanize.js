// =============================================================================
// Transforma a saída do modelo em mensagens de WhatsApp críveis.
//
// O workflow atual fazia: texto.split(/\n\n+/) e um Wait proporcional ao tamanho.
// Isso deixa passar tudo que denuncia um bot: markdown, blocos de 8 linhas,
// listas com hífen, "Prezado cliente". Aqui a saída é limpa e fatiada.
// =============================================================================

const MAX_BUBBLE = 320;   // acima disso vira parede de texto na tela do celular
const MIN_BUBBLE = 2;

/** Remove marcação que não existe no WhatsApp e vícios de e-mail. */
function clean(text) {
  let t = String(text || '');

  t = t.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, '').trim()); // blocos de código
  t = t.replace(/^#{1,6}\s+/gm, '');                                          // títulos markdown
  t = t.replace(/\*\*(.+?)\*\*/g, '*$1*');                                    // **negrito** -> *negrito* (sintaxe real do WhatsApp)
  t = t.replace(/__(.+?)__/g, '$1');
  t = t.replace(/^\s*[-*+]\s+/gm, '');                                        // marcadores de lista
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');                                      // listas numeradas
  t = t.replace(/\[(\d+)\]/g, '');                                            // citações [1] do RAG
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2');             // links markdown
  t = t.replace(/^(Prezad[oa]|Car[oa])\b.*$/gim, '');
  t = t.replace(/^(Atenciosamente|Att\.?|Cordialmente|Abraços)[,.]?\s*$/gim, '');
  t = t.replace(/\bHANDOFF_SOLICITADO\b/g, '');                               // marcador legado do prompt antigo
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Divide o texto em bolhas.
 * Prioridade: parágrafo em branco > frase, respeitando o tamanho máximo.
 */
function split(text, { maxBubbles = 4, maxLen = MAX_BUBBLE } = {}) {
  const cleaned = clean(text);
  if (!cleaned) return [];

  let parts = cleaned.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length >= MIN_BUBBLE);

  // Quebra o que ficou grande demais, em fronteira de frase
  const out = [];
  for (const part of parts) {
    if (part.length <= maxLen) { out.push(part); continue; }
    const sentences = part.match(/[^.!?…]+[.!?…]+["')\]]*\s*|.+$/g) || [part];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > maxLen && buf) { out.push(buf.trim()); buf = s; }
      else buf += s;
    }
    if (buf.trim()) out.push(buf.trim());
  }

  // Junta FRAGMENTOS com a bolha seguinte — não frases curtas completas.
  // "Oi!" sozinho parece bot; "Oi, tudo bem?" seguido de outra mensagem é
  // exatamente como uma pessoa digita. O critério é ser um fragmento:
  // ou muito curto (<6), ou curto e sem pontuação final.
  const isFragmento = s =>
    s.length < 6 || (s.length < 14 && !/[.!?…]$/.test(s));

  const merged = [];
  for (const b of out) {
    const last = merged[merged.length - 1];
    if (last && isFragmento(last) && (last + '\n' + b).length <= maxLen) {
      merged[merged.length - 1] = last + '\n' + b;
    } else {
      merged.push(b);
    }
  }

  // Excesso de bolhas: junta as últimas. Ninguém manda 7 mensagens seguidas.
  while (merged.length > maxBubbles) {
    const penultimate = merged.length - 2;
    merged[penultimate] = merged[penultimate] + '\n\n' + merged.pop();
  }

  return merged.filter(Boolean);
}

/**
 * Quanto tempo "digitando..." antes de cada bolha.
 * ~45 caracteres/segundo é um digitador rápido no celular. Limitado entre 1,2s e
 * 5s: mais que isso a pessoa acha que caiu, menos parece máquina.
 */
function typingDelay(text, { cps = 45, min = 1200, max = 5000 } = {}) {
  return Math.round(Math.min(max, Math.max(min, (String(text).length / cps) * 1000)));
}

module.exports = { clean, split, typingDelay, MAX_BUBBLE };
