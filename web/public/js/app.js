import { api, ApiError } from './api.js';
import { parseNFe, operacaoDaNota, NFE_EXEMPLO } from './nfe.js';

// ---------------------------------------------------------------- utilidades
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : brl.format(Number(v)));
const pct = (v, d = 2, max = 4) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, max) })}%`);
const n = (v) => (v == null || v === '' ? null : Number(v));
const TOL = 0.01; // tolerância de arredondamento, em reais
const reduzMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Aceita número no formato brasileiro ("1.234,56") ou com ponto decimal ("1234.56").
function parseNum(s) {
  if (s == null) return null;
  let t = String(s).trim().replace(/\s|R\$|%/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ''); // "10.000" = dez mil
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}
// Mesmo número, como texto com ponto decimal (para campos que a API recebe como string).
const numTxt = (s) => { const v = parseNum(s); return v == null || Number.isNaN(v) ? '' : String(v); };

function hoje() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const ano = (data) => Number(String(data).slice(0, 4));
const dataBR = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

// Preferências do visitante (UF/município) — só conveniência; funciona sem armazenamento.
const prefs = {
  get(k) { try { return localStorage.getItem(`confere:${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`confere:${k}`, v); } catch { /* sem armazenamento */ } },
};

function loading(el, msg = 'Calculando na calculadora oficial…') {
  el.innerHTML = `<div class="result"><p class="muted" role="status"><span class="spinner"></span>${esc(msg)}</p></div>`;
}
function showError(el, err) {
  const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
  el.innerHTML = `<div class="result"><div class="alert bad" role="alert" tabindex="-1"><strong>Não foi possível concluir.</strong> ${esc(msg)}</div></div>`;
  reveal(el);
}
// Mostra o resultado: rola até ele e leva o foco para lá (teclado e leitor de tela).
function reveal(el) {
  const alvo = el.querySelector('[tabindex="-1"], h3, .alert') || el;
  if (!alvo.hasAttribute('tabindex')) alvo.setAttribute('tabindex', '-1');
  alvo.scrollIntoView({ behavior: reduzMovimento ? 'auto' : 'smooth', block: 'start' });
  alvo.focus({ preventScroll: true });
}
async function withBusy(form, fn, texto = 'Calculando…') {
  const btn = $('button[type="submit"]', form);
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = texto; btn.setAttribute('aria-busy', 'true'); }
  try { await fn(); } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; btn.removeAttribute('aria-busy'); }
  }
}

// ---------------------------------------------------------------- validação com mensagens em português
const visivel = (el) => !el.disabled && !el.closest('[hidden]');
function setErro(el, msg) {
  const label = el.closest('label');
  let small = label && $('.err', label);
  if (!msg) {
    el.removeAttribute('aria-invalid');
    if (small) small.remove();
    return;
  }
  el.setAttribute('aria-invalid', 'true');
  if (label && !small) {
    small = document.createElement('small');
    small.className = 'err';
    small.id = `err-${Math.random().toString(36).slice(2, 8)}`;
    label.append(small);
    el.setAttribute('aria-describedby', [el.getAttribute('aria-describedby'), small.id].filter(Boolean).join(' '));
  }
  if (small) small.textContent = msg;
}
function erroDoCampo(el) {
  const v = el.value.trim();
  if (el.type === 'file') return el.required && !el.files.length ? 'Escolha um arquivo XML.' : '';
  if (!v) return el.required ? 'Preencha este campo.' : '';
  if (el.hasAttribute('data-num')) {
    const x = parseNum(v);
    if (Number.isNaN(x)) return 'Use só números, por exemplo 1.234,56.';
    if (x < 0) return 'O valor não pode ser negativo.';
  }
  if (el.name === 'cClassTrib' || el.name === 'isClass' || el.name === 'c') {
    if (!/^\d{6}$/.test(v)) return 'O cClassTrib tem 6 dígitos.';
  }
  if (el.name === 'codigo') {
    const tipo = el.closest('[data-item]') ? $('[name="tipo"]', el.closest('[data-item]')).value : el.form?.tipo?.value;
    const dig = v.replace(/\D/g, '');
    if (tipo === 'nbs' && dig.length !== 9) return 'O NBS tem 9 dígitos.';
    if (tipo !== 'nbs' && dig.length !== 8) return 'O NCM tem 8 dígitos.';
  }
  if (el.pattern && !new RegExp(`^(?:${el.pattern})$`).test(v)) return 'Formato inválido.';
  return '';
}
function validar(form) {
  let primeiro = null;
  for (const el of $$('input, select', form)) {
    if (!visivel(el) || el.type === 'checkbox') continue;
    const msg = erroDoCampo(el);
    setErro(el, msg);
    if (msg && !primeiro) primeiro = el;
  }
  if (primeiro) {
    const det = primeiro.closest('details');
    if (det) det.open = true;
    primeiro.focus();
    return false;
  }
  return true;
}
// Some o erro assim que o usuário corrige o campo.
document.addEventListener('input', (e) => {
  if (e.target.getAttribute?.('aria-invalid') === 'true' && !erroDoCampo(e.target)) setErro(e.target, '');
});

const ESTADOS = {
  CALCULADO: ['ok', 'Calculado'],
  CALCULO_SIMULADO: ['ok', 'Calculado (alíq. informadas)'],
  INCONSISTENCIA_ENTRADA: ['bad', 'Inconsistência'],
  NAO_IMPLEMENTADO: ['warn', 'Não implementado'],
  NAO_CALCULADO: ['warn', 'Não calculado'],
  FALHA_TECNICA: ['bad', 'Falha técnica'],
};
const estadoBadge = (e) => {
  const [cls, label] = ESTADOS[e] || ['info', e || '—'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};

function errosHtml(erros) {
  if (!erros?.length) return '';
  return `<ul class="small">${erros.map((e) => `<li><b>${esc(e.title || e.code || '')}</b>${e.detail ? `: ${esc(e.detail)}` : ''}${e.code && e.title ? ` <span class="muted">(${esc(e.code)})</span>` : ''}</li>`).join('')}</ul>`;
}
const errosTexto = (erros) => (erros || []).map((e) => `${e.code || ''} ${e.title || ''}${e.detail ? `: ${e.detail}` : ''}`.trim()).join(' | ');

// Extrai valores do grupo tribCalc do regime regular.
function valoresRG(obj) {
  const ib = obj?.tribCalc?.IBSCBS;
  const g = ib?.gIBSCBS;
  const is = obj?.tribCalc?.IS;
  return {
    cst: ib?.CST, cClassTrib: ib?.cClassTrib,
    vBC: n(g?.vBC),
    pIBSUF: n(g?.gIBSUF?.gRed?.pAliqEfet ?? g?.gIBSUF?.pIBSUF), vIBSUF: n(g?.gIBSUF?.vIBSUF),
    pIBSMun: n(g?.gIBSMun?.gRed?.pAliqEfet ?? g?.gIBSMun?.pIBSMun), vIBSMun: n(g?.gIBSMun?.vIBSMun),
    vIBS: n(g?.vIBS),
    pCBS: n(g?.gCBS?.gRed?.pAliqEfet ?? g?.gCBS?.pCBS), vCBS: n(g?.gCBS?.vCBS),
    pRed: n(g?.gCBS?.gRed?.pRedAliq),
    vIS: n(is?.vIS), pIS: n(is?.pIS),
    memoria: ib?.memoriaCalculo, memoriaIS: is?.memoriaCalculo,
  };
}

function memoriaHtml(v) {
  const m = v.memoria;
  const parts = [];
  if (m && typeof m === 'object') {
    if (m.cbs) parts.push(`CBS: ${m.cbs}`);
    if (m.ibsUF) parts.push(`IBS UF: ${m.ibsUF}`);
    if (m.ibsMun) parts.push(`IBS Mun.: ${m.ibsMun}`);
  } else if (m) parts.push(String(m));
  if (v.memoriaIS) parts.push(`IS: ${v.memoriaIS}`);
  if (!parts.length) return '';
  return `<details class="memoria"><summary>Como foi calculado</summary><pre>${esc(parts.join('\n\n'))}</pre></details>`;
}

// Célula "nota × oficial" com destaque de diferença (cor + ícone + texto, não só cor).
function cmpCell(informado, oficial) {
  if (informado == null && oficial == null) return '<td class="n muted">—</td>';
  if (informado == null) return `<td class="n">${money(oficial)}</td>`;
  if (oficial == null) return `<td class="n">${money(informado)}<br><span class="muted small">oficial: —</span></td>`;
  const diff = informado - oficial;
  const ok = Math.abs(diff) <= TOL + 1e-9;
  return ok
    ? `<td class="n diff-ok">${money(informado)}<br><span class="small">✓ confere</span></td>`
    : `<td class="n diff-bad">${money(informado)}<br><span class="small">✗ correto: <b>${money(oficial)}</b><br>diferença ${diff > 0 ? '+' : ''}${money(diff)}</span></td>`;
}
function itemConfere(inf, ofi, campos) {
  return campos.every((c) => inf[c] == null || ofi[c] == null || Math.abs(inf[c] - ofi[c]) <= TOL + 1e-9);
}

function baixarArquivo(nome, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nome });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// CSV no padrão do Excel brasileiro: ponto e vírgula, vírgula decimal e BOM UTF-8.
function csv(linhas) {
  const cel = (v) => {
    if (v == null) return '';
    if (typeof v === 'number') return v.toFixed(2).replace('.', ',');
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${linhas.map((l) => l.map(cel).join(';')).join('\r\n')}`;
}

// ---------------------------------------------------------------- abas
const TABS = { nfe: 'Conferir NF-e', operacao: 'Simular operação', comparar: 'Regular × Simples', consultas: 'Consultas', danfse: 'DANFSe', ajuda: 'Como funciona' };
// #ajuda abre o guia; #ajuda-<seção> abre o guia já na seção.
function rota() {
  const h = location.hash.slice(1);
  if (h.startsWith('ajuda-') && document.getElementById(h)) return { id: 'ajuda', secao: h };
  return { id: TABS[h] ? h : 'nfe', secao: null };
}
function showTab() {
  const { id, secao } = rota();
  for (const t of Object.keys(TABS)) $(`#tab-${t}`).hidden = t !== id;
  for (const a of $$('.tabs a')) {
    if (a.dataset.tab === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('[data-ajuda-link]')?.toggleAttribute('aria-current', id === 'ajuda');
  if (id === 'ajuda') $('[data-ajuda-link]').setAttribute('aria-current', 'page');
  document.title = `${TABS[id]} · Confere RTC`;
  if (id === 'consultas') initConsultas();
  return secao;
}
window.addEventListener('hashchange', () => {
  const secao = showTab();
  if (secao) { irParaSecao(secao); return; }
  const h2 = $('#conteudo .panel:not([hidden]) h2');
  h2?.setAttribute('tabindex', '-1');
  h2?.focus({ preventScroll: true });
  if (location.hash === '#ajuda') h2?.scrollIntoView({ block: 'start' });
});
function irParaSecao(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: reduzMovimento ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- status (com nova tentativa automática)
async function initStatus() {
  const el = $('#status');
  const banner = $('#offline');
  try {
    const v = await api.versao();
    el.innerHTML = `Calculadora <span class="hide-sm">oficial ${esc(v.versaoApp)} · base ${esc(v.versaoDb)}</span><span class="show-sm">no ar</span>`;
    el.title = `${v.descricaoVersaoDb || ''} (base de ${dataBR(v.dataVersaoDb) || '?'})`;
    el.classList.remove('off'); el.classList.add('on');
    banner.hidden = true;
  } catch {
    el.textContent = 'Calculadora indisponível';
    el.classList.remove('on'); el.classList.add('off');
    banner.hidden = false;
    setTimeout(initStatus, 10000);
  }
}

// ---------------------------------------------------------------- UF / município (por nome)
const CAPITAIS = { AC: 1200401, AL: 2704302, AM: 1302603, AP: 1600303, BA: 2927408, CE: 2304400, DF: 5300108, ES: 3205309, GO: 5208707, MA: 2111300, MG: 3106200, MS: 5002704, MT: 5103403, PA: 1501402, PB: 2507507, PE: 2611606, PI: 2211001, PR: 4106902, RJ: 3304557, RN: 2408102, RO: 1100205, RR: 1400100, RS: 4314902, SC: 4205407, SE: 2800308, SP: 3550308, TO: 1721000 };
const SIGLAS = Object.keys(CAPITAIS).sort();

async function setupLocal(form) {
  const uf = form.uf;
  const mun = form.municipio;
  try {
    const ufs = await api.ufs();
    uf.innerHTML = ufs.sort((a, b) => a.sigla.localeCompare(b.sigla)).map((u) => `<option value="${esc(u.sigla)}">${esc(u.sigla)}</option>`).join('');
  } catch {
    uf.innerHTML = SIGLAS.map((s) => `<option>${s}</option>`).join('');
  }
  uf.value = prefs.get('uf') || 'SP';

  async function carregar(codigoPreferido) {
    mun.innerHTML = '<option value="">Carregando…</option>';
    mun.disabled = true;
    try {
      const lista = await api.municipios(uf.value);
      mun.innerHTML = lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
        .map((m) => `<option value="${m.codigo}">${esc(m.nome)}</option>`).join('');
    } catch {
      mun.innerHTML = `<option value="${CAPITAIS[uf.value] || ''}">Capital (lista indisponível)</option>`;
    }
    mun.disabled = false;
    const alvo = String(codigoPreferido || CAPITAIS[uf.value] || '');
    if ($$('option', mun).some((o) => o.value === alvo)) mun.value = alvo;
  }
  uf.addEventListener('change', async () => {
    prefs.set('uf', uf.value);
    await carregar();
    prefs.set('mun', mun.value);
  });
  mun.addEventListener('change', () => prefs.set('mun', mun.value));
  await carregar(prefs.get('uf') === uf.value ? prefs.get('mun') : null);

  // Usado pelos botões de exemplo.
  form.setLocal = async (sigla, codigo) => { uf.value = sigla; await carregar(codigo); };
}

// Alíquotas nominais só existem a partir de 2027.
function wireAliquotas(form) {
  const data = form.data;
  const sync = () => {
    const exige = ano(data.value) >= 2027;
    for (const box of $$('[data-aliq-box]', form)) {
      box.hidden = !exige;
      for (const i of $$('input', box)) i.disabled = !exige;
    }
    for (const p of $$('[data-aliq-2026]', form)) p.hidden = exige;
  };
  data.addEventListener('change', sync);
  return sync;
}

// ---------------------------------------------------------------- cClassTrib: sugestões e descrição ao lado do campo
const ctMap = new Map();
async function initClassTrib() {
  try {
    const lista = await api.classificacoes(hoje() < '2027-01-01' ? '2027-01-01' : hoje());
    for (const c of lista) ctMap.set(c.codigo, c);
    $('#dl-classtrib').innerHTML = lista.map((c) => `<option value="${esc(c.codigo)}">${esc((c.descricao || '').slice(0, 100))}</option>`).join('');
  } catch { /* opcional */ }
  $$('[data-ct]').forEach(updateCtHelp);
}
function updateCtHelp(input) {
  const help = $('[data-ct-desc]', input.closest('label'));
  if (!help) return;
  const v = input.value.trim();
  const c = ctMap.get(v);
  help.classList.remove('warn-text');
  if (c) {
    help.textContent = `${c.descricao}${c.descricaoTratamentoTributario ? ` · ${c.descricaoTratamentoTributario}` : ''}`;
  } else if (/^\d{6}$/.test(v) && ctMap.size) {
    help.textContent = 'Código não encontrado na tabela vigente. Confira em “Consultas”.';
    help.classList.add('warn-text');
  } else {
    help.textContent = 'Classificação tributária, 6 dígitos. Digite para ver sugestões; 000001 = tributação integral.';
  }
}
document.addEventListener('input', (e) => { if (e.target.matches?.('[data-ct]')) updateCtHelp(e.target); });

// ================================================================ CONFERIR NF-e
function initNFe() {
  const drop = $('#nfe-drop');
  const input = $('#nfe-file');
  const out = $('#nfe-result');

  const handle = async (files) => {
    const xmls = files.filter((f) => /\.xml$/i.test(f.name) || /xml/.test(f.type));
    if (!xmls.length) {
      showError(out, new Error('Nenhum arquivo .xml foi selecionado.'));
      return;
    }
    out.innerHTML = files.length > 1 ? `<p class="muted small">${xmls.length} nota(s) selecionada(s).</p>` : '';
    let primeira = true;
    for (const f of xmls) {
      const box = document.createElement('div');
      box.className = 'nota';
      out.append(box);
      if (f.size > 2 * 1024 * 1024) { showError(box, new Error(`${f.name}: o arquivo passa de 2 MB.`)); continue; }
      await conferirNota(await f.text(), f.name, box);
      if (primeira) { reveal(box); primeira = false; }
    }
  };
  input.addEventListener('change', () => handle([...input.files]).finally(() => { input.value = ''; }));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); handle([...e.dataTransfer.files]); });
  $('#nfe-exemplo').addEventListener('click', async () => {
    out.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'nota';
    out.append(box);
    await conferirNota(NFE_EXEMPLO, 'nota-exemplo.xml', box);
    reveal(box);
  });
  out.addEventListener('change', (e) => {
    if (e.target.matches('[data-so-problemas]')) {
      e.target.closest('.nota').classList.toggle('so-problemas', e.target.checked);
    }
  });
}

async function conferirNota(xml, fileName, box) {
  let nota;
  try {
    nota = parseNFe(xml, fileName);
  } catch (e) { showError(box, new Error(`${fileName}: ${e.message}`)); return; }

  const head = `<div class="doc-head"><h3 tabindex="-1">NF-e nº ${esc(nota.numero || '?')}${nota.serie ? `, série ${esc(nota.serie)}` : ''} <span class="muted small">(modelo ${esc(nota.modelo || '?')})</span></h3>
    <span class="doc-meta">${esc(nota.emitente || '')}${nota.cnpj ? ` · ${esc(nota.cnpj)}` : ''} · emitida em ${esc(dataBR(nota.dhEmi))} · ${esc(nota.uf || '?')}</span></div>`;

  const avisos = [];
  if (['1', '2', '4'].includes(nota.crt)) avisos.push(`O emitente é do Simples Nacional (CRT ${esc(nota.crt)}). Esta conferência usa a calculadora do <b>regime regular</b>; para o Simples, use a aba <a href="#comparar">Regular × Simples</a>.`);
  if (nota.compraGov) avisos.push('A nota tem compra governamental (gCompraGov); o redutor não é considerado nesta conferência.');
  const semGrupo = nota.itens.filter((i) => !i.temIBSCBS);
  const mono = nota.itens.filter((i) => i.monofasico);
  if (semGrupo.length) avisos.push(`${semGrupo.length} item(ns) sem o grupo IBSCBS (nota emitida antes da reforma ou sem destaque).`);
  if (mono.length) avisos.push(`${mono.length} item(ns) em regime monofásico (combustíveis) não são conferidos aqui.`);

  const op = operacaoDaNota(nota);
  if (!op.itens.length) {
    box.innerHTML = `${head}<div class="alert warn">Nenhum item com o grupo IBSCBS para conferir.${avisos.length ? `<ul>${avisos.map((a) => `<li>${a}</li>`).join('')}</ul>` : ''}</div>`;
    return;
  }
  if (!op.uf || !op.municipio) { showError(box, new Error('Não encontrei o município do fato gerador (ide/cMunFG) na nota.')); box.insertAdjacentHTML('afterbegin', head); return; }

  loading(box, `Conferindo ${op.itens.length} item(ns) na calculadora oficial…`);
  let res;
  try {
    res = await api.calcularRegimeRegular(op);
  } catch (e) { showError(box, e); box.insertAdjacentHTML('afterbegin', head); return; }

  const objs = new Map((res.data?.objetos || []).map((o) => [o.nObj, o]));
  const campos = ['vBC', 'vIBSUF', 'vIBSMun', 'vCBS', 'vIS'];
  let okCount = 0; let divCount = 0; let errCount = 0;
  const soma = { nota: { vIBS: 0, vCBS: 0, vIS: 0 }, ofi: { vIBS: 0, vCBS: 0, vIS: 0 } };
  const planilha = [['Item', 'Produto', 'NCM', 'CST', 'cClassTrib', 'Situação',
    'Base nota', 'Base oficial', 'CBS nota', 'CBS oficial', 'IBS UF nota', 'IBS UF oficial', 'IBS Mun nota', 'IBS Mun oficial', 'IS nota', 'IS oficial', 'Observação']];

  const rows = nota.itens.map((it) => {
    const inf = it.nota ? { ...it.nota, vIS: it.is?.vIS ?? null } : null;
    const desc = `<b>${it.numero}.</b> ${esc(it.xProd || it.cProd || '')}<br><span class="muted small">NCM ${esc(it.ncm || '—')} · cClassTrib ${esc(it.cClassTrib || '—')}</span>`;
    const linha = (sit, ofi, obs) => planilha.push([String(it.numero), it.xProd || it.cProd, it.ncm, it.cst, it.cClassTrib, sit,
      inf?.vBC, ofi?.vBC, inf?.vCBS, ofi?.vCBS, inf?.vIBSUF, ofi?.vIBSUF, inf?.vIBSMun, ofi?.vIBSMun, inf?.vIS, it.is ? ofi?.vIS : null, obs || '']);
    if (!inf || it.monofasico) {
      const obs = it.monofasico ? 'Tributação monofásica' : 'Sem grupo IBSCBS';
      linha('Não conferido', null, obs);
      return `<tr data-st="nc"><td>${desc}</td><td><span class="badge warn">não conferido</span></td><td colspan="5" class="muted small">${obs}</td></tr>`;
    }
    soma.nota.vIBS += (inf.vIBSUF || 0) + (inf.vIBSMun || 0); soma.nota.vCBS += inf.vCBS || 0; soma.nota.vIS += inf.vIS || 0;
    const o = objs.get(it.numero);
    if (!o || !o.tribCalc) {
      errCount++;
      linha('Inconsistência', null, errosTexto(o?.erros) || 'Sem retorno da calculadora');
      return `<tr data-st="err"><td>${desc}</td><td>${estadoBadge(o?.estadoItem || 'FALHA_TECNICA')}</td><td colspan="5">${errosHtml(o?.erros) || '<span class="muted small">Sem retorno da calculadora.</span>'}</td></tr>`;
    }
    const ofi = valoresRG(o);
    soma.ofi.vIBS += (ofi.vIBSUF || 0) + (ofi.vIBSMun || 0); soma.ofi.vCBS += ofi.vCBS || 0; soma.ofi.vIS += ofi.vIS || 0;
    const confere = itemConfere(inf, ofi, campos);
    if (confere) okCount++; else divCount++;
    linha(confere ? 'Confere' : 'Divergente', ofi);
    return `<tr data-st="${confere ? 'ok' : 'div'}"><td>${desc}${memoriaHtml(ofi)}</td><td>${confere ? '<span class="badge ok">✓ confere</span>' : '<span class="badge bad">✗ divergente</span>'}</td>
      ${cmpCell(inf.vBC, ofi.vBC)}${cmpCell(inf.vCBS, ofi.vCBS)}${cmpCell(inf.vIBSUF, ofi.vIBSUF)}${cmpCell(inf.vIBSMun, ofi.vIBSMun)}${cmpCell(inf.vIS, it.is ? ofi.vIS : null)}</tr>`;
  }).join('');

  const total = nota.itens.length;
  const problemas = divCount + errCount;
  const resumo = errCount ? 'bad' : divCount ? 'warn' : 'ok';
  const resumoTxt = problemas
    ? `<strong>${problemas} de ${total} itens precisam de atenção.</strong> ${divCount ? `${divCount} com valor diferente do oficial. ` : ''}${errCount ? `${errCount} com erro de classificação ou de dados.` : ''}`
    : `<strong>Tudo certo:</strong> os ${okCount} itens conferem com a calculadora oficial.`;
  const difTotal = (soma.nota.vCBS + soma.nota.vIBS + soma.nota.vIS) - (soma.ofi.vCBS + soma.ofi.vIBS + soma.ofi.vIS);
  const simulado = res.headers.get('x-warning-dados-simulados')
    ? '<p class="help">A partir de 2027 o cálculo usa as alíquotas destacadas na própria nota (a calculadora chama isso de “cálculo simulado”).</p>' : '';
  const kpi = (rotulo, vNota, vOfi) => {
    const ok = Math.abs(vNota - vOfi) <= TOL * Math.max(1, total);
    return `<div class="kpi"><span>${rotulo}</span><b>${money(vNota)}</b><small class="${ok ? 'ok-text' : 'bad-text'}">${ok ? '✓ igual ao oficial' : `oficial: ${money(vOfi)}`}</small></div>`;
  };

  box.innerHTML = `${head}
    <div class="alert ${resumo}" role="status">${resumoTxt}</div>
    ${avisos.length ? `<div class="alert warn"><ul>${avisos.map((a) => `<li>${a}</li>`).join('')}</ul></div>` : ''}
    <div class="kpis">
      ${kpi('CBS na nota', soma.nota.vCBS, soma.ofi.vCBS)}
      ${kpi('IBS na nota', soma.nota.vIBS, soma.ofi.vIBS)}
      ${kpi('IS na nota', soma.nota.vIS, soma.ofi.vIS)}
      <div class="kpi"><span>Diferença total</span><b class="${Math.abs(difTotal) > TOL ? 'bad-text' : ''}">${money(difTotal)}</b><small>${difTotal > TOL ? 'nota cobrou a mais' : difTotal < -TOL ? 'nota cobrou a menos' : 'sem diferença'} (itens calculados)</small></div>
    </div>
    ${simulado}
    <div class="toolbar">
      ${problemas && problemas < total ? '<label class="check-inline"><input type="checkbox" data-so-problemas> Mostrar só os itens com problema</label>' : '<span></span>'}
      <button type="button" class="btn ghost sm" data-csv>⬇ Baixar planilha (CSV)</button>
    </div>
    <div class="table-wrap"><table>
      <caption class="sr-only">Conferência item a item da NF-e ${esc(nota.numero || '')}</caption>
      <thead><tr><th scope="col">Item</th><th scope="col">Situação</th><th scope="col" class="n">Base (vBC)</th><th scope="col" class="n">CBS</th><th scope="col" class="n">IBS UF</th><th scope="col" class="n">IBS Mun.</th><th scope="col" class="n">IS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="help">Cada célula mostra o valor da nota. ✓ verde: confere com o cálculo oficial (tolerância de R$ 0,01). ✗ vermelho: mostra o valor correto e a diferença.</p>`;

  $('[data-csv]', box).addEventListener('click', () => {
    baixarArquivo(`conferencia-nfe-${nota.numero || 'nota'}.csv`, csv(planilha), 'text/csv;charset=utf-8');
  });
}

// ================================================================ SIMULAR OPERAÇÃO
function itemTemplate(d = {}) {
  const nbs = d.tipo === 'nbs';
  return `<fieldset class="item" data-item>
    <legend class="item-top"><b>Item</b></legend>
    <button type="button" class="x" data-remove aria-label="Remover item">Remover</button>
    <div class="grid g4">
      <label>Descrição (opcional)<input name="desc" value="${esc(d.desc || '')}" placeholder="ex.: Mesa de madeira"></label>
      <label>Tipo<select name="tipo"><option value="ncm"${!nbs ? ' selected' : ''}>Mercadoria (NCM)</option><option value="nbs"${nbs ? ' selected' : ''}>Serviço (NBS)</option></select></label>
      <label><span data-codigo-label>${nbs ? 'NBS' : 'NCM'}</span><input name="codigo" inputmode="numeric" required value="${esc(d.codigo || '')}" placeholder="${nbs ? '9 dígitos' : '8 dígitos'}"></label>
      <label>cClassTrib<input name="cClassTrib" inputmode="numeric" maxlength="6" required list="dl-classtrib" data-ct value="${esc(d.cClassTrib || '000001')}"><small class="help" data-ct-desc></small></label>
    </div>
    <div class="grid g4">
      <label>Base de cálculo (R$)<input name="base" inputmode="decimal" data-num ${d.is ? 'disabled placeholder="calculada: base do IS + IS"' : 'required placeholder="0,00"'} value="${esc(d.base ?? '')}"></label>
      <label>Quantidade<input name="qtd" inputmode="decimal" data-num value="${esc(d.qtd ?? '')}" placeholder="opcional"></label>
      <label>Unidade<input name="un" maxlength="6" value="${esc(d.un || '')}" placeholder="UN, KG, LT…"></label>
      <label class="check"><input type="checkbox" name="temIS"${d.is ? ' checked' : ''}> Tem Imposto Seletivo</label>
    </div>
    <div class="grid g4" data-is ${d.is ? '' : 'hidden'}>
      <label>cClassTrib do IS<input name="isClass" inputmode="numeric" maxlength="6" value="${esc(d.is?.cClassTrib || '000001')}"></label>
      <label>Base do IS (R$)<input name="isBase" inputmode="decimal" data-num${d.is ? ' required' : ''} value="${esc(d.is?.base ?? '')}"></label>
      <p class="help span2">Com IS, a base da CBS/IBS é a base do IS + o IS calculado. Se informar o IS já calculado abaixo, ele também é conferido.</p>
    </div>
    <details${d.inf ? ' open' : ''}><summary>Quero conferir valores que já calculei (opcional)</summary>
      <div class="grid g4">
        <label>CBS calculada<input name="iCBS" inputmode="decimal" data-num value="${esc(d.inf?.vCBS ?? '')}"></label>
        <label>IBS UF calculado<input name="iIBSUF" inputmode="decimal" data-num value="${esc(d.inf?.vIBSUF ?? '')}"></label>
        <label>IBS Mun. calculado<input name="iIBSMun" inputmode="decimal" data-num value="${esc(d.inf?.vIBSMun ?? '')}"></label>
        <label>IS calculado<input name="iIS" inputmode="decimal" data-num value="${esc(d.inf?.vIS ?? '')}"></label>
      </div>
    </details>
  </fieldset>`;
}
function addItem(d, foco = false) {
  $('#op-items').insertAdjacentHTML('beforeend', itemTemplate(d));
  renumber();
  const novo = $('#op-items [data-item]:last-child');
  $$('[data-ct]', novo).forEach(updateCtHelp);
  if (foco) $('[name="desc"]', novo).focus();
}
function renumber() {
  const itens = $$('#op-items [data-item]');
  itens.forEach((el, i) => {
    $('.item-top b', el).textContent = `Item ${i + 1}`;
    const rm = $('[data-remove]', el);
    rm.hidden = itens.length === 1;
    rm.setAttribute('aria-label', `Remover item ${i + 1}`);
  });
}

function initOperacao() {
  const form = $('#op-form');
  form.data.value = hoje();
  const syncAliq = wireAliquotas(form);
  syncAliq();
  setupLocal(form);
  addItem({ codigo: '94036000', cClassTrib: '000001', base: '1.000,00', desc: 'Mesa de madeira' });

  $('#op-add').addEventListener('click', () => addItem({}, true));
  $('#op-items').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (!rm) return;
    const item = rm.closest('[data-item]');
    const prox = item.nextElementSibling || item.previousElementSibling;
    item.remove();
    renumber();
    $('[name="desc"]', prox)?.focus();
  });
  $('#op-items').addEventListener('change', (e) => {
    const el = e.target.closest('[data-item]');
    if (e.target.name === 'temIS') {
      const on = e.target.checked;
      $('[data-is]', el).hidden = !on;
      const base = $('[name="base"]', el);
      base.disabled = on; base.required = !on;
      base.placeholder = on ? 'calculada: base do IS + IS' : '0,00';
      setErro(base, '');
      $('[name="isBase"]', el).required = on;
    }
    if (e.target.name === 'tipo') {
      const nbs = e.target.value === 'nbs';
      $('[data-codigo-label]', el).textContent = nbs ? 'NBS' : 'NCM';
      $('[name="codigo"]', el).placeholder = nbs ? '9 dígitos' : '8 dígitos';
    }
  });
  $('#op-exemplo').addEventListener('click', async () => {
    form.data.value = '2027-03-10';
    syncAliq();
    await form.setLocal?.('RS', 4314902);
    form.aIs.value = '10';
    $('#op-items').innerHTML = '';
    addItem({ desc: 'Arroz (cesta básica)', codigo: '10063021', cClassTrib: '200003', base: '100,00', qtd: '20', un: 'KG' });
    addItem({ desc: 'Cerveja', codigo: '22030000', cClassTrib: '000001', qtd: '12', un: 'LT', is: { cClassTrib: '000001', base: '150,00' }, inf: { vCBS: '13,20', vIS: '15,00' } });
    addItem({ desc: 'Serviço de educação', tipo: 'nbs', codigo: '122011200', cClassTrib: '200028', base: '1.200,00', inf: { vCBS: '42,24', vIBSUF: '0,24', vIBSMun: '0,24' } });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validar(form)) return;
    const out = $('#op-result');
    withBusy(form, async () => {
      const data = form.data.value;
      const exige = ano(data) >= 2027;
      const aliq = exige ? {
        cbs: parseNum(form.aCbs.value) ?? 0, ibsEstadual: parseNum(form.aIbsUf.value) ?? 0, ibsMunicipal: parseNum(form.aIbsMun.value) ?? 0,
      } : null;
      const aIs = parseNum(form.aIs.value);
      const linhas = $$('#op-items [data-item]').map((el, i) => {
        const f = (name) => $(`[name="${name}"]`, el).value.trim();
        const temIS = $('[name="temIS"]', el).checked;
        const item = { numero: i + 1, cst: f('cClassTrib').slice(0, 3), cClassTrib: f('cClassTrib') };
        if (!temIS) item.baseCalculo = parseNum(f('base'));
        item[f('tipo')] = f('codigo').replace(/\D/g, '');
        if (f('qtd')) item.quantidade = parseNum(f('qtd'));
        if (f('un')) item.unidade = f('un').toUpperCase();
        const iIS = parseNum(f('iIS'));
        if (temIS) {
          item.impostoSeletivo = {
            cst: f('isClass').slice(0, 3), cClassTrib: f('isClass'), baseCalculo: parseNum(f('isBase')) ?? 0,
            ...(iIS != null ? { impostoInformado: iIS } : {}),
            ...(item.quantidade != null ? { quantidade: item.quantidade } : {}), ...(item.unidade ? { unidade: item.unidade } : {}),
          };
        }
        if (aliq) {
          item.aliquotasNominais = { ...aliq };
          if (temIS && aIs != null) item.aliquotasNominais.impostoSeletivo = { adValorem: aIs };
        }
        return {
          item,
          desc: f('desc'),
          inf: { vCBS: parseNum(f('iCBS')), vIBSUF: parseNum(f('iIBSUF')), vIBSMun: parseNum(f('iIBSMun')), vIS: iIS },
        };
      });
      const op = {
        id: `sim-${Date.now()}`, versao: '1.0.0', dhFatoGerador: `${data}T12:00:00-03:00`,
        municipio: Number(form.municipio.value), uf: form.uf.value, itens: linhas.map((l) => l.item),
      };
      loading(out);
      let res;
      try { res = await api.calcularRegimeRegular(op); } catch (err) { showError(out, err); return; }
      renderOperacao(out, res, linhas);
      reveal(out);
    });
  });
}

function renderOperacao(out, res, linhas) {
  const objs = new Map((res.data?.objetos || []).map((o) => [o.nObj, o]));
  const tot = { vBC: 0, vCBS: 0, vIBS: 0, vIS: 0 };
  let temInformado = false; let div = 0; let erros = 0;
  const rows = linhas.map((l, i) => {
    const o = objs.get(i + 1);
    const desc = `<b>${i + 1}.</b> ${esc(l.desc || '')}<br><span class="muted small">${l.item.ncm ? `NCM ${esc(l.item.ncm)}` : `NBS ${esc(l.item.nbs)}`} · cClassTrib ${esc(l.item.cClassTrib)}</span>`;
    if (!o?.tribCalc) { erros++; return `<tr><td>${desc}</td><td>${estadoBadge(o?.estadoItem || 'FALHA_TECNICA')}</td><td colspan="6">${errosHtml(o?.erros)}</td></tr>`; }
    const v = valoresRG(o);
    tot.vBC += v.vBC || 0; tot.vCBS += v.vCBS || 0; tot.vIBS += (v.vIBSUF || 0) + (v.vIBSMun || 0); tot.vIS += v.vIS || 0;
    const inf = l.inf;
    const has = Object.values(inf).some((x) => x != null);
    if (has) { temInformado = true; if (!itemConfere(inf, v, ['vCBS', 'vIBSUF', 'vIBSMun', 'vIS'])) div++; }
    const cell = (k, p) => (inf[k] != null ? cmpCell(inf[k], v[k]) : `<td class="n">${money(v[k])}${p != null ? `<br><span class="muted small">${pct(p)}</span>` : ''}</td>`);
    return `<tr><td>${desc}${memoriaHtml(v)}</td><td>${estadoBadge(o.estadoItem)}${v.pRed ? `<br><span class="muted small">redução de ${pct(v.pRed, 0)}</span>` : ''}</td>
      <td class="n">${money(v.vBC)}</td>${cell('vCBS', v.pCBS)}${cell('vIBSUF', v.pIBSUF)}${cell('vIBSMun', v.pIBSMun)}${l.item.impostoSeletivo ? cell('vIS', v.pIS) : '<td class="n muted">—</td>'}
      <td class="n"><b>${money((v.vCBS || 0) + (v.vIBSUF || 0) + (v.vIBSMun || 0) + (v.vIS || 0))}</b></td></tr>`;
  }).join('');
  const total = tot.vCBS + tot.vIBS + tot.vIS;
  const alertas = [];
  if (erros) alertas.push(`<div class="alert bad">${erros} item(ns) com erro de dados. Veja o motivo na tabela abaixo.</div>`);
  if (temInformado) alertas.push(`<div class="alert ${div ? 'warn' : 'ok'}">${div ? `<strong>${div} item(ns)</strong> com valor diferente do cálculo oficial.` : '<strong>Tudo certo:</strong> os valores que você informou conferem com a calculadora oficial.'}</div>`);
  out.innerHTML = `<div class="result">
    <h3 tabindex="-1">Resultado</h3>
    ${alertas.join('')}
    <div class="kpis">
      <div class="kpi"><span>Base de cálculo</span><b>${money(tot.vBC)}</b></div>
      <div class="kpi"><span>CBS</span><b>${money(tot.vCBS)}</b></div>
      <div class="kpi"><span>IBS (UF + Mun.)</span><b>${money(tot.vIBS)}</b></div>
      <div class="kpi"><span>Imposto Seletivo</span><b>${money(tot.vIS)}</b></div>
      <div class="kpi accent"><span>Total de tributos</span><b>${money(total)}</b><small>${tot.vBC ? `${pct((total / tot.vBC) * 100, 2, 2)} da base` : ''}</small></div>
    </div>
    <div class="table-wrap"><table>
      <caption class="sr-only">Resultado por item</caption>
      <thead><tr><th scope="col">Item</th><th scope="col">Situação</th><th scope="col" class="n">Base</th><th scope="col" class="n">CBS</th><th scope="col" class="n">IBS UF</th><th scope="col" class="n">IBS Mun.</th><th scope="col" class="n">IS</th><th scope="col" class="n">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ================================================================ REGULAR × SIMPLES
let atividades = [];
function initComparar() {
  const form = $('#cmp-form');
  form.data.value = hoje() < '2027-01-01' ? '2027-01-15' : hoje();
  const syncAliq = wireAliquotas(form);
  syncAliq();
  setupLocal(form);

  const tipoSync = () => {
    const servico = form.tipo.value === 'nbs';
    $('[data-codigo-label]', form).textContent = servico ? 'NBS' : 'NCM';
    $('[data-codigo-help]', form).textContent = servico ? 'Código de 9 dígitos do serviço.' : 'Código de 8 dígitos do produto.';
    if (servico && form.codigo.value === '94036000') form.codigo.value = '115013000';
    if (!servico && form.codigo.value === '115013000') form.codigo.value = '94036000';
    setErro(form.codigo, '');
    fillAtividades();
  };
  async function fillAtividades() {
    const sel = $('#cmp-ativ');
    const doc = form.tipo.value === 'nbs' ? '91' : '55';
    try {
      atividades = await api.atividadesSimples(form.data.value || hoje());
      const lista = atividades.filter((a) => a.disponivel !== false && (!a.tpDocsAdmissiveis?.length || a.tpDocsAdmissiveis.includes(doc)));
      const atual = sel.value;
      sel.innerHTML = lista.map((a) => `<option value="${esc(a.codigo)}">${esc(a.codigo)} · ${esc(a.descricao)} (Anexo ${esc(a.rotuloAnexo || a.anexoSemFatorR)})</option>`).join('');
      if (lista.some((a) => a.codigo === atual)) sel.value = atual;
    } catch {
      sel.innerHTML = '<option value="">Não foi possível carregar as atividades</option>';
    }
  }
  form.tipo.addEventListener('change', tipoSync);
  form.data.addEventListener('change', fillAtividades);
  fillAtividades();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validar(form)) return;
    const out = $('#cmp-result');
    withBusy(form, async () => {
      const data = form.data.value;
      const valor = parseNum(form.valor.value);
      const servico = form.tipo.value === 'nbs';
      const codigo = form.codigo.value.replace(/\D/g, '');
      const cClassTrib = form.cClassTrib.value.trim();

      // --- regime regular (CST = 3 primeiros dígitos do cClassTrib)
      const itemRG = { numero: 1, cst: cClassTrib.slice(0, 3), cClassTrib, baseCalculo: valor, [form.tipo.value]: codigo };
      if (ano(data) >= 2027) {
        itemRG.aliquotasNominais = { cbs: parseNum(form.aCbs.value) ?? 0, ibsEstadual: parseNum(form.aIbsUf.value) ?? 0, ibsMunicipal: parseNum(form.aIbsMun.value) ?? 0 };
      }
      const opRG = { id: `cmp-${Date.now()}`, versao: '1.0.0', dhFatoGerador: `${data}T12:00:00-03:00`, municipio: Number(form.municipio.value), uf: form.uf.value, itens: [itemRG] };

      // --- Simples Nacional (cálculo não assistido)
      const ativ = atividades.find((a) => a.codigo === form.cAtivSN.value);
      const anexo = ativ?.anexoSemFatorR || ativ?.anexoComFatorR || 'I';
      const par = { pCBSSN: numTxt(form.pCBSSN.value), pIBSSN: numTxt(form.pIBSSN.value) };
      const aliquotasEfetivas = { [`anexo${anexo}`]: par };
      if (ativ?.sujeitaFatorR) {
        aliquotasEfetivas.fatorR = false;
        if (ativ.anexoComFatorR) aliquotasEfetivas[`anexo${ativ.anexoComFatorR}`] = par;
      }
      const itemSN = { numero: 1, cAtivSN: form.cAtivSN.value, cClassTrib, baseCalculo: valor.toFixed(2), [form.tipo.value]: codigo };
      const opSN = { id: `cmp-${Date.now()}`, versao: '3.0.0', data, aliquotasEfetivas, itens: [itemSN] };
      if (servico) {
        Object.assign(opSN, { tpDoc: '91', opSimpNac: '3', regApIBSCBSSN: '1', regApTribSN: '1' });
        Object.assign(itemSN, { tribISSQN: '1', tpRetISSQN: '1' });
      } else {
        Object.assign(opSN, { tpDoc: '55', CRT: '1' });
        itemSN.valorImpostoSeletivo = '0.00';
      }

      loading(out, 'Calculando nas duas calculadoras oficiais…');
      const [rg, sn] = await Promise.allSettled([api.calcularRegimeRegular(opRG), api.calcularSimples(opSN)]);
      renderComparacao(out, { valor, rg, sn, ativ, servico });
      reveal(out);
    }, 'Comparando…');
  });
}

function renderComparacao(out, { valor, rg, sn, ativ, servico }) {
  const lado = (titulo, cor, corpo) => `<div class="card"><h4><span class="dot" style="background:${cor}"></span>${titulo}</h4>${corpo}</div>`;
  let rgTotal = null; let snTotal = null;
  let rgHtml; let snHtml;

  if (rg.status === 'fulfilled') {
    const o = rg.value.data?.objetos?.[0];
    if (o?.tribCalc) {
      const v = valoresRG(o);
      const ibs = (v.vIBSUF || 0) + (v.vIBSMun || 0);
      rgTotal = (v.vCBS || 0) + ibs;
      rgHtml = `<div class="rows">
        <span class="t">Base de cálculo</span><span class="v">${money(v.vBC)}</span>
        <span class="t">CBS (${pct(v.pCBS)})</span><span class="v">${money(v.vCBS)}</span>
        <span class="t">IBS UF (${pct(v.pIBSUF)})</span><span class="v">${money(v.vIBSUF)}</span>
        <span class="t">IBS Mun. (${pct(v.pIBSMun)})</span><span class="v">${money(v.vIBSMun)}</span>
        <span class="t total">CBS + IBS</span><span class="v total">${money(rgTotal)}</span>
        <span class="t">Carga sobre a venda</span><span class="v">${pct((rgTotal / valor) * 100, 2, 2)}</span>
        <span class="t">Crédito para o cliente*</span><span class="v">${money(rgTotal)}</span>
      </div>${memoriaHtml(v)}`;
    } else {
      rgHtml = `${estadoBadge(o?.estadoItem)}${errosHtml(o?.erros)}`;
    }
  } else rgHtml = `<div class="alert bad">${esc(rg.reason?.message)}</div>`;

  if (sn.status === 'fulfilled') {
    const d = sn.value.data;
    const o = d?.objetos?.[0];
    const t = o?.tribCalc;
    const res = d?.resolucaoAliquotas?.itens?.[0];
    if (t && o.estadoItem === 'CALCULADO') {
      snTotal = n(t.vCBSSN) + (n(t.vIBSSN) || 0);
      snHtml = `<div class="rows">
        <span class="t">Receita bruta do item</span><span class="v">${money(t.vRBSNitem)}</span>
        <span class="t">CBS (${pct(t.pCBSSN)})</span><span class="v">${money(t.vCBSSN)}</span>
        <span class="t">IBS (${pct(t.pIBSSN)})</span><span class="v">${money(t.vIBSSN)}</span>
        <span class="t total">CBS + IBS</span><span class="v total">${money(snTotal)}</span>
        <span class="t">Carga sobre a venda</span><span class="v">${pct((snTotal / valor) * 100, 2, 2)}</span>
        <span class="t">Crédito para o cliente*</span><span class="v">${money(snTotal)}</span>
      </div>
      <p class="help">${esc(ativ ? `Atividade ${ativ.codigo}, Anexo ${res?.anexoAplicado || ativ.rotuloAnexo}` : '')} · ${servico ? 'NFS-e' : 'NF-e'}</p>
      ${t.memoriaCalculo ? `<details class="memoria"><summary>Como foi calculado</summary><pre>${esc(`CBS: ${t.memoriaCalculo.cbs || ''}\n\nIBS: ${t.memoriaCalculo.ibs || ''}`)}</pre></details>` : ''}`;
    } else {
      const motivo = o?.motivoEstado ? `<p class="small">${esc(o.motivoEstado.descricao || o.motivoEstado.codigo)}</p>` : '';
      const globais = d?.erros || d?.errosGlobais;
      snHtml = `${estadoBadge(o?.estadoItem || 'FALHA_TECNICA')}${motivo}${errosHtml(o?.erros || globais)}`;
    }
  } else snHtml = `<div class="alert bad">${esc(sn.reason?.message)}</div>`;

  let destaque = '';
  if (rgTotal != null && snTotal != null) {
    const max = Math.max(rgTotal, snTotal, 0.01);
    const bar = (label, v, cor) => `<div class="bar-row"><span>${label}</span><div class="bar-track" aria-hidden="true"><div class="bar" style="width:${(v / max) * 100}%;background:${cor}"></div></div><span class="v">${money(v)}</span></div>`;
    const dif = rgTotal - snTotal;
    const msg = Math.abs(dif) < 0.005 ? 'Os dois regimes resultam no mesmo valor de CBS + IBS.'
      : `No <b>${dif > 0 ? 'Simples Nacional' : 'regime regular'}</b> a venda paga <b>${money(Math.abs(dif))} a menos</b> de CBS + IBS (${pct((Math.abs(dif) / valor) * 100, 2, 2)} do valor da venda).`;
    destaque = `<div class="card"><h3 tabindex="-1">CBS + IBS sobre uma venda de ${money(valor)}</h3><p class="lead">${msg}</p><div class="bars">
      ${bar('Regime regular', rgTotal, 'var(--series-1)')}${bar('Simples Nacional', snTotal, 'var(--series-2)')}</div>
      <p class="help">Mas atenção: no regime regular o seu cliente (se for empresa) recupera os ${money(rgTotal)} como crédito; no Simples, só ${money(snTotal)}. Veja a nota no fim da página.</p></div>`;
  }

  out.innerHTML = `<div class="result">${destaque || '<h3 tabindex="-1">Resultado</h3>'}<div class="cmp">
    ${lado('Regime regular', 'var(--series-1)', rgHtml)}
    ${lado('Simples Nacional', 'var(--series-2)', snHtml)}</div>
    <p class="help">* Crédito para o cliente: no regime regular o adquirente contribuinte se credita do IBS e da CBS destacados (quando a classificação permite); no Simples Nacional, o crédito fica limitado ao valor efetivamente pago pelo fornecedor no regime. Essa diferença pesa na escolha entre recolher IBS/CBS por dentro ou por fora do Simples em vendas para empresas. O Simples continua recolhendo os demais tributos do DAS, que não entram nesta comparação.</p>
  </div>`;
}

// ================================================================ CONSULTAS
let consultasIniciadas = false;
function initConsultas() {
  if (consultasIniciadas) return;
  consultasIniciadas = true;
  const qOut = $('#q-result');
  for (const f of [$('#q-classtrib'), $('#q-ncm')]) f.data.value = hoje();

  const consultarCT = (f) => withBusy(f, async () => {
    loading(qOut, 'Consultando…');
    try {
      const c = await api.classTrib(f.c.value.trim(), f.data.value);
      const linhas = [
        ['Descrição', c.descricao], ['Tratamento', c.descricaoTratamentoTributario], ['Tipo de alíquota', c.tipoAliquota],
        ['Redução CBS / IBS UF / IBS Mun.', `${pct(c.percentualReducaoCbs, 0)} / ${pct(c.percentualReducaoIbsUf, 0)} / ${pct(c.percentualReducaoIbsMun, 0)}`],
        ['Nomenclatura', c.nomenclatura], ['Cliente pode se creditar (CBS/IBS)', `${c.indicaApropriacaoCreditoAdquirenteCbs ? 'sim' : 'não'} / ${c.indicaApropriacaoCreditoAdquirenteIbs ? 'sim' : 'não'}`],
        ['Crédito na operação anterior', c.creditoOperacaoAntecedente],
        ['Documentos fiscais', (c.tiposDfeClassificacao || []).map((t) => t.sigla).join(', ')],
        ['Atualizado em', dataBR(c.dataAtualizacao)],
      ].filter(([, v]) => v != null && v !== '');
      qOut.innerHTML = `<div class="card result"><h3 tabindex="-1">cClassTrib ${esc(c.codigo)}</h3><dl class="dl">${linhas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
      reveal(qOut);
    } catch (err) { showError(qOut, err); }
  }, 'Consultando…');

  $('#q-classtrib').addEventListener('submit', (e) => { e.preventDefault(); if (validar(e.target)) consultarCT(e.target); });

  $('#q-ncm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const ncm = f.ncm.value.replace(/\D/g, '');
    if (!validar(f)) return;
    if (ncm.length < 2) { setErro(f.ncm, 'Digite ao menos 2 dígitos.'); return; }
    withBusy(f, async () => {
      loading(qOut, 'Consultando…');
      try {
        const r = await api.ncm(ncm, f.data.value);
        qOut.innerHTML = `<div class="card result"><h3 tabindex="-1">NCM ${esc(f.ncm.value)}</h3><dl class="dl">
          <dt>Capítulo</dt><dd>${esc(r.capitulo)}</dd>
          <dt>Descrição</dt><dd>${esc(r.subitem || r.item || r.posicao || '—')}</dd>
          <dt>Imposto Seletivo</dt><dd>${r.tributadoPeloImpostoSeletivo ? `<span class="badge warn">sujeito ao IS</span> ${r.temAliquotaAdValorem ? 'ad valorem' : ''}${r.temAliquotaAdRem ? ' · ad rem' : ''}` : '<span class="badge ok">não sujeito</span>'}${ano(f.data.value) < 2027 ? ' <span class="muted small">(o IS começa em 2027; mude a data para ver)</span>' : ''}</dd>
        </dl></div>`;
        reveal(qOut);
      } catch (err) { showError(qOut, err); }
    }, 'Consultando…');
  });

  const tbl = $('#ct-table');
  const filtro = $('#ct-filter');
  const contador = $('#ct-count');
  let lista = [];
  const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const render = () => {
    const q = semAcento(filtro.value.trim());
    const rows = lista.filter((c) => !q || c.codigo.includes(q) || semAcento(c.descricao).includes(q) || semAcento(c.descricaoTratamentoTributario).includes(q));
    contador.textContent = q ? `${rows.length} de ${lista.length} classificações` : `${lista.length} classificações. Clique em um código para ver os detalhes.`;
    if (!rows.length) { tbl.innerHTML = '<p class="muted" style="padding:12px">Nada encontrado. Tente outra palavra, sem abreviações.</p>'; return; }
    tbl.innerHTML = `<table><thead><tr><th scope="col">cClassTrib</th><th scope="col">Descrição</th><th scope="col">Tratamento</th><th scope="col" class="n">Red. CBS</th><th scope="col" class="n">Red. IBS</th><th scope="col">Documentos</th></tr></thead><tbody>
      ${rows.slice(0, 300).map((c) => `<tr><td><button type="button" class="link code" data-ver-ct="${esc(c.codigo)}">${esc(c.codigo)}</button></td><td>${esc(c.descricao)}</td><td>${esc(c.descricaoTratamentoTributario)}</td>
        <td class="n">${pct(c.percentualReducaoCbs, 0)}</td><td class="n">${pct(c.percentualReducaoIbsUf, 0)}</td>
        <td class="small">${esc((c.tiposDfeClassificacao || []).map((t) => t.sigla).join(', '))}</td></tr>`).join('')}
    </tbody></table>${rows.length > 300 ? '<p class="muted small" style="padding:8px">Mostrando 300 resultados; refine o filtro.</p>' : ''}`;
  };
  api.classificacoes(hoje()).then((l) => { lista = l; render(); }).catch((err) => showError(tbl, err));
  filtro.addEventListener('input', render);
  tbl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ver-ct]');
    if (!b) return;
    const f = $('#q-classtrib');
    f.c.value = b.dataset.verCt;
    updateCtHelp(f.c);
    consultarCT(f);
  });
}

// ================================================================ DANFSe
let pdfUrl = null;
function initDanfse() {
  const form = $('#danfse-form');
  const out = $('#danfse-result');
  const drop = $('.drop', form);
  const mostrarArquivo = () => {
    const f = form.xml.files[0];
    $('.drop-title', drop).textContent = f ? `📄 ${f.name}` : 'Escolher o XML da NFS-e';
    $('.drop-sub', drop).textContent = f ? 'Clique para trocar o arquivo' : 'Arraste aqui ou clique';
    drop.classList.toggle('has-file', !!f);
  };
  form.xml.addEventListener('change', mostrarArquivo);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) { form.xml.files = e.dataTransfer.files; mostrarArquivo(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validar(form)) return;
    const f = form.xml.files[0];
    withBusy(form, async () => {
      loading(out, 'Gerando o PDF…');
      try {
        const blob = await api.danfse(await f.text(), { stc: form.stc.value, canhoto: form.canhoto.checked });
        if (pdfUrl) URL.revokeObjectURL(pdfUrl);
        pdfUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        const nome = `${f.name.replace(/\.xml$/i, '')}-danfse.pdf`;
        out.innerHTML = `<div class="result"><div class="alert ok" tabindex="-1"><strong>PDF gerado.</strong> <a href="${pdfUrl}" download="${esc(nome)}">Baixar ${esc(nome)}</a></div>
          <iframe class="pdf-frame" src="${pdfUrl}" title="Pré-visualização do DANFSe"></iframe></div>`;
        reveal(out);
      } catch (err) { showError(out, err); }
    }, 'Gerando…');
  });
}

// ---------------------------------------------------------------- início
const secaoInicial = showTab();
if (secaoInicial) requestAnimationFrame(() => irParaSecao(secaoInicial));
initStatus();
initClassTrib();
initNFe();
initOperacao();
initComparar();
initDanfse();
