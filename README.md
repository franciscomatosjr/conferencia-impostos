# Confere RTC — conferência de CBS, IBS e Imposto Seletivo

Site para **conferir e comparar** os tributos da Reforma Tributária do Consumo (LC 214/2025)
usando as **calculadoras oficiais da Receita Federal**, publicadas no GitHub com licença MIT:

| Serviço | Repositório oficial | Uso no site |
|---|---|---|
| `regime-regular` (Java) | [calculadora-rtc-regime-regular](https://github.com/ReceitaFederal/calculadora-rtc-regime-regular) | CBS, IBS e IS; tabelas oficiais (cClassTrib, NCM, municípios) |
| `simples-nacional` (Java) | [calculadora-rtc-simples-nacional](https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional) | CBS e IBS no Simples Nacional |
| `danfse` (Go) | [calculadora-rtc-gerador-danfse](https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse) | PDF do DANFSe a partir do XML da NFS-e |

O código das calculadoras **não é copiado nem alterado**: as imagens Docker baixam cada repositório
em um commit fixo (`services/Dockerfile` e `services/Dockerfile.danfse`) e compilam como manda o README oficial.

## O que o site faz

1. **Conferir NF-e (XML)**: lê o XML da NF-e/NFC-e no navegador, extrai os grupos `IBSCBS` e `IS`
   de cada item, recalcula tudo na calculadora oficial e aponta, item a item, o que confere e o que diverge
   (base, CBS, IBS UF, IBS municipal e IS), além de erros de classificação (ex.: NCM não vinculada ao cClassTrib).
2. **Simular operação**: monta uma operação com vários itens (NCM/NBS, cClassTrib, base, IS) e, se quiser,
   confere valores já calculados pelo seu ERP.
3. **Regular × Simples**: calcula a mesma venda nas duas calculadoras e compara CBS + IBS, a carga sobre a venda
   e o crédito que o cliente pode aproveitar.
4. **Consultas**: cClassTrib, NCM e a tabela de classificações tributárias vigentes.
5. **DANFSe**: gera o PDF a partir do XML da NFS-e.

## Arquitetura

```
navegador ──► web (nginx: site estático + proxy /api/*) ──► regime-regular :8080
                                                        ├─► simples-nacional :8082
                                                        └─► danfse :8080
```

- O site é HTML/CSS/JS puro (sem build) em `web/public/`.
- O nginx (`web/nginx.conf`) expõe **só** as rotas usadas pelo site, com limite de requisições
  (5/s por IP), corpo máximo de 2 MB e cabeçalhos de segurança (CSP etc.). Swagger e demais rotas
  das APIs ficam apenas na rede interna do Docker.
- As calculadoras rodam no perfil `offline`, com o banco SQLite oficial gerado no build.

## Rodar localmente

Requisitos: Docker com Compose (≥ 2.24). O primeiro build leva alguns minutos (baixa Maven, Go e dependências).

```bash
docker compose up -d --build
# site em http://localhost:8000  (outra porta: PORT=8090 docker compose up -d)
```

As APIs Java levam ~30–60 s para subir. O indicador no topo do site fica verde quando a calculadora responde.

## Publicar na web

Um servidor (VPS) com **2 vCPU e 4 GB de RAM** é suficiente (as duas APIs Java usam ~0,5 GB cada em repouso;
os limites estão em `docker-compose.yml`).

1. Aponte o DNS do domínio (registro A/AAAA) para o IP do servidor.
2. No servidor, com Docker instalado:

   ```bash
   git clone <este-repositorio> conferencia-impostos && cd conferencia-impostos
   DOMAIN=seu-dominio.com.br docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```

   O Caddy (`deploy/Caddyfile`) obtém e renova o certificado HTTPS automaticamente. Libere as portas 80 e 443 no firewall.

### Atualizar as calculadoras

Quando a Receita publicar uma versão nova, troque os commits em `services/Dockerfile` (`RG_REF`, `SN_REF`)
e `services/Dockerfile.danfse` (`DANFSE_REF`) e rode o `up -d --build` de novo. A versão da calculadora e da base
de dados em uso aparece no topo do site.

## Regras de cálculo que vale saber

- **2026** é o ano de teste: a calculadora usa as alíquotas de referência da base (CBS 0,9% e IBS 0,1%) e
  **proíbe** informar alíquotas.
- **A partir de 2027** as alíquotas nominais são **obrigatórias** (não há alíquotas de referência publicadas). Na
  conferência de NF-e, o site usa as alíquotas destacadas na própria nota; nas simulações, as informadas no formulário.
  A calculadora marca esses resultados como `CALCULO_SIMULADO`.
- Com Imposto Seletivo, a base da CBS/IBS é `base informada − IS informado + IS calculado`; por isso a conferência
  envia o `vIS` da nota como `impostoInformado`.
- No Simples Nacional as alíquotas efetivas vêm do PGDAS-D do contribuinte; o site usa o cálculo “não assistido”
  (NF-e modelo 55 para mercadorias; NFS-e para serviços).

## Limitações conhecidas

- A conferência de XML cobre o regime regular; itens monofásicos (combustíveis), compra governamental (redutor)
  e documentos de emitentes do Simples não são conferidos automaticamente — o site avisa quando encontra esses casos.
- Diferenças de até R$ 0,01 são tratadas como arredondamento.

## Aviso

Ferramenta de conferência. Não é conselho jurídico ou contábil e não substitui o sistema emissor nem o contador.
A classificação de cada produto ou serviço é responsabilidade de quem emite a nota. Site independente, sem vínculo
com a Receita Federal. As calculadoras são da Receita Federal do Brasil e do Serpro, sob licença MIT.
