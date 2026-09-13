// Testes das funções puras — as que decidem o comportamento do agente e que,
// se quebrarem, quebram silenciosamente em produção.
//   node --test test/

const { test } = require('node:test');
const assert = require('node:assert');

const humanize = require('../lib/agent/humanize');
const guardrails = require('../lib/agent/guardrails');
const { isQualified } = require('../lib/agent/tools');
const salesPrompt = require('../lib/agent/salesPrompt');
const { rrf, cosine } = require('../lib/agent/rag');
const evolution = require('../lib/evolution');

// ---------------------------------------------------------------- humanize --

test('humanize: remove markdown que não existe no WhatsApp', () => {
  const out = humanize.clean('## Título\n\n- item um\n- item dois\n\n**Importante**: leia');
  assert.ok(!out.includes('##'), 'título markdown vazou');
  assert.ok(!out.includes('- item'), 'marcador de lista vazou');
  assert.ok(out.includes('*Importante*'), '** deveria virar * (negrito real do WhatsApp)');
});

test('humanize: remove vícios de e-mail e o marcador legado de handoff', () => {
  const out = humanize.clean('Prezado cliente,\n\nSegue a resposta.\n\nAtenciosamente,\nHANDOFF_SOLICITADO');
  assert.ok(!/Prezado/i.test(out));
  assert.ok(!/Atenciosamente/i.test(out));
  assert.ok(!out.includes('HANDOFF_SOLICITADO'));
});

test('humanize: remove citações [1] do RAG', () => {
  assert.ok(!humanize.clean('O plano custa X [1] e inclui Y [2].').includes('[1]'));
});

test('humanize: divide por parágrafo', () => {
  const b = humanize.split('Oi, tudo bem?\n\nMe conta o que você precisa.');
  assert.strictEqual(b.length, 2);
});

test('humanize: quebra parede de texto em fronteira de frase', () => {
  const longo = 'Primeira frase bem completa aqui. '.repeat(20);
  const b = humanize.split(longo);
  assert.ok(b.length > 1, 'não dividiu texto longo');
  assert.ok(b.every(x => x.length <= humanize.MAX_BUBBLE + 60), 'bolha excedeu o máximo');
});

test('humanize: nunca passa do teto de bolhas', () => {
  const b = humanize.split(Array.from({ length: 9 }, (_, i) => `Parágrafo número ${i}.`).join('\n\n'), { maxBubbles: 4 });
  assert.ok(b.length <= 4, `esperado <= 4 bolhas, veio ${b.length}`);
});

test('humanize: junta fragmento curto com a bolha seguinte', () => {
  assert.strictEqual(humanize.split('Oi!\n\nComo posso te ajudar hoje?').length, 1,
    '"Oi!" sozinho deveria ter sido agrupado');
  assert.strictEqual(humanize.split('Perfeito\n\nVou te mandar o catálogo agora.').length, 1,
    'fragmento sem pontuação deveria ter sido agrupado');
});

test('humanize: frase curta COMPLETA continua sendo bolha própria', () => {
  assert.strictEqual(humanize.split('Oi, tudo bem?\n\nMe conta o que você precisa.').length, 2,
    'pergunta completa não deveria ter sido fundida');
});

test('humanize: delay de digitação fica na faixa humana', () => {
  assert.ok(humanize.typingDelay('oi') >= 1200);
  assert.ok(humanize.typingDelay('x'.repeat(5000)) <= 5000);
});

test('humanize: texto vazio devolve lista vazia', () => {
  assert.deepStrictEqual(humanize.split(''), []);
  assert.deepStrictEqual(humanize.split(null), []);
});

// -------------------------------------------------------------- guardrails --

function ctxVazio(extra = {}) {
  return { trace: [], knowledgeHadContent: false, ...extra };
}
const clienteFake = { client_id: 'demo' };

test('guardrails: remove CPF da resposta', () => {
  const out = guardrails.checkAfter('Seu CPF 123.456.789-00 está cadastrado', { client: clienteFake, ctx: ctxVazio() });
  assert.ok(!out.includes('123.456.789-00'));
  assert.ok(out.includes('[removido]'));
});

test('guardrails: remove chave de API vazada', () => {
  const out = guardrails.checkAfter('use sk-proj-abcdefghijklmnopqrstuvwxyz123', { client: clienteFake, ctx: ctxVazio() });
  assert.ok(!out.includes('sk-proj-abcdefghijklmnopqrstuvwxyz123'));
});

test('guardrails: neutraliza preço citado sem base de conhecimento', () => {
  const ctx = ctxVazio();
  const out = guardrails.checkAfter('O plano sai por R$ 497 por mês.', { client: clienteFake, ctx });
  assert.ok(!out.includes('R$ 497'), 'preço inventado deveria ser neutralizado');
  assert.ok(ctx.trace.some(t => t.guardrail === 'preco_sem_base'));
});

test('guardrails: PERMITE preço quando veio da base de conhecimento', () => {
  const out = guardrails.checkAfter('O plano sai por R$ 497 por mês.', {
    client: clienteFake,
    ctx: ctxVazio({ knowledgeHadContent: true })
  });
  assert.ok(out.includes('R$ 497'), 'preço com base deveria passar');
});

test('guardrails: preço passa se a ferramenta de busca achou algo', () => {
  const ctx = ctxVazio({ trace: [{ tool: 'buscar_conhecimento', hits: 3 }] });
  const out = guardrails.checkAfter('Custa R$ 1.200.', { client: clienteFake, ctx });
  assert.ok(out.includes('R$ 1.200'));
});

test('guardrails: detecta resposta repetida (loop)', () => {
  const frase = 'Claro, posso te ajudar com isso. Me conta um pouco mais sobre o que você precisa hoje.';
  const ctx = ctxVazio();
  const out = guardrails.checkAfter(frase, {
    client: clienteFake,
    ctx,
    history: [{ direction: 'outbound', content: frase }]
  });
  assert.notStrictEqual(out, frase, 'deveria ter trocado a resposta repetida');
  assert.ok(ctx.trace.some(t => t.guardrail === 'resposta_repetida'));
});

test('guardrails: resposta diferente NÃO é marcada como loop', () => {
  const ctx = ctxVazio();
  const nova = 'Perfeito, vou te mandar o catálogo agora.';
  const out = guardrails.checkAfter(nova, {
    client: clienteFake,
    ctx,
    history: [{ direction: 'outbound', content: 'Oi! Como posso te ajudar?' }]
  });
  assert.strictEqual(out, nova);
});

test('guardrails: similaridade se comporta nos extremos', () => {
  assert.strictEqual(guardrails.similarity('abcdef', 'abcdef'), 1);
  assert.ok(guardrails.similarity('abcdef', 'zyxwvu') < 0.2);
});

// ------------------------------------------------------------ qualificação --

test('qualificação: expressão com E', () => {
  const pb = { criterio_qualificado: 'nome e email' };
  assert.strictEqual(isQualified(pb, { nome: 'Ana' }), false);
  assert.strictEqual(isQualified(pb, { nome: 'Ana', email: 'a@b.com' }), true);
});

test('qualificação: expressão com OU', () => {
  const pb = { criterio_qualificado: 'email ou telefone' };
  assert.strictEqual(isQualified(pb, { telefone: '11999' }), true);
  assert.strictEqual(isQualified(pb, { outro: 'x' }), false);
});

test('qualificação: parênteses e precedência', () => {
  const pb = { criterio_qualificado: 'necessidade e prazo e (email ou empresa)' };
  assert.strictEqual(isQualified(pb, { necessidade: 'x', prazo: 'y' }), false);
  assert.strictEqual(isQualified(pb, { necessidade: 'x', prazo: 'y', empresa: 'Acme' }), true);
  assert.strictEqual(isQualified(pb, { necessidade: 'x', prazo: 'y', email: 'a@b.c' }), true);
  assert.strictEqual(isQualified(pb, { prazo: 'y', email: 'a@b.c' }), false);
});

test('qualificação: valor vazio não conta como preenchido', () => {
  assert.strictEqual(isQualified({ criterio_qualificado: 'nome' }, { nome: '   ' }), false);
});

test('qualificação: sem critério, cai nos campos obrigatórios', () => {
  const pb = { perguntas_qualificacao: [
    { campo: 'nome', obrigatorio: true },
    { campo: 'empresa', obrigatorio: true },
    { campo: 'cargo', obrigatorio: false }
  ]};
  assert.strictEqual(isQualified(pb, { nome: 'Ana' }), false);
  assert.strictEqual(isQualified(pb, { nome: 'Ana', empresa: 'Acme' }), true);
});

test('qualificação: playbook vazio nunca qualifica sozinho', () => {
  assert.strictEqual(isQualified({}, { nome: 'Ana' }), false);
});

test('qualificação: critério malformado não derruba o agente', () => {
  assert.doesNotThrow(() => isQualified({ criterio_qualificado: 'e e ( ( ou' }, { a: 1 }));
});

// ------------------------------------------------------------ salesPrompt ---

const clientePrompt = {
  client_id: 'demo',
  nome_empresa: 'Acme',
  nicho: 'consultoria',
  playbook: {
    objetivo: 'Agendar diagnóstico',
    perguntas_qualificacao: [
      { campo: 'nome', pergunta: 'Com quem falo?', obrigatorio: true },
      { campo: 'empresa', pergunta: 'De qual empresa?', obrigatorio: true }
    ],
    objecoes: [{ objecao: 'está caro', resposta: 'mostre o retorno em 90 dias' }]
  }
};

test('salesPrompt: não repergunta o que já foi coletado', () => {
  const p = salesPrompt.build({ client: clientePrompt, state: { collected: { nome: 'Marina' } } });
  assert.ok(p.includes('JÁ DESCOBERTO'));
  assert.ok(p.includes('Marina'));
  const faltando = p.split('AINDA FALTA DESCOBRIR')[1] || '';
  assert.ok(faltando.includes('empresa'), 'empresa deveria estar pendente');
  assert.ok(!faltando.includes('• nome'), 'nome não deveria estar pendente');
});

test('salesPrompt: avisa quando a qualificação terminou', () => {
  const p = salesPrompt.build({ client: clientePrompt, state: { collected: { nome: 'M', empresa: 'A' } } });
  assert.ok(p.includes('Pare de perguntar'));
});

test('salesPrompt: sem base de conhecimento, instrui explicitamente a não inventar', () => {
  const p = salesPrompt.build({ client: clientePrompt, knowledge: '' });
  assert.ok(/não preencha a lacuna com suposição/i.test(p));
});

test('salesPrompt: com base, marca como fonte de verdade', () => {
  const p = salesPrompt.build({ client: clientePrompt, knowledge: '[1] O plano custa R$ 497' });
  assert.ok(p.includes('R$ 497'));
  assert.ok(/única fonte de verdade/i.test(p));
});

test('salesPrompt: ferramenta de arquivo só aparece se houver arquivos', () => {
  const sem = salesPrompt.build({ client: clientePrompt, assets: [] });
  assert.ok(!sem.includes('ARQUIVOS QUE VOCÊ PODE ENVIAR'));
  const com = salesPrompt.build({
    client: clientePrompt,
    assets: [{ id: 1, name: 'Catálogo', description: 'quando pedir produtos' }]
  });
  assert.ok(com.includes('id 1 — "Catálogo"'));
});

test('salesPrompt: injeta as objeções do playbook', () => {
  assert.ok(salesPrompt.build({ client: clientePrompt }).includes('está caro'));
});

test('salesPrompt: preserva o prompt que o cliente já tinha escrito', () => {
  const p = salesPrompt.build({ client: { ...clientePrompt, system_prompt: 'Você é a Bia, gentil e direta.' } });
  assert.ok(p.includes('Você é a Bia'), 'prompt existente do cliente foi perdido');
});

test('salesPrompt: aviso de fora de horário', () => {
  const p = salesPrompt.build({ client: clientePrompt, foraDoHorario: true });
  assert.ok(/FORA DO HORÁRIO/.test(p));
});

test('salesPrompt: follow-up proíbe as frases genéricas de bot', () => {
  const p = salesPrompt.buildFollowUp({ client: clientePrompt, lead: { name: 'Ana' }, tentativa: 1 });
  assert.ok(p.includes('oi, tudo bem?'), 'deveria listar a frase proibida');
  assert.ok(/UMA mensagem só/.test(p));
});

test('salesPrompt: última tentativa de follow-up encerra com elegância', () => {
  assert.ok(salesPrompt.buildFollowUp({ client: clientePrompt, tentativa: 3 }).includes('última tentativa'));
});

// --------------------------------------------------------------------- rag --

test('rag: cosseno', () => {
  assert.ok(Math.abs(cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

test('rag: RRF favorece quem aparece bem nos dois rankings', () => {
  const semantico = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const lexico    = [{ id: 3 }, { id: 1 }, { id: 9 }];
  const fundido = rrf([semantico, lexico]);
  assert.strictEqual(fundido[0].id, 1, 'id 1 (1º e 2º) deveria liderar');
  assert.ok(fundido.some(c => c.id === 9), 'itens de um só ranking devem sobreviver');
  assert.strictEqual(new Set(fundido.map(c => c.id)).size, fundido.length, 'RRF duplicou item');
});

// --------------------------------------------------------------- evolution --

test('evolution: JID vira número puro', () => {
  assert.strictEqual(evolution.toNumber('5517991794038@s.whatsapp.net'), '5517991794038');
  assert.strictEqual(evolution.toNumber('5517991794038'), '5517991794038');
  assert.strictEqual(evolution.toNumber('+55 (17) 99179-4038'), '5517991794038');
});

test('evolution: JID de grupo é preservado', () => {
  assert.strictEqual(evolution.toNumber('12036304@g.us'), '12036304@g.us');
});

test('evolution: mimetype deduzido pela extensão', () => {
  assert.strictEqual(evolution.guessMime('catalogo.pdf'), 'application/pdf');
  assert.strictEqual(evolution.guessMime('foto.PNG'), 'image/png');
  assert.strictEqual(evolution.guessMime('tabela.xlsx').includes('spreadsheet'), true);
  assert.strictEqual(evolution.guessMime('sem-extensao', 'image'), 'image/jpeg');
});

// --------------------------------------------------------------- chunking ---

const { chunkText } = require('../routes/knowledge');

test('chunking: separa por seção e preserva o título', () => {
  const doc = `PLANOS E PREÇOS

O plano Essencial custa R$ 497 por mês.

POLÍTICA DE GARANTIA

Garantia incondicional de 30 dias com devolução integral do valor pago.`;
  const c = chunkText(doc);
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].title, 'PLANOS E PREÇOS');
  assert.ok(c[0].content.includes('497'));
  assert.strictEqual(c[1].title, 'POLÍTICA DE GARANTIA');
  assert.ok(c[1].content.includes('30 dias'));
});

test('chunking: reconhece título markdown', () => {
  const c = chunkText('## Prazos\n\nA entrega leva de 5 a 10 dias úteis após a confirmação do pedido.');
  assert.strictEqual(c[0].title, 'Prazos');
});

test('chunking: parede de texto sem quebras ainda é fatiada', () => {
  const c = chunkText('Frase sem nenhuma quebra de linha. '.repeat(120));
  assert.ok(c.length > 1, 'não fatiou o texto corrido');
  assert.ok(c.every(x => x.content.length <= 900), 'pedaço maior que o limite');
});

test('chunking: descarta fragmento curto demais', () => {
  assert.strictEqual(chunkText('oi').length, 0);
});

test('chunking: nenhum trecho sai vazio', () => {
  const c = chunkText('TÍTULO\n\n\n\nConteúdo relevante com tamanho suficiente para virar um trecho.\n\n\n');
  assert.ok(c.every(x => x.content.trim().length >= 40));
});

test('chunking: NÃO descarta linha curta que carrega o preço', () => {
  const c = chunkText('PLANOS\n\nO plano Essencial custa R$ 497 por mês.');
  assert.strictEqual(c.length, 1, 'a linha do preço foi descartada');
  assert.ok(c[0].content.includes('R$ 497'));
});

test('chunking: descarta rodapé de PDF e número de página', () => {
  assert.strictEqual(chunkText('SEÇÃO\n\nPágina 3 de 10').length, 0);
  assert.strictEqual(chunkText('SEÇÃO\n\n42').length, 0);
});
