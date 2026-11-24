// Leitura do XML da NF-e / NFC-e (leiaute da Reforma Tributária, NT 2025.002) no navegador.

export const UF_POR_CODIGO = {
  11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO',
  21: 'MA', 22: 'PI', 23: 'CE', 24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA',
  31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP', 41: 'PR', 42: 'SC', 43: 'RS',
  50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF',
};

// Filho direto pelo nome local (ignora namespace).
function child(el, name) {
  if (!el) return null;
  for (const c of el.children) if (c.localName === name) return c;
  return null;
}
function path(el, ...names) {
  let cur = el;
  for (const n of names) { cur = child(cur, n); if (!cur) return null; }
  return cur;
}
function txt(el, ...names) {
  const n = names.length ? path(el, ...names) : el;
  const v = n?.textContent?.trim();
  return v === undefined || v === '' ? null : v;
}
function num(v) { return v == null ? null : Number(v); }

export function parseNFe(xmlText, fileName = '') {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('O arquivo não é um XML válido.');
  }
  const inf = doc.getElementsByTagNameNS('*', 'infNFe')[0];
  if (!inf) {
    if (doc.getElementsByTagNameNS('*', 'infNFSe').length || doc.getElementsByTagNameNS('*', 'infDPS').length) {
      throw new Error('Este XML é de uma NFS-e. Para ela, use a aba “DANFSe”.');
    }
    throw new Error('Não encontrei o grupo infNFe. Envie o XML de uma NF-e (modelo 55) ou NFC-e (modelo 65).');
  }

  const ide = child(inf, 'ide');
  const emit = child(inf, 'emit');
  const cMunFG = txt(ide, 'cMunFG');
  const dhEmi = txt(ide, 'dhEmi') || txt(ide, 'dEmi');
  const nota = {
    fileName,
    chave: (inf.getAttribute('Id') || '').replace(/^NFe/, ''),
    modelo: txt(ide, 'mod'),
    numero: txt(ide, 'nNF'),
    serie: txt(ide, 'serie'),
    dhEmi,
    data: dhEmi ? dhEmi.slice(0, 10) : null,
    cMunFG,
    uf: cMunFG ? UF_POR_CODIGO[cMunFG.slice(0, 2)] : null,
    emitente: txt(emit, 'xNome'),
    cnpj: txt(emit, 'CNPJ') || txt(emit, 'CPF'),
    crt: txt(emit, 'CRT'),
    compraGov: !!path(ide, 'gCompraGov'),
    itens: [],
    totais: null,
  };

  for (const det of inf.children) {
    if (det.localName !== 'det') continue;
    const prod = child(det, 'prod');
    const imp = child(det, 'imposto');
    const ibscbs = child(imp, 'IBSCBS');
    const g = child(ibscbs, 'gIBSCBS');
    const is = child(imp, 'IS');
    nota.itens.push({
      numero: Number(det.getAttribute('nItem')),
      cProd: txt(prod, 'cProd'),
      xProd: txt(prod, 'xProd'),
      ncm: txt(prod, 'NCM'),
      quantidade: num(txt(prod, 'qCom')),
      unidade: txt(prod, 'uCom'),
      vProd: num(txt(prod, 'vProd')),
      temIBSCBS: !!ibscbs,
      monofasico: !!child(ibscbs, 'gIBSCBSMono'),
      cst: txt(ibscbs, 'CST'),
      cClassTrib: txt(ibscbs, 'cClassTrib'),
      nota: g ? {
        vBC: num(txt(g, 'vBC')),
        pIBSUF: num(txt(g, 'gIBSUF', 'pIBSUF')),
        vIBSUF: num(txt(g, 'gIBSUF', 'vIBSUF')),
        pIBSMun: num(txt(g, 'gIBSMun', 'pIBSMun')),
        vIBSMun: num(txt(g, 'gIBSMun', 'vIBSMun')),
        vIBS: num(txt(g, 'vIBS')),
        pCBS: num(txt(g, 'gCBS', 'pCBS')),
        vCBS: num(txt(g, 'gCBS', 'vCBS')),
      } : null,
      is: is ? {
        cst: txt(is, 'CSTIS'),
        cClassTrib: txt(is, 'cClassTribIS'),
        vBCIS: num(txt(is, 'vBCIS')),
        pIS: num(txt(is, 'pIS')),
        pISEspec: num(txt(is, 'pISEspec')),
        uTrib: txt(is, 'uTrib'),
        qTrib: num(txt(is, 'qTrib')),
        vIS: num(txt(is, 'vIS')),
      } : null,
    });
  }

  const tot = path(inf, 'total', 'IBSCBSTot');
  const isTot = path(inf, 'total', 'ISTot');
  if (tot || isTot) {
    nota.totais = {
      vBC: num(txt(tot, 'vBCIBSCBS')),
      vIBS: num(txt(tot, 'gIBS', 'vIBS')),
      vCBS: num(txt(tot, 'gCBS', 'vCBS')),
      vIS: num(txt(isTot, 'vIS')),
    };
  }
  return nota;
}

// Monta a operação para POST /observabilidade/regime-geral a partir da nota.
// Itens sem grupo IBSCBS (ou monofásicos) não são enviados.
export function operacaoDaNota(nota) {
  const ano = Number((nota.data || '').slice(0, 4));
  const exigeAliquotas = ano >= 2027;
  const itens = [];
  for (const it of nota.itens) {
    if (!it.temIBSCBS || !it.nota || it.monofasico) continue;
    const item = {
      numero: it.numero,
      cst: it.cst,
      cClassTrib: it.cClassTrib,
      baseCalculo: it.nota.vBC,
    };
    if (it.ncm && !/^0+$/.test(it.ncm)) item.ncm = it.ncm;
    if (it.quantidade != null) item.quantidade = round4(it.quantidade);
    if (it.unidade) item.unidade = it.unidade;
    if (it.is) {
      // Contrato oficial: base CBS/IBS = vBC informado − IS informado + IS calculado. Enviando o vIS da
      // nota como impostoInformado, a calculadora recalcula o IS e corrige a base se o vIS estiver errado
      // (e valida vBC = vBCIS + vIS).
      item.impostoSeletivo = {
        cst: it.is.cst, cClassTrib: it.is.cClassTrib, baseCalculo: it.is.vBCIS,
        ...(it.is.vIS != null ? { impostoInformado: it.is.vIS } : {}),
        ...(it.is.qTrib != null ? { quantidade: round4(it.is.qTrib) } : {}),
        ...(it.is.uTrib ? { unidade: it.is.uTrib } : {}),
      };
    }
    if (exigeAliquotas) {
      item.aliquotasNominais = {
        cbs: it.nota.pCBS ?? 0,
        ibsEstadual: it.nota.pIBSUF ?? 0,
        ibsMunicipal: it.nota.pIBSMun ?? 0,
      };
      if (it.is && (it.is.pIS != null || it.is.pISEspec != null)) {
        item.aliquotasNominais.impostoSeletivo = {
          ...(it.is.pIS != null ? { adValorem: it.is.pIS } : {}),
          ...(it.is.pISEspec != null ? { adRem: it.is.pISEspec } : {}),
        };
      }
    }
    itens.push(item);
  }
  return {
    id: (nota.chave || 'nfe').slice(-32) || 'nfe',
    versao: '1.0.0',
    dhFatoGerador: nota.dhEmi && nota.dhEmi.length > 10 ? nota.dhEmi : `${nota.data}T12:00:00-03:00`,
    municipio: Number(nota.cMunFG),
    uf: nota.uf,
    tpDoc: Number(nota.modelo) || undefined,
    itens,
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

// Nota de exemplo (dados fictícios) com 3 itens: um correto, um com CBS divergente e um com
// classificação incompatível com o NCM.
export const NFE_EXEMPLO = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
<NFe><infNFe Id="NFe35270312345678000195550010000012341000012345" versao="4.00">
<ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>1234</nNF><dhEmi>2027-03-10T10:00:00-03:00</dhEmi><cMunFG>3550308</cMunFG></ide>
<emit><CNPJ>12345678000195</CNPJ><xNome>EMPRESA EXEMPLO LTDA</xNome><enderEmit><cMun>3550308</cMun><UF>SP</UF></enderEmit><CRT>3</CRT></emit>
<det nItem="1"><prod><cProd>MOV-01</cProd><xProd>Mesa de madeira</xProd><NCM>94036000</NCM><uCom>UN</uCom><qCom>2.0000</qCom><vProd>3000.00</vProd></prod>
<imposto><IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><vBC>3000.00</vBC>
<gIBSUF><pIBSUF>0.0500</pIBSUF><vIBSUF>1.50</vIBSUF></gIBSUF><gIBSMun><pIBSMun>0.0500</pIBSMun><vIBSMun>1.50</vIBSMun></gIBSMun><vIBS>3.00</vIBS>
<gCBS><pCBS>8.8000</pCBS><vCBS>264.00</vCBS></gCBS></gIBSCBS></IBSCBS></imposto></det>
<det nItem="2"><prod><cProd>INF-01</cProd><xProd>Notebook</xProd><NCM>84713012</NCM><uCom>UN</uCom><qCom>1.0000</qCom><vProd>1200.00</vProd></prod>
<imposto><IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><vBC>1200.00</vBC>
<gIBSUF><pIBSUF>0.0500</pIBSUF><vIBSUF>0.60</vIBSUF></gIBSUF><gIBSMun><pIBSMun>0.0500</pIBSMun><vIBSMun>0.60</vIBSMun></gIBSMun><vIBS>1.20</vIBS>
<gCBS><pCBS>8.8000</pCBS><vCBS>105.60</vCBS></gCBS></gIBSCBS></IBSCBS></imposto></det>
<det nItem="3"><prod><cProd>BEB-01</cProd><xProd>Cerveja lata 350ml (cx 12)</xProd><NCM>22030000</NCM><uCom>LT</uCom><qCom>12.0000</qCom><vProd>150.00</vProd></prod>
<imposto><IS><CSTIS>000</CSTIS><cClassTribIS>000001</cClassTribIS><vBCIS>150.00</vBCIS><pIS>10.0000</pIS><uTrib>LT</uTrib><qTrib>12.0000</qTrib><vIS>15.00</vIS></IS>
<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><vBC>165.00</vBC>
<gIBSUF><pIBSUF>0.0500</pIBSUF><vIBSUF>0.08</vIBSUF></gIBSUF><gIBSMun><pIBSMun>0.0500</pIBSMun><vIBSMun>0.08</vIBSMun></gIBSMun><vIBS>0.16</vIBS>
<gCBS><pCBS>8.8000</pCBS><vCBS>13.20</vCBS></gCBS></gIBSCBS></IBSCBS></imposto></det>
<det nItem="4"><prod><cProd>CAR-01</cProd><xProd>Carne bovina desossada</xProd><NCM>02013000</NCM><uCom>KG</uCom><qCom>10.0000</qCom><vProd>80.00</vProd></prod>
<imposto><IBSCBS><CST>200</CST><cClassTrib>200035</cClassTrib><gIBSCBS><vBC>80.00</vBC>
<gIBSUF><pIBSUF>0.0500</pIBSUF><vIBSUF>0.00</vIBSUF></gIBSUF><gIBSMun><pIBSMun>0.0500</pIBSMun><vIBSMun>0.00</vIBSMun></gIBSMun><vIBS>0.00</vIBS>
<gCBS><pCBS>8.8000</pCBS><vCBS>0.00</vCBS></gCBS></gIBSCBS></IBSCBS></imposto></det>
<total><ISTot><vIS>15.00</vIS></ISTot><IBSCBSTot><vBCIBSCBS>4445.00</vBCIBSCBS><gIBS><vIBS>4.36</vIBS></gIBS><gCBS><vCBS>382.80</vCBS></gCBS></IBSCBSTot></total>
</infNFe></NFe></nfeProc>`;
