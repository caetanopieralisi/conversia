// =============================================================================
// Ferramentas do agente (function calling).
//
// Sem isso, o agente só sabe escrever texto — que é exatamente a limitação do
// workflow atual. Com isso ele age: manda o catálogo, registra o dado que
// descobriu, chama um humano, avança o estágio da venda.
//
// Cada ferramenta:
//   - tem um schema declarado (o que o LLM vê)
//   - tem um handler (o que roda de verdade, com acesso a banco e WhatsApp)
//   - devolve um resultado curto em texto, porque é isso que volta pro modelo
//   - devolve efeitos colaterais em `ctx.effects`, que o orquestrador executa
//     DEPOIS — assim nada é enviado ao cliente antes da resposta ficar pronta
// =============================================================================

const pool = require('../../db');
const rag = require('./rag');
const events = require('../events');

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const SCHEMAS = {
  buscar_conhecimento: {
    name: 'buscar_conhecimento',
    description:
      'Busca informação nos documentos da empresa (preços, políticas, produtos, prazos, processos). ' +
      'Use quando a pergunta for específica e o contexto que você recebeu não a cobrir. ' +
      'Sempre use isto antes de dizer que não sabe.',
    parameters: {
      type: 'object',
      properties: {
        pergunta: {
          type: 'string',
          description:
            'A busca, reformulada com os termos que a empresa usaria nos documentos dela. ' +
            'Ex: em vez de "é caro?", busque "preço plano valor mensalidade".'
        }
      },
      required: ['pergunta']
    }
  },

  registrar_informacao: {
    name: 'registrar_informacao',
    description:
      'Registra um dado que você descobriu sobre a pessoa (nome, empresa, e-mail, necessidade, ' +
      'orçamento, prazo, produto de interesse...). Chame assim que descobrir, junto com sua resposta. ' +
      'Isso alimenta o CRM e evita que você pergunte a mesma coisa duas vezes.',
    parameters: {
      type: 'object',
      properties: {
        dados: {
          type: 'object',
          description: 'Pares campo/valor. Ex: {"nome":"Marina","empresa":"Acme","prazo":"este mês"}',
          additionalProperties: { type: 'string' }
        }
      },
      required: ['dados']
    }
  },

  enviar_arquivo: {
    name: 'enviar_arquivo',
    description:
      'Envia um arquivo da biblioteca da empresa (catálogo, tabela de preços, portfólio, contrato ' +
      'modelo) pelo WhatsApp. Use quando o material ajudar a pessoa a decidir — não como substituto ' +
      'de uma resposta que você consegue dar em texto.',
    parameters: {
      type: 'object',
      properties: {
        arquivo_id: { type: 'integer', description: 'O id do arquivo, da lista que você recebeu' },
        mensagem: {
          type: 'string',
          description: 'Uma frase curta dizendo o que está mandando e por quê. Vai como legenda.'
        }
      },
      required: ['arquivo_id']
    }
  },

  transferir_humano: {
    name: 'transferir_humano',
    description:
      'Passa a conversa para uma pessoa do time e para de responder. Use nos gatilhos definidos: ' +
      'pedido explícito, reclamação, negociação de valor, ou pergunta que trava a decisão e você não sabe.',
    parameters: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Por que está transferindo (o time lê isso)' },
        urgencia: { type: 'string', enum: ['normal', 'alta'], description: 'alta = precisa de atenção agora' },
        resumo: { type: 'string', description: 'Resumo do que já foi conversado, para o humano não recomeçar do zero' }
      },
      required: ['motivo']
    }
  },

  marcar_estagio: {
    name: 'marcar_estagio',
    description:
      'Atualiza em que fase da venda a conversa está. Chame quando mudar de fase de verdade.',
    parameters: {
      type: 'object',
      properties: {
        estagio: {
          type: 'string',
          enum: ['abertura', 'descoberta', 'apresentacao', 'objecao', 'fechamento', 'pos_venda'],
          description: 'A fase atual'
        },
        motivo: { type: 'string', description: 'O que na conversa indicou essa mudança' }
      },
      required: ['estagio']
    }
  }
};

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

const HANDLERS = {
  async buscar_conhecimento({ pergunta }, ctx) {
    if (!pergunta?.trim()) return 'Busca vazia.';
    const { chunks, usage } = await rag.search(ctx.client.client_id, pergunta, { limit: 5 });
    if (usage) ctx.usage.push(usage);
    ctx.trace.push({ tool: 'buscar_conhecimento', query: pergunta, hits: chunks.length });

    if (!chunks.length) {
      return 'Nada encontrado nos documentos da empresa sobre isso. Você NÃO tem essa informação — ' +
             'não invente. Diga que vai confirmar com o time, ou transfira se a pessoa precisar agora.';
    }
    return 'Encontrado nos documentos da empresa:\n\n' + rag.formatContext(chunks);
  },

  async registrar_informacao({ dados }, ctx) {
    if (!dados || typeof dados !== 'object') return 'Nada para registrar.';

    // Só aceita valores escalares — evita que o modelo enfie um objeto aninhado
    // na coluna e quebre o painel na hora de exibir.
    const limpo = {};
    for (const [k, v] of Object.entries(dados)) {
      if (v === null || v === undefined || v === '') continue;
      const chave = String(k).slice(0, 60).toLowerCase().replace(/[^a-z0-9_]/g, '_');
      limpo[chave] = typeof v === 'object' ? JSON.stringify(v).slice(0, 500) : String(v).slice(0, 500);
    }
    if (!Object.keys(limpo).length) return 'Nada para registrar.';

    ctx.collected = { ...ctx.collected, ...limpo };

    await pool.query(
      `update public.conversation_state
          set collected = coalesce(collected, '{}'::jsonb) || $3::jsonb, updated_at = now()
        where client_id = $1 and phone = $2`,
      [ctx.client.client_id, ctx.phone, JSON.stringify(limpo)]
    );

    // Campos canônicos também sobem para colunas próprias do lead — é isso que
    // faz o CRM e os filtros do painel funcionarem sem parsear JSON.
    const nome = limpo.nome || limpo.name;
    const email = limpo.email || limpo.e_mail;
    await pool.query(
      `update public.leads
          set qualification = coalesce(qualification, '{}'::jsonb) || $3::jsonb,
              name  = coalesce(nullif($4,''), name),
              email = coalesce(nullif($5,''), email)
        where client_id = $1 and phone = $2`,
      [ctx.client.client_id, ctx.phone, JSON.stringify(limpo), nome || '', email || '']
    );

    ctx.trace.push({ tool: 'registrar_informacao', campos: Object.keys(limpo) });

    // Qualificou? Dispara o evento (que sincroniza CRM e webhooks).
    if (!ctx.state.qualifiedFired && isQualified(ctx.client.playbook, ctx.collected)) {
      ctx.state.qualifiedFired = true;
      ctx.effects.push({
        type: 'event',
        event: 'lead.qualified',
        payload: { qualification: ctx.collected }
      });
    }

    return `Registrado: ${Object.keys(limpo).join(', ')}.`;
  },

  async enviar_arquivo({ arquivo_id, mensagem }, ctx) {
    const { rows } = await pool.query(
      'select * from public.assets where id = $1 and client_id = $2 and active = true',
      [arquivo_id, ctx.client.client_id]
    );
    const asset = rows[0];
    if (!asset) {
      const { rows: disp } = await pool.query(
        'select id, name from public.assets where client_id = $1 and active = true',
        [ctx.client.client_id]
      );
      return disp.length
        ? `Arquivo ${arquivo_id} não existe. Disponíveis: ${disp.map(a => `${a.id}=${a.name}`).join(', ')}.`
        : 'Esta empresa não tem arquivos cadastrados. Responda com texto.';
    }

    // Não envia duas vezes o mesmo arquivo na mesma conversa: repetir material
    // é um dos comportamentos que mais denunciam um bot.
    if (ctx.sentAssets.has(asset.id)) {
      return `O arquivo "${asset.name}" já foi enviado nesta conversa. Não mande de novo — ` +
             `pergunte se a pessoa conseguiu ver ou siga a conversa.`;
    }
    ctx.sentAssets.add(asset.id);

    ctx.effects.push({ type: 'asset', asset, caption: mensagem || '' });
    ctx.trace.push({ tool: 'enviar_arquivo', asset: asset.name });

    return `Arquivo "${asset.name}" será enviado logo após sua mensagem. ` +
           `Não descreva o arquivo em detalhe no texto — ele já vai junto.`;
  },

  async transferir_humano({ motivo, urgencia, resumo }, ctx) {
    ctx.handoff = { motivo, urgencia: urgencia || 'normal', resumo: resumo || '' };
    ctx.effects.push({ type: 'handoff', motivo, urgencia: urgencia || 'normal', resumo: resumo || '' });
    ctx.trace.push({ tool: 'transferir_humano', motivo, urgencia });
    return 'Time avisado. Diga à pessoa, em uma frase, que alguém vai assumir — e pare por aqui.';
  },

  async marcar_estagio({ estagio, motivo }, ctx) {
    const validos = ['abertura', 'descoberta', 'apresentacao', 'objecao', 'fechamento', 'pos_venda'];
    if (!validos.includes(estagio)) return `Estágio inválido. Use: ${validos.join(', ')}.`;

    const anterior = ctx.state.stage;
    ctx.state.stage = estagio;
    await pool.query(
      `update public.conversation_state set stage = $3, updated_at = now()
        where client_id = $1 and phone = $2`,
      [ctx.client.client_id, ctx.phone, estagio]
    );
    await pool.query(
      'update public.leads set stage = $3 where client_id = $1 and phone = $2',
      [ctx.client.client_id, ctx.phone, estagio]
    );

    if (anterior !== estagio) {
      await events.record(ctx.client.client_id, ctx.phone, 'stage.changed', { de: anterior, para: estagio, motivo });
    }
    ctx.trace.push({ tool: 'marcar_estagio', estagio });
    return `Estágio: ${estagio}.`;
  }
};

// -----------------------------------------------------------------------------

/**
 * Avalia o critério de qualificação do playbook.
 * O critério é uma expressão simples ("necessidade e prazo e (email ou empresa)")
 * — deliberadamente NÃO é eval: é um parser de and/or/parênteses sobre nomes de
 * campo. Playbook é dado editável pelo cliente; nunca vira código executável.
 */
function isQualified(playbook, coletado = {}) {
  const criterio = playbook?.criterio_qualificado;
  if (!criterio) {
    const obrig = (playbook?.perguntas_qualificacao || []).filter(p => p.obrigatorio);
    if (!obrig.length) return false;
    return obrig.every(p => !!coletado[p.campo]);
  }

  const tokens = String(criterio)
    .toLowerCase()
    .replace(/\(/g, ' ( ').replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter(Boolean);

  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];
  const isOr = t => t === 'ou' || t === 'or' || t === '||';
  const isAnd = t => t === 'e' || t === 'and' || t === '&&';

  // Gramática:  expr := and ( 'ou' and )*  |  and := atom ( 'e' atom )*
  //             atom := '(' expr ')' | 'nao' atom | <campo>
  // Sem curto-circuito de propósito: o parser precisa consumir os dois lados
  // para não deixar tokens órfãos, e avaliar um campo não tem efeito colateral.
  function expr() {
    let value = and();
    while (isOr(peek())) { eat(); value = and() || value; }
    return value;
  }
  function and() {
    let value = atom();
    while (isAnd(peek())) { eat(); value = atom() && value; }
    return value;
  }
  function atom() {
    const t = eat();
    if (t === undefined) return false;
    if (t === '(') { const v = expr(); if (peek() === ')') eat(); return v; }
    if (t === 'nao' || t === 'não' || t === 'not') return !atom();
    const v = coletado[t];
    return v !== undefined && v !== null && String(v).trim() !== '';
  }

  try {
    return expr();
  } catch {
    return false;
  }
}

/** Devolve os schemas das ferramentas disponíveis para este cliente. */
function schemasFor(client, assets = []) {
  const list = [SCHEMAS.buscar_conhecimento, SCHEMAS.registrar_informacao, SCHEMAS.marcar_estagio];
  if (assets.length) list.push(SCHEMAS.enviar_arquivo);
  if (client.numero_responsavel || client.owner_phone) list.push(SCHEMAS.transferir_humano);
  return list;
}

async function run(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return `Ferramenta "${name}" não existe.`;
  try {
    return await handler(args || {}, ctx);
  } catch (e) {
    console.error(`[tools] ${name} falhou:`, e);
    // Devolve o erro AO MODELO em vez de estourar: ele consegue seguir a conversa
    // sem a ferramenta, o que é muito melhor que o cliente ficar sem resposta.
    return `A ferramenta ${name} falhou (${e.message}). Siga a conversa sem ela.`;
  }
}

module.exports = { SCHEMAS, schemasFor, run, isQualified };
