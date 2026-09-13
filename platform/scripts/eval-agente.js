#!/usr/bin/env node
// =============================================================================
// Avaliação do agente de vendas.
//
// POR QUE ISSO EXISTE
// Mexer no prompt sem medir é chute. Uma frase nova melhora um caso e piora
// três, e ninguém percebe até um cliente reclamar. Aqui, cada cenário simula um
// cliente real conversando com o agente, e um modelo avaliador dá nota nos
// critérios que importam para VENDER — não para "responder certo".
//
// Uso:
//   OPENAI_API_KEY=... npm run eval -- --client=SEU_CLIENT_ID
//   npm run eval -- --client=X --cenario=preco   (roda um só)
//
// Consome API de verdade (custa alguns centavos por rodada). Rode antes de
// publicar mudança de playbook ou de modelo.
// =============================================================================

require('dotenv').config();
const pool = require('../db');
const orchestrator = require('../lib/agent/orchestrator');
const llm = require('../lib/llm');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, '').split('='))
);
const CLIENT_ID = args.client;
const SO_CENARIO = args.cenario;

// -----------------------------------------------------------------------------
// Cenários — cada um é um cliente difícil de um jeito diferente
// -----------------------------------------------------------------------------

const CENARIOS = [
  {
    id: 'descoberta',
    nome: 'Cliente vago — o agente investiga antes de apresentar?',
    turnos: ['oi', 'queria saber mais sobre vocês', 'é pra minha empresa'],
    criterios: [
      'Fez perguntas para entender a necessidade antes de apresentar solução ou preço',
      'Fez no máximo UMA pergunta por mensagem',
      'Demonstrou ter entendido o que a pessoa falou antes de seguir',
      'Nenhuma mensagem passou de 4 linhas'
    ]
  },
  {
    id: 'preco',
    nome: 'Pergunta de preço — inventa valor ou confirma?',
    turnos: ['quanto custa?', 'me dá um valor aproximado pelo menos', 'qualquer faixa serve'],
    criterios: [
      'NÃO inventou nenhum valor que não esteja na base de conhecimento',
      'Se não sabia o preço, disse que vai confirmar em vez de estimar',
      'Não travou a conversa: ofereceu um próximo passo mesmo sem dar o valor'
    ],
    critico: true   // falhar aqui é o erro mais caro que o agente pode cometer
  },
  {
    id: 'objecao',
    nome: 'Objeção de preço — acolhe e responde, ou discute?',
    turnos: ['achei caro', 'vi outro lugar mais barato', 'me convence então'],
    criterios: [
      'Acolheu a objeção antes de responder (não partiu para a defensiva)',
      'Respondeu com argumento concreto de valor, não com desconto',
      'Devolveu a conversa para um próximo passo',
      'Não soou agressivo nem insistente'
    ]
  },
  {
    id: 'material',
    nome: 'Pedido de material — usa a ferramenta de enviar arquivo?',
    turnos: ['vocês têm um catálogo?', 'pode me mandar?'],
    criterios: [
      'Ofereceu ou enviou material de apoio quando fazia sentido',
      'Explicou em uma frase o que estava mandando'
    ],
    exigeFerramenta: 'enviar_arquivo'
  },
  {
    id: 'handoff',
    nome: 'Pedido explícito de humano — transfere sem enrolar?',
    turnos: ['quero falar com uma pessoa de verdade', 'agora, por favor'],
    criterios: [
      'Transferiu para um humano em vez de insistir em resolver sozinho',
      'Avisou a pessoa que alguém do time vai assumir',
      'Não pediu mais informação antes de transferir'
    ],
    exigeFerramenta: 'transferir_humano',
    critico: true
  },
  {
    id: 'fora_escopo',
    nome: 'Pergunta fora do escopo — mantém o rumo?',
    turnos: ['qual a capital da Austrália?', 'me ajuda a escrever um poema'],
    criterios: [
      'Não respondeu como um assistente genérico',
      'Redirecionou com gentileza para o assunto da empresa'
    ]
  },
  {
    id: 'qualificacao',
    nome: 'Cliente colaborativo — registra os dados que descobre?',
    turnos: [
      'oi, sou a Marina da Construtora Alvo',
      'a gente precisa contratar 5 pessoas até o fim do mês',
      'meu email é marina@alvo.com.br'
    ],
    criterios: [
      'Registrou nome, empresa e e-mail',
      'Não perguntou de novo algo que a pessoa já tinha falado',
      'Reconheceu a urgência mencionada'
    ],
    exigeFerramenta: 'registrar_informacao',
    critico: true
  },
  {
    id: 'repeticao',
    nome: 'Cliente lacônico — o agente entra em loop?',
    turnos: ['oi', 'sim', 'ok', 'aham', 'certo'],
    criterios: [
      'Não repetiu a mesma mensagem/pergunta duas vezes',
      'Mudou de abordagem ao perceber que não estava avançando',
      'Ofereceu falar com um humano ou encerrou com elegância'
    ]
  }
];

// -----------------------------------------------------------------------------

const PROMPT_AVALIADOR = `Você avalia o desempenho de um VENDEDOR que atende por WhatsApp.

Você recebe a transcrição de uma conversa e uma lista de critérios.
Para cada critério, responda "sim", "nao" ou "parcial", com uma justificativa de no máximo 15 palavras.

Seja rigoroso. Você está avaliando um vendedor profissional, não um chatbot:
- Frase longa, formal ou com marcação de texto (**negrito**, listas) = falha de estilo.
- Duas perguntas na mesma mensagem = falha.
- Apresentar solução antes de entender a necessidade = falha grave.
- Inventar preço, prazo ou condição = falha grave.

Responda SOMENTE com JSON válido:
{"criterios":[{"criterio":"...","resultado":"sim|nao|parcial","porque":"..."}],
 "nota":0-10,
 "melhor_momento":"...",
 "pior_momento":"...",
 "o_que_mudar":"a mudança mais impactante no playbook, em uma frase"}`;

async function rodarCenario(client, cenario) {
  const phone = `eval-${cenario.id}-${Date.now()}@simulador.local`;
  const transcricao = [];
  const ferramentas = [];
  let custo = 0;

  await pool.query(
    `insert into public.leads (client_id, phone, name, status, source, created_at, last_inbound_at)
     values ($1,$2,'[eval]','ativo','eval', now(), now()) on conflict do nothing`,
    [client.client_id, phone]
  );

  for (const turno of cenario.turnos) {
    transcricao.push(`CLIENTE: ${turno}`);
    await pool.query(
      `insert into public.messages (client_id, phone, direction, content, processed, created_at)
       values ($1,$2,'inbound',$3,true, now())`,
      [client.client_id, phone, turno]
    );

    let r;
    try {
      r = await orchestrator.respond({ clientId: client.client_id, phone, text: turno, dryRun: true });
    } catch (e) {
      transcricao.push(`AGENTE: [ERRO: ${e.message}]`);
      break;
    }

    for (const m of r.messages) {
      transcricao.push(`AGENTE: ${m}`);
      await pool.query(
        `insert into public.messages (client_id, phone, direction, content, processed, author, created_at)
         values ($1,$2,'outbound',$3,true,'agent', now())`,
        [client.client_id, phone, m]
      );
    }
    ferramentas.push(...(r.trace || []).filter(t => t.tool).map(t => t.tool));
    custo += (r.usage || []).reduce((s, u) => s + (u.costUsd || 0), 0);
  }

  // --- Julgamento -----------------------------------------------------------
  const avaliacao = await llm.chat({
    provider: 'openai',
    model: process.env.EVAL_MODEL || 'gpt-4.1',
    temperature: 0,
    maxTokens: 900,
    system: PROMPT_AVALIADOR,
    messages: [{
      role: 'user',
      content: `CRITÉRIOS:\n${cenario.criterios.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n` +
               `TRANSCRIÇÃO:\n${transcricao.join('\n')}`
    }]
  });

  let julgamento;
  try {
    julgamento = JSON.parse(avaliacao.content.replace(/```json?|```/g, '').trim());
  } catch {
    julgamento = { criterios: [], nota: null, erro: 'avaliador não devolveu JSON', bruto: avaliacao.content };
  }

  // Verificação objetiva de ferramenta (independe da opinião do avaliador)
  let ferramentaOk = null;
  if (cenario.exigeFerramenta) {
    ferramentaOk = ferramentas.includes(cenario.exigeFerramenta);
  }

  await pool.query('delete from public.messages where client_id = $1 and phone = $2', [client.client_id, phone]);
  await pool.query('delete from public.leads where client_id = $1 and phone = $2', [client.client_id, phone]);
  await pool.query('delete from public.conversation_state where client_id = $1 and phone = $2', [client.client_id, phone]);

  return { cenario, transcricao, ferramentas: [...new Set(ferramentas)], ferramentaOk, julgamento, custo };
}

// -----------------------------------------------------------------------------

async function main() {
  if (!CLIENT_ID) {
    console.error('Uso: npm run eval -- --client=SEU_CLIENT_ID [--cenario=preco]');
    const { rows } = await pool.query('select client_id, nome_empresa from public.clients where active order by client_id');
    console.error('\nClientes disponíveis:');
    rows.forEach(r => console.error(`  ${r.client_id}  (${r.nome_empresa})`));
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Defina OPENAI_API_KEY — a avaliação usa a API de verdade.');
    process.exit(1);
  }

  const { rows } = await pool.query('select * from public.clients where client_id = $1', [CLIENT_ID]);
  const client = rows[0];
  if (!client) { console.error(`Cliente "${CLIENT_ID}" não encontrado.`); process.exit(1); }

  const lista = SO_CENARIO ? CENARIOS.filter(c => c.id === SO_CENARIO) : CENARIOS;
  if (!lista.length) { console.error(`Cenário "${SO_CENARIO}" não existe.`); process.exit(1); }

  console.log(`\nAvaliando: ${client.nome_empresa} (${CLIENT_ID})`);
  console.log(`Modelo do agente: ${client.llm_model || 'padrão'} · Cenários: ${lista.length}\n`);
  console.log('─'.repeat(74));

  const resultados = [];
  let custoTotal = 0;

  for (const cenario of lista) {
    process.stdout.write(`\n▸ ${cenario.nome}\n`);
    const r = await rodarCenario(client, cenario);
    resultados.push(r);
    custoTotal += r.custo;

    const nota = r.julgamento.nota;
    const cor = nota >= 8 ? '\x1b[32m' : nota >= 6 ? '\x1b[33m' : '\x1b[31m';
    console.log(`  Nota: ${cor}${nota ?? '?'}/10\x1b[0m`);

    for (const c of r.julgamento.criterios || []) {
      const icone = c.resultado === 'sim' ? '\x1b[32m✓\x1b[0m'
                  : c.resultado === 'parcial' ? '\x1b[33m~\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`    ${icone} ${c.criterio}`);
      if (c.resultado !== 'sim') console.log(`        └ ${c.porque}`);
    }

    if (r.ferramentaOk !== null) {
      console.log(`    ${r.ferramentaOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ` +
                  `usou a ferramenta ${r.cenario.exigeFerramenta}` +
                  (r.ferramentas.length ? ` (usou: ${r.ferramentas.join(', ')})` : ' (nenhuma ferramenta usada)'));
    }
    if (r.julgamento.o_que_mudar) console.log(`    → ${r.julgamento.o_que_mudar}`);
  }

  // --- Resumo ---------------------------------------------------------------
  console.log('\n' + '─'.repeat(74));
  const notas = resultados.map(r => r.julgamento.nota).filter(n => typeof n === 'number');
  const media = notas.length ? notas.reduce((a, b) => a + b, 0) / notas.length : 0;

  const criticosFalhos = resultados.filter(r =>
    r.cenario.critico && (r.julgamento.nota < 7 || r.ferramentaOk === false));

  console.log(`\nMÉDIA: ${media.toFixed(1)}/10  ·  custo desta rodada: US$ ${custoTotal.toFixed(4)}`);

  if (criticosFalhos.length) {
    console.log(`\n\x1b[31mFALHAS CRÍTICAS (${criticosFalhos.length}) — resolva antes de colocar em produção:\x1b[0m`);
    criticosFalhos.forEach(r => console.log(`  • ${r.cenario.nome}`));
  } else {
    console.log('\n\x1b[32mNenhuma falha crítica.\x1b[0m');
  }

  const acoes = resultados
    .map(r => r.julgamento.o_que_mudar)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
  if (acoes.length) {
    console.log('\nO QUE AJUSTAR NO PLAYBOOK:');
    acoes.forEach(a => console.log(`  • ${a}`));
  }

  if (process.env.EVAL_VERBOSE) {
    console.log('\n\nTRANSCRIÇÕES\n' + '='.repeat(74));
    resultados.forEach(r => {
      console.log(`\n### ${r.cenario.nome}\n`);
      r.transcricao.forEach(l => console.log('  ' + l));
    });
  }

  await pool.end();
  process.exit(criticosFalhos.length ? 1 : 0);   // falha o CI se um crítico quebrou
}

main().catch(e => { console.error(e); process.exit(1); });
