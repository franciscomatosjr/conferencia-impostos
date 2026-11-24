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

function hoje() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const ano = (data) => Number(String(data).slice(0, 4));

function loading(el, msg = 'Calculando na calculadora oficial…') {
  el.innerHTML = `<div class="result"><p class="muted"><span class="spinner"></span>${esc(msg)}</p></div>`;
}
function showError(el, err) {
  const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
  el.innerHTML = `<div class="result"><div class="alert bad"><strong>Não foi possível concluir.</strong> ${esc(msg)}</div></div>`;
}
async function withBusy(form, fn) {
  const btn = $('button[type="submit"], button:not([type])', form);
  if (btn) btn.disabled = true;
  try { await fn(); } finally { if (btn) btn.disabled = false; }
}

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
  return `<ul class="small">${erros.map((e) => `<li><b>${esc(e.code || '')}</b> ${esc(e.title || '')}${e.detail ? ` — ${esc(e.detail)}` : ''}</li>`).join('')}</ul>`;
}

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
  return `<details class="memoria"><summary>memória de cálculo</summary><pre>${esc(parts.join('\n\n'))}</pre></details>`;
}

// Célula "nota × oficial" com destaque de diferença.
function cmpCell(informado, oficial) {
  if (informado == null && oficial == null) return '<td class="n muted">—</td>';
  if (informado == null) return `<td class="n">${money(oficial)}</td>`;
  if (oficial == null) return `<td class="n">${money(informado)}<br><span class="muted small">oficial: —</span></td>`;
  const diff = informado - oficial;
  const ok = Math.abs(diff) <= TOL + 1e-9;
  return `<td class="n ${ok ? 'diff-ok' : 'diff-bad'}">${money(informado)}<br><span class="small">${ok ? '✓ confere' : `oficial ${money(oficial)} (${diff > 0 ? '+' : ''}${money(diff)})`}</span></td>`;
}
function itemConfere(inf, ofi, campos) {
  return campos.every((c) => inf[c] == null || ofi[c] == null || Math.abs(inf[c] - ofi[c]) <= TOL + 1e-9);
}

// ---------------------------------------------------------------- abas
const TABS = ['nfe', 'operacao', 'comparar', 'consultas', 'danfse'];
function showTab() {
  const id = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'nfe';
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== id;
  for (const a of $$('.tabs a')) a.setAttribute('aria-selected', a.dataset.tab === id ? 'true' : 'false');
  if (id === 'consultas') initConsultas();
}
window.addEventListener('hashchange', showTab);

// ---------------------------------------------------------------- status
async function initStatus() {
  const el = $('#status');
  try {
    const v = await api.versao();
    el.textContent = `Calculadora ${v.versaoApp} · base ${v.versaoDb}`;
    el.title = `${v.descricaoVersaoDb || ''} (base de ${v.dataVersaoDb || '?'})`;
    el.classList.add('on');
  } catch {
    el.textContent = 'calculadora indisponível';
    el.classList.add('off');
  }
}

// ---------------------------------------------------------------- UF / município
async function fillUfs(select, preferida = 'SP') {
  try {
    const ufs = await api.ufs();
    select.innerHTML = ufs.sort((a, b) => a.sigla.localeCompare(b.sigla))
      .map((u) => `<option value="${esc(u.sigla)}" data-codigo="${u.codigo}">${esc(u.sigla)}</option>`).join('');
  } catch {
    select.innerHTML = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO']
      .map((s) => `<option>${s}</option>`).join('');
  }
  select.value = preferida;
}
// Transforma o input de município em busca com datalist (nome → código IBGE).
function wireMunicipio(form) {
  const uf = $('select[name="uf"]', form);
  const mun = $('input[name="municipio"]', form);
  const dl = document.createElement('datalist');
  dl.id = `dl-mun-${form.id}`;
  form.append(dl);
  mun.setAttribute('list', dl.id);
  const capitais = { AC: 1200401, AL: 2704302, AM: 1302603, AP: 1600303, BA: 2927408, CE: 2304400, DF: 5300108, ES: 3205309, GO: 5208707, MA: 2111300, MG: 3106200, MS: 5002704, MT: 5103403, PA: 1501402, PB: 2507507, PE: 2611606, PI: 2211001, PR: 4106902, RJ: 3304557, RN: 2408102, RO: 1100205, RR: 1400100, RS: 4314902, SC: 4205407, SE: 2800308, SP: 3550308, TO: 1721000 };
  async function load(setCapital) {
    try {
      const lista = await api.municipios(uf.value);
      dl.innerHTML = lista.map((m) => `<option value="${m.codigo}">${esc(m.nome)}</option>`).join('');
    } catch { dl.innerHTML = ''; }
    if (setCapital && capitais[uf.value]) mun.value = capitais[uf.value];
  }
  uf.addEventListener('change', () => load(true));
  return load;
}

// Alíquotas nominais só existem a partir de 2027.
function wireAliquotas(form) {
  const data = $('input[name="data"]', form);
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

// ---------------------------------------------------------------- classificações (datalist)
async function fillClassTribDatalist() {
  try {
    const lista = await api.classificacoes(hoje() < '2027-01-01' ? '2027-01-01' : hoje());
    $('#dl-classtrib').innerHTML = lista.map((c) => `<option value="${esc(c.codigo)}">${esc(c.codigo)} · ${esc((c.descricao || '').slice(0, 90))}</option>`).join('');
  } catch { /* opcional */ }
}

// ================================================================ CONFERIR NF-e
function initNFe() {
  const drop = $('#nfe-drop');
  const input = $('#nfe-file');
  const out = $('#nfe-result');

  const handle = async (files) => {
    if (!files.length) return;
    out.innerHTML = '';
    for (const f of files) {
      const box = document.createElement('div');
      out.append(box);
      if (f.size > 2 * 1024 * 1024) { showError(box, new Error(`${f.name}: arquivo maior que 2 MB.`)); continue; }
      await conferirNota(await f.text(), f.name, box);
    }
  };
  input.addEventListener('change', () => handle([...input.files]).finally(() => { input.value = ''; }));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); handle([...e.dataTransfer.files]); });
  $('#nfe-exemplo').addEventListener('click', () => {
    out.innerHTML = '';
    const box = document.createElement('div');
    out.append(box);
    conferirNota(NFE_EXEMPLO, 'nota-exemplo.xml', box);
  });
}

async function conferirNota(xml, fileName, box) {
  let nota;
  try {
    nota = parseNFe(xml, fileName);
  } catch (e) { showError(box, new Error(`${fileName}: ${e.message}`)); return; }

  const head = `<div class="doc-head"><h3>NF-e ${esc(nota.numero || '')}${nota.serie ? ` · série ${esc(nota.serie)}` : ''} <span class="muted small">(modelo ${esc(nota.modelo || '?')})</span></h3>
    <span class="doc-meta">${esc(nota.emitente || '')}${nota.cnpj ? ` · ${esc(nota.cnpj)}` : ''} · emitida em ${esc((nota.dhEmi || '').slice(0, 10).split('-').reverse().join('/'))} · município ${esc(nota.cMunFG || '?')}/${esc(nota.uf || '?')}</span></div>`;

  const avisos = [];
  if (['1', '2', '4'].includes(nota.crt)) avisos.push('O emitente é do Simples Nacional (CRT ' + esc(nota.crt) + '). Esta conferência usa a calculadora do <b>regime regular</b>; para o Simples, use a aba “Regular × Simples”.');
  if (nota.compraGov) avisos.push('A nota tem compra governamental (gCompraGov); o redutor não é considerado nesta conferência.');
  const semGrupo = nota.itens.filter((i) => !i.temIBSCBS);
  const mono = nota.itens.filter((i) => i.monofasico);
  if (semGrupo.length) avisos.push(`${semGrupo.length} item(ns) sem grupo IBSCBS (nota emitida antes da reforma ou sem destaque).`);
  if (mono.length) avisos.push(`${mono.length} item(ns) em regime monofásico (combustíveis) não são conferidos aqui.`);

  const op = operacaoDaNota(nota);
  if (!op.itens.length) {
    box.innerHTML = `${head}<div class="alert warn">Nenhum item com grupo IBSCBS para conferir.${avisos.length ? `<ul>${avisos.map((a) => `<li>${a}</li>`).join('')}</ul>` : ''}</div>`;
    return;
  }
  if (!op.uf || !op.municipio) { box.innerHTML = head; showError(box, new Error('Não encontrei o município do fato gerador (ide/cMunFG).')); return; }

  loading(box);
  let res;
  try {
    res = await api.calcularRegimeRegular(op);
  } catch (e) { showError(box, e); box.insertAdjacentHTML('afterbegin', head); return; }

  const objs = new Map((res.data?.objetos || []).map((o) => [o.nObj, o]));
  const campos = ['vBC', 'vIBSUF', 'vIBSMun', 'vCBS', 'vIS'];
  let okCount = 0; let divCount = 0; let errCount = 0;
  const soma = { nota: { vBC: 0, vIBS: 0, vCBS: 0, vIS: 0 }, ofi: { vBC: 0, vIBS: 0, vCBS: 0, vIS: 0 } };

  const rows = nota.itens.map((it) => {
    const inf = it.nota ? { ...it.nota, vIS: it.is?.vIS ?? null } : null;
    const desc = `<b>${it.numero}</b> · ${esc(it.xProd || it.cProd || '')}<br><span class="muted small">NCM ${esc(it.ncm || '—')} · CST ${esc(it.cst || '—')} · cClassTrib ${esc(it.cClassTrib || '—')}</span>`;
    if (!inf || it.monofasico) {
      return `<tr><td>${desc}</td><td><span class="badge warn">não conferido</span></td><td colspan="5" class="muted small">${it.monofasico ? 'Tributação monofásica' : 'Sem grupo IBSCBS'}</td></tr>`;
    }
    soma.nota.vBC += inf.vBC || 0; soma.nota.vIBS += (inf.vIBSUF || 0) + (inf.vIBSMun || 0); soma.nota.vCBS += inf.vCBS || 0; soma.nota.vIS += inf.vIS || 0;
    const o = objs.get(it.numero);
    if (!o || !o.tribCalc) {
      errCount++;
      return `<tr><td>${desc}</td><td>${estadoBadge(o?.estadoItem || 'FALHA_TECNICA')}</td><td colspan="5">${errosHtml(o?.erros) || '<span class="muted small">Sem retorno da calculadora.</span>'}</td></tr>`;
    }
    const ofi = valoresRG(o);
    soma.ofi.vBC += ofi.vBC || 0; soma.ofi.vIBS += (ofi.vIBSUF || 0) + (ofi.vIBSMun || 0); soma.ofi.vCBS += ofi.vCBS || 0; soma.ofi.vIS += ofi.vIS || 0;
    const confere = itemConfere(inf, ofi, campos);
    if (confere) okCount++; else divCount++;
    return `<tr><td>${desc}${memoriaHtml(ofi)}</td><td>${confere ? '<span class="badge ok">confere</span>' : '<span class="badge bad">divergente</span>'}</td>
      ${cmpCell(inf.vBC, ofi.vBC)}${cmpCell(inf.vCBS, ofi.vCBS)}${cmpCell(inf.vIBSUF, ofi.vIBSUF)}${cmpCell(inf.vIBSMun, ofi.vIBSMun)}${cmpCell(inf.vIS, it.is ? ofi.vIS : null)}</tr>`;
  }).join('');

  const total = nota.itens.length;
  const resumo = errCount ? 'bad' : divCount ? 'warn' : 'ok';
  const resumoTxt = errCount || divCount
    ? `${okCount} de ${total} itens conferem. ${divCount ? `${divCount} com valores divergentes. ` : ''}${errCount ? `${errCount} com inconsistência de classificação/entrada.` : ''}`
    : `Todos os ${okCount} itens conferem com a calculadora oficial.`;
  const simulado = res.headers.get('x-warning-dados-simulados')
    ? '<p class="muted small">Ano a partir de 2027: o cálculo usou as alíquotas nominais destacadas na própria nota (resultado “simulado”, conforme a calculadora).</p>' : '';

  box.innerHTML = `${head}
    ${avisos.length ? `<div class="alert warn"><ul>${avisos.map((a) => `<li>${a}</li>`).join('')}</ul></div>` : ''}
    <div class="alert ${resumo}">${esc(resumoTxt)}</div>
    <div class="kpis">
      <div class="kpi"><span>CBS na nota</span><b>${money(soma.nota.vCBS)}</b><small>oficial: ${money(soma.ofi.vCBS)}</small></div>
      <div class="kpi"><span>IBS na nota</span><b>${money(soma.nota.vIBS)}</b><small>oficial: ${money(soma.ofi.vIBS)}</small></div>
      <div class="kpi"><span>IS na nota</span><b>${money(soma.nota.vIS)}</b><small>oficial: ${money(soma.ofi.vIS)}</small></div>
      <div class="kpi"><span>Diferença total</span><b>${money((soma.nota.vCBS + soma.nota.vIBS + soma.nota.vIS) - (soma.ofi.vCBS + soma.ofi.vIBS + soma.ofi.vIS))}</b><small>nota − oficial (itens calculados)</small></div>
    </div>
    ${simulado}
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Situação</th><th class="n">Base (vBC)</th><th class="n">CBS</th><th class="n">IBS UF</th><th class="n">IBS Mun.</th><th class="n">IS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="muted small">Valores na nota em cada célula; em verde quando batem com o cálculo oficial (tolerância de R$ 0,01), em vermelho com o valor oficial e a diferença.</p>`;
}

// ================================================================ SIMULAR OPERAÇÃO
let itemSeq = 0;
function itemTemplate(d = {}) {
  itemSeq++;
  const id = `it${itemSeq}`;
  return `<div class="item" data-item>
    <div class="item-top"><b>Item</b><button type="button" class="x" title="Remover item" data-remove>×</button></div>
    <div class="grid g4">
      <label>Descrição (opcional)<input name="desc" value="${esc(d.desc || '')}"></label>
      <label>Tipo<select name="tipo"><option value="ncm"${d.tipo !== 'nbs' ? ' selected' : ''}>NCM (mercadoria)</option><option value="nbs"${d.tipo === 'nbs' ? ' selected' : ''}>NBS (serviço)</option></select></label>
      <label>Código NCM/NBS<input name="codigo" inputmode="numeric" required value="${esc(d.codigo || '')}"></label>
      <label>cClassTrib<input name="cClassTrib" inputmode="numeric" pattern="\\d{6}" required list="dl-classtrib" value="${esc(d.cClassTrib || '000001')}"></label>
    </div>
    <div class="grid g4">
      <label>Base de cálculo (R$)<input name="base" type="number" step="0.01" min="0" ${d.is ? 'disabled placeholder="base do IS + IS"' : 'required'} value="${esc(d.base ?? '')}"></label>
      <label>Quantidade<input name="qtd" type="number" step="0.0001" min="0" value="${esc(d.qtd ?? '')}"></label>
      <label>Unidade<input name="un" maxlength="6" value="${esc(d.un || '')}"></label>
      <label class="check"><input type="checkbox" name="temIS"${d.is ? ' checked' : ''}> Tem Imposto Seletivo</label>
    </div>
    <div class="grid g4" data-is ${d.is ? '' : 'hidden'}>
      <label>cClassTrib do IS<input name="isClass" inputmode="numeric" pattern="\\d{6}" value="${esc(d.is?.cClassTrib || '000001')}"></label>
      <label>Base do IS (R$)<input name="isBase" type="number" step="0.01" min="0"${d.is ? ' required' : ''} value="${esc(d.is?.base ?? '')}"></label>
      <p class="muted small span2">Com IS, a base da CBS/IBS é a base do IS + o IS calculado. Se informar o IS já calculado abaixo, ele é conferido.</p>
    </div>
    <details${d.inf ? ' open' : ''}><summary>Conferir valores já calculados (opcional)</summary>
      <div class="grid g4">
        <label>CBS informada<input name="iCBS" type="number" step="0.01" value="${esc(d.inf?.vCBS ?? '')}"></label>
        <label>IBS UF informado<input name="iIBSUF" type="number" step="0.01" value="${esc(d.inf?.vIBSUF ?? '')}"></label>
        <label>IBS Mun. informado<input name="iIBSMun" type="number" step="0.01" value="${esc(d.inf?.vIBSMun ?? '')}"></label>
        <label>IS informado<input name="iIS" type="number" step="0.01" value="${esc(d.inf?.vIS ?? '')}"></label>
      </div>
    </details>
  </div>`;
}
function addItem(d) {
  $('#op-items').insertAdjacentHTML('beforeend', itemTemplate(d));
  renumber();
}
function renumber() {
  $$('#op-items [data-item]').forEach((el, i) => { $('.item-top b', el).textContent = `Item ${i + 1}`; });
}

function initOperacao() {
  const form = $('#op-form');
  form.data.value = hoje();
  const syncAliq = wireAliquotas(form);
  syncAliq();
  fillUfs(form.uf).then(() => { form.municipio.value = '3550308'; wireMunicipio(form)(false); });
  addItem({ codigo: '94036000', cClassTrib: '000001', base: '1000.00' });

  $('#op-add').addEventListener('click', () => addItem());
  $('#op-items').addEventListener('click', (e) => {
    if (e.target.closest('[data-remove]')) {
      if ($$('#op-items [data-item]').length > 1) { e.target.closest('[data-item]').remove(); renumber(); }
    }
  });
  $('#op-items').addEventListener('change', (e) => {
    if (e.target.name === 'temIS') {
      const el = e.target.closest('[data-item]');
      const on = e.target.checked;
      $('[data-is]', el).hidden = !on;
      const base = $('[name="base"]', el);
      base.disabled = on; base.required = !on;
      base.placeholder = on ? 'base do IS + IS' : '';
      $('[name="isBase"]', el).required = on;
    }
  });
  $('#op-exemplo').addEventListener('click', () => {
    form.data.value = '2027-03-10';
    syncAliq();
    form.uf.value = 'RS'; form.municipio.value = '4314902';
    form.aIs.value = '10';
    $('#op-items').innerHTML = '';
    addItem({ desc: 'Arroz (cesta básica)', codigo: '10063021', cClassTrib: '200003', base: '100.00', qtd: 20, un: 'KG' });
    addItem({ desc: 'Cerveja', codigo: '22030000', cClassTrib: '000001', qtd: 12, un: 'LT', is: { cClassTrib: '000001', base: '150.00' }, inf: { vCBS: '13.20', vIS: '15.00' } });
    addItem({ desc: 'Serviço de educação', tipo: 'nbs', codigo: '122011200', cClassTrib: '200028', base: '1200.00', inf: { vCBS: '42.24', vIBSUF: '0.24', vIBSMun: '0.24' } });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const out = $('#op-result');
    withBusy(form, async () => {
      const data = form.data.value;
      const exige = ano(data) >= 2027;
      const aliq = exige ? {
        cbs: n(form.aCbs.value) ?? 0, ibsEstadual: n(form.aIbsUf.value) ?? 0, ibsMunicipal: n(form.aIbsMun.value) ?? 0,
      } : null;
      const aIs = n(form.aIs.value);
      const linhas = $$('#op-items [data-item]').map((el, i) => {
        const f = (name) => $(`[name="${name}"]`, el).value.trim();
        const temIS = $('[name="temIS"]', el).checked;
        const item = {
          numero: i + 1,
          cst: f('cClassTrib').slice(0, 3),
          cClassTrib: f('cClassTrib'),
        };
        if (!temIS) item.baseCalculo = n(f('base'));
        item[f('tipo')] = f('codigo').replace(/\D/g, '');
        if (f('qtd')) item.quantidade = n(f('qtd'));
        if (f('un')) item.unidade = f('un').toUpperCase();
        if (temIS) {
          item.impostoSeletivo = {
            cst: f('isClass').slice(0, 3), cClassTrib: f('isClass'), baseCalculo: n(f('isBase')) ?? 0,
            ...(n(f('iIS')) != null ? { impostoInformado: n(f('iIS')) } : {}),
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
          inf: { vCBS: n(f('iCBS')), vIBSUF: n(f('iIBSUF')), vIBSMun: n(f('iIBSMun')), vIS: n(f('iIS')) },
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
    });
  });
}

function renderOperacao(out, res, linhas) {
  const objs = new Map((res.data?.objetos || []).map((o) => [o.nObj, o]));
  const tot = { vBC: 0, vCBS: 0, vIBS: 0, vIS: 0 };
  let temInformado = false; let div = 0;
  const rows = linhas.map((l, i) => {
    const o = objs.get(i + 1);
    const desc = `<b>${i + 1}</b>${l.desc ? ` · ${esc(l.desc)}` : ''}<br><span class="muted small">${l.item.ncm ? `NCM ${esc(l.item.ncm)}` : `NBS ${esc(l.item.nbs)}`} · cClassTrib ${esc(l.item.cClassTrib)}</span>`;
    if (!o?.tribCalc) return `<tr><td>${desc}</td><td>${estadoBadge(o?.estadoItem || 'FALHA_TECNICA')}</td><td colspan="6">${errosHtml(o?.erros)}</td></tr>`;
    const v = valoresRG(o);
    tot.vBC += v.vBC || 0; tot.vCBS += v.vCBS || 0; tot.vIBS += (v.vIBSUF || 0) + (v.vIBSMun || 0); tot.vIS += v.vIS || 0;
    const inf = l.inf;
    const has = Object.values(inf).some((x) => x != null);
    if (has) { temInformado = true; if (!itemConfere(inf, v, ['vCBS', 'vIBSUF', 'vIBSMun', 'vIS'])) div++; }
    const cell = (k, p) => (inf[k] != null ? cmpCell(inf[k], v[k]) : `<td class="n">${money(v[k])}${p != null ? `<br><span class="muted small">${pct(p)}</span>` : ''}</td>`);
    return `<tr><td>${desc}${memoriaHtml(v)}</td><td>${estadoBadge(o.estadoItem)}${v.pRed ? `<br><span class="muted small">redução ${pct(v.pRed, 0)}</span>` : ''}</td>
      <td class="n">${money(v.vBC)}</td>${cell('vCBS', v.pCBS)}${cell('vIBSUF', v.pIBSUF)}${cell('vIBSMun', v.pIBSMun)}${l.item.impostoSeletivo ? cell('vIS', v.pIS) : '<td class="n muted">—</td>'}
      <td class="n"><b>${money((v.vCBS || 0) + (v.vIBSUF || 0) + (v.vIBSMun || 0) + (v.vIS || 0))}</b></td></tr>`;
  }).join('');
  const total = tot.vCBS + tot.vIBS + tot.vIS;
  out.innerHTML = `<div class="result">
    ${temInformado ? `<div class="alert ${div ? 'warn' : 'ok'}">${div ? `${div} item(ns) com valor informado diferente do cálculo oficial.` : 'Todos os valores informados conferem com a calculadora oficial.'}</div>` : ''}
    <div class="kpis">
      <div class="kpi"><span>Base de cálculo</span><b>${money(tot.vBC)}</b></div>
      <div class="kpi"><span>CBS</span><b>${money(tot.vCBS)}</b></div>
      <div class="kpi"><span>IBS (UF + Mun.)</span><b>${money(tot.vIBS)}</b></div>
      <div class="kpi"><span>Imposto Seletivo</span><b>${money(tot.vIS)}</b></div>
      <div class="kpi"><span>Total de tributos</span><b>${money(total)}</b><small>${tot.vBC ? `carga ${pct((total / tot.vBC) * 100, 2, 2)} sobre a base` : ''}</small></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Situação</th><th class="n">Base</th><th class="n">CBS</th><th class="n">IBS UF</th><th class="n">IBS Mun.</th><th class="n">IS</th><th class="n">Total</th></tr></thead>
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
  fillUfs(form.uf).then(() => { form.municipio.value = '3550308'; wireMunicipio(form)(false); });

  const tipoSync = () => {
    const servico = form.tipo.value === 'nbs';
    $('[data-codigo-label]', form).textContent = servico ? 'NBS' : 'NCM';
    if (servico && form.codigo.value === '94036000') form.codigo.value = '115013000';
    if (!servico && form.codigo.value === '115013000') form.codigo.value = '94036000';
    fillAtividades();
  };
  async function fillAtividades() {
    const sel = $('#cmp-ativ');
    const doc = form.tipo.value === 'nbs' ? '91' : '55';
    try {
      atividades = await api.atividadesSimples(form.data.value || hoje());
      const lista = atividades.filter((a) => a.disponivel !== false && (!a.tpDocsAdmissiveis?.length || a.tpDocsAdmissiveis.includes(doc)));
      const atual = sel.value;
      sel.innerHTML = lista.map((a) => `<option value="${esc(a.codigo)}">${esc(a.codigo)} · Anexo ${esc(a.rotuloAnexo || a.anexoSemFatorR)} · ${esc(a.descricao)}</option>`).join('');
      if (lista.some((a) => a.codigo === atual)) sel.value = atual;
    } catch (e) {
      sel.innerHTML = '<option value="">não foi possível carregar</option>';
    }
  }
  form.tipo.addEventListener('change', tipoSync);
  form.data.addEventListener('change', fillAtividades);
  fillAtividades();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const out = $('#cmp-result');
    withBusy(form, async () => {
      const data = form.data.value;
      const valor = n(form.valor.value);
      const servico = form.tipo.value === 'nbs';
      const codigo = form.codigo.value.replace(/\D/g, '');
      const cClassTrib = form.cClassTrib.value.trim();

      // --- regime regular
      const itemRG = { numero: 1, cst: form.cst.value.trim() || cClassTrib.slice(0, 3), cClassTrib, baseCalculo: valor, [form.tipo.value]: codigo };
      if (ano(data) >= 2027) {
        itemRG.aliquotasNominais = { cbs: n(form.aCbs.value) ?? 0, ibsEstadual: n(form.aIbsUf.value) ?? 0, ibsMunicipal: n(form.aIbsMun.value) ?? 0 };
      }
      const opRG = { id: `cmp-${Date.now()}`, versao: '1.0.0', dhFatoGerador: `${data}T12:00:00-03:00`, municipio: Number(form.municipio.value), uf: form.uf.value, itens: [itemRG] };

      // --- Simples Nacional (cálculo não assistido)
      const ativ = atividades.find((a) => a.codigo === form.cAtivSN.value);
      const anexo = ativ?.anexoSemFatorR || ativ?.anexoComFatorR || 'I';
      const par = { pCBSSN: form.pCBSSN.value.trim().replace(',', '.'), pIBSSN: form.pIBSSN.value.trim().replace(',', '.') };
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
    });
  });
}

function renderComparacao(out, { valor, rg, sn, ativ, servico }) {
  const lado = (titulo, cor, corpo) => `<div class="card"><h3><span class="dot" style="background:${cor}"></span>${titulo}</h3>${corpo}</div>`;
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
      <p class="muted small">${esc(ativ ? `Atividade ${ativ.codigo} · Anexo ${res?.anexoAplicado || ativ.rotuloAnexo}` : '')}${res?.tipoAliquota ? ` · ${esc(res.tipoAliquota.replaceAll('_', ' ').toLowerCase().replace('unico', 'único').replace('redistribuicao', 'redistribuição'))}` : ''} · ${servico ? 'NFS-e' : 'NF-e'}</p>
      ${t.memoriaCalculo ? `<details class="memoria"><summary>memória de cálculo</summary><pre>${esc(`CBS: ${t.memoriaCalculo.cbs || ''}\n\nIBS: ${t.memoriaCalculo.ibs || ''}`)}</pre></details>` : ''}`;
    } else {
      const motivo = o?.motivoEstado ? `<p class="small">${esc(o.motivoEstado.descricao || o.motivoEstado.codigo)}</p>` : '';
      const globais = d?.erros || d?.errosGlobais;
      snHtml = `${estadoBadge(o?.estadoItem || 'FALHA_TECNICA')}${motivo}${errosHtml(o?.erros || globais)}`;
    }
  } else snHtml = `<div class="alert bad">${esc(sn.reason?.message)}</div>`;

  let barras = '';
  if (rgTotal != null && snTotal != null) {
    const max = Math.max(rgTotal, snTotal, 0.01);
    const bar = (label, v, cor) => `<div class="bar-row"><span>${label}</span><div class="bar-track"><div class="bar" style="width:${(v / max) * 100}%;background:${cor}"></div></div><span class="v">${money(v)}</span></div>`;
    const dif = rgTotal - snTotal;
    const msg = Math.abs(dif) < 0.005 ? 'Os dois regimes resultam no mesmo valor de CBS + IBS.'
      : `No <b>${dif > 0 ? 'Simples Nacional' : 'regime regular'}</b> a venda paga <b>${money(Math.abs(dif))}</b> a menos de CBS + IBS (${pct((Math.abs(dif) / valor) * 100, 2, 2)} da venda).`;
    barras = `<div class="card"><h3>CBS + IBS sobre ${money(valor)}</h3><div class="bars">
      ${bar('Regime regular', rgTotal, 'var(--series-1)')}${bar('Simples Nacional', snTotal, 'var(--series-2)')}</div><p>${msg}</p></div>`;
  }

  out.innerHTML = `<div class="result">${barras}<div class="cmp">
    ${lado('Regime regular', 'var(--series-1)', rgHtml)}
    ${lado('Simples Nacional', 'var(--series-2)', snHtml)}</div>
    <p class="muted small">* Crédito para o cliente: no regime regular o adquirente contribuinte se credita do IBS e da CBS destacados (quando a classificação permite); no Simples Nacional, o crédito fica limitado ao valor efetivamente pago pelo fornecedor no regime. Essa diferença pesa na escolha entre recolher IBS/CBS por dentro ou por fora do Simples em vendas para empresas. O Simples continua recolhendo os demais tributos do DAS, que não entram nesta comparação.</p>
  </div>`;
}

// ================================================================ CONSULTAS
let consultasIniciadas = false;
function initConsultas() {
  if (consultasIniciadas) return;
  consultasIniciadas = true;
  const qOut = $('#q-result');
  for (const f of [$('#q-classtrib'), $('#q-ncm')]) f.data.value = hoje();

  $('#q-classtrib').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      loading(qOut, 'Consultando…');
      try {
        const c = await api.classTrib(f.c.value.trim(), f.data.value);
        const linhas = [
          ['Código', c.codigo], ['Descrição', c.descricao], ['Tratamento', c.descricaoTratamentoTributario], ['Tipo de alíquota', c.tipoAliquota],
          ['Redução CBS / IBS UF / IBS Mun.', `${pct(c.percentualReducaoCbs, 0)} / ${pct(c.percentualReducaoIbsUf, 0)} / ${pct(c.percentualReducaoIbsMun, 0)}`],
          ['Nomenclatura', c.nomenclatura], ['Crédito do adquirente (CBS/IBS)', `${c.indicaApropriacaoCreditoAdquirenteCbs ? 'sim' : 'não'} / ${c.indicaApropriacaoCreditoAdquirenteIbs ? 'sim' : 'não'}`],
          ['Crédito na operação antecedente', c.creditoOperacaoAntecedente],
          ['Documentos', (c.tiposDfeClassificacao || []).map((t) => t.sigla).join(', ')],
          ['Atualizado em', c.dataAtualizacao],
        ].filter(([, v]) => v != null && v !== '');
        qOut.innerHTML = `<div class="card"><h3>cClassTrib ${esc(c.codigo)}</h3><div class="rows">${linhas.map(([k, v]) => `<span class="t">${esc(k)}</span><span class="v" style="text-align:left">${esc(v)}</span>`).join('')}</div></div>`;
      } catch (err) { showError(qOut, err); }
    });
  });

  $('#q-ncm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      loading(qOut, 'Consultando…');
      try {
        const r = await api.ncm(f.ncm.value.replace(/\D/g, ''), f.data.value);
        qOut.innerHTML = `<div class="card"><h3>NCM ${esc(f.ncm.value)}</h3><div class="rows">
          <span class="t">Capítulo</span><span class="v" style="text-align:left">${esc(r.capitulo)}</span>
          <span class="t">Descrição</span><span class="v" style="text-align:left">${esc(r.subitem || r.item || r.posicao || '—')}</span>
          <span class="t">Imposto Seletivo</span><span class="v" style="text-align:left">${r.tributadoPeloImpostoSeletivo ? `<span class="badge warn">sujeito ao IS</span> ${r.temAliquotaAdValorem ? 'ad valorem' : ''}${r.temAliquotaAdRem ? ' · ad rem' : ''}` : '<span class="badge ok">não sujeito</span>'}</span>
        </div></div>`;
      } catch (err) { showError(qOut, err); }
    });
  });

  const tbl = $('#ct-table');
  const filtro = $('#ct-filter');
  let lista = [];
  const render = () => {
    const q = filtro.value.trim().toLowerCase();
    const rows = lista.filter((c) => !q || c.codigo.includes(q) || (c.descricao || '').toLowerCase().includes(q) || (c.descricaoTratamentoTributario || '').toLowerCase().includes(q));
    tbl.innerHTML = `<table><thead><tr><th>cClassTrib</th><th>Descrição</th><th>Tratamento</th><th class="n">Red. CBS</th><th class="n">Red. IBS</th><th>Documentos</th></tr></thead><tbody>
      ${rows.slice(0, 300).map((c) => `<tr><td><code>${esc(c.codigo)}</code></td><td>${esc(c.descricao)}</td><td>${esc(c.descricaoTratamentoTributario)}</td>
        <td class="n">${pct(c.percentualReducaoCbs, 0)}</td><td class="n">${pct(c.percentualReducaoIbsUf, 0)}</td>
        <td class="small">${esc((c.tiposDfeClassificacao || []).map((t) => t.sigla).join(', '))}</td></tr>`).join('')}
    </tbody></table>${rows.length > 300 ? '<p class="muted small" style="padding:8px">Mostrando 300 resultados; refine o filtro.</p>' : ''}`;
  };
  api.classificacoes(hoje()).then((l) => { lista = l; render(); }).catch((err) => showError(tbl, err));
  filtro.addEventListener('input', render);
}

// ================================================================ DANFSe
let pdfUrl = null;
function initDanfse() {
  const form = $('#danfse-form');
  const out = $('#danfse-result');
  const drop = $('.drop', form);
  form.xml.addEventListener('change', () => {
    const f = form.xml.files[0];
    $('.drop-title', drop).textContent = f ? f.name : 'Escolher XML da NFS-e';
    drop.classList.toggle('has-file', !!f);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = form.xml.files[0];
    if (!f) return;
    withBusy(form, async () => {
      loading(out, 'Gerando o PDF…');
      try {
        const blob = await api.danfse(await f.text(), { stc: form.stc.value, canhoto: form.canhoto.checked });
        if (pdfUrl) URL.revokeObjectURL(pdfUrl);
        pdfUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        const nome = f.name.replace(/\.xml$/i, '') + '-danfse.pdf';
        out.innerHTML = `<div class="result"><div class="actions" style="margin-bottom:12px"><a class="btn" href="${pdfUrl}" download="${esc(nome)}">Baixar PDF</a></div>
          <iframe class="pdf-frame" src="${pdfUrl}" title="DANFSe"></iframe></div>`;
      } catch (err) { showError(out, err); }
    });
  });
}

// ---------------------------------------------------------------- início
showTab();
initStatus();
fillClassTribDatalist();
initNFe();
initOperacao();
initComparar();
initDanfse();
