// Cliente das calculadoras oficiais (via proxy do nginx em /api/...).

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof Blob) {
      opts.body = body;
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError('Não foi possível conectar à calculadora. Tente novamente em instantes.', 0);
  }
  if (raw && res.ok) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 429) throw new ApiError('Muitas requisições em pouco tempo. Aguarde alguns segundos.', 429, data);
    throw new ApiError(describeError(data) || `Erro ${res.status} na calculadora.`, res.status, data);
  }
  return { data, headers: res.headers };
}

// Converte o corpo de erro (RFC 7807 / Problem Details e variações) em texto legível.
export function describeError(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, 400);
  const parts = [];
  if (data.title) parts.push(data.title);
  if (data.detail && data.detail !== data.title) parts.push(data.detail);
  if (data.message && !parts.length) parts.push(data.message);
  if (data.erro) parts.push(data.erro);
  const list = data.errors || data.erros || data.violations || data.invalidParams;
  if (Array.isArray(list)) {
    for (const e of list.slice(0, 8)) {
      parts.push([e.pointer || e.field || e.name, e.detail || e.message || e.reason || e.title].filter(Boolean).join(': '));
    }
  }
  return parts.join(' — ');
}

const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

export const api = {
  versao: () => request('/api/rg/dados-abertos/versao').then((r) => r.data),
  ufs: () => cached('ufs', () => request('/api/rg/dados-abertos/ufs').then((r) => r.data)),
  municipios: (uf) => cached(`mun:${uf}`, () =>
    request(`/api/rg/dados-abertos/ufs/municipios?siglaUf=${encodeURIComponent(uf)}`).then((r) => r.data)),
  classificacoes: (data) => cached(`ct:${data}`, () =>
    request(`/api/rg/dados-abertos/classificacoes-tributarias/cbs-ibs?data=${data}`).then((r) => r.data)),
  classTrib: (codigo, data) =>
    request(`/api/rg/dados-abertos/classificacoes-tributarias/cbs-ibs/class-trib/${encodeURIComponent(codigo)}?data=${data}`).then((r) => r.data),
  ncm: (ncm, data) =>
    request(`/api/rg/dados-abertos/ncm?ncm=${encodeURIComponent(ncm)}&data=${data}`).then((r) => r.data),
  atividadesSimples: (data) => cached(`ativ:${data}`, () =>
    request(`/api/sn/atividades?data=${data}`).then((r) => r.data)),

  // Regime regular — cálculo com observabilidade (erros por item, sem derrubar a operação)
  calcularRegimeRegular: (operacao) =>
    request('/api/rg/observabilidade/regime-geral', { method: 'POST', body: operacao }),

  // Simples Nacional — cálculo não assistido (contrato unificado NF-e / NFS-e)
  calcularSimples: (operacao) =>
    request('/api/sn/calculo-unificado', { method: 'POST', body: operacao }),

  danfse: async (xml, { stc = '0', canhoto = true } = {}) => {
    const res = await request(`/api/danfse?stc=${encodeURIComponent(stc)}&canhoto=${canhoto ? 'true' : 'false'}`, {
      method: 'POST', body: xml, headers: { 'Content-Type': 'application/xml', Accept: 'application/pdf, application/json' }, raw: true,
    });
    return res.blob();
  },
};
