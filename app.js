/* App de orçamentos — Master Pinturas
   Dados ficam no aparelho (localStorage) e, se configurado, são enviados para a planilha Google (Apps Script). */
(function () {
  "use strict";

  // ---------------------------------------------------------------- constantes
  const VERSAO = "1.1";
  const SCRIPT_URL_PADRAO = "";   // opcional: cole aqui a URL do app da web para já vir configurado
  const CHAVE_PADRAO = "";        // opcional: a mesma chave do Code.gs
  const TIPOS = ["Pintura residencial", "Pintura comercial", "Pintura de fachada", "Muros e áreas externas",
    "Efeito decorativo", "Efeito marmorizado", "Textura / acabamento especial", "Preparação e recuperação de superfície",
    "Acabamento em geral", "Outro"];
  const UNIDADES = ["m²", "m", "un.", "verba", "diária"];
  const FORMAS = ["PIX", "Dinheiro", "Cartão de crédito", "Cartão de débito", "Transferência", "Boleto"];
  const STATUS = { rascunho: "Rascunho", enviado: "Enviado", aprovado: "Aprovado", recusado: "Recusado", concluido: "Concluído" };
  const MAT = { inclusos: "Inclusos", nao_inclusos: "Não inclusos", parcial: "Parcialmente inclusos" };
  const K = { orc: "mp_orcamentos", cfg: "mp_config", atual: "mp_atual" };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------------------------------------------------------------- armazenamento seguro
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast("Não foi possível salvar no aparelho."); return false; } },
  };

  const CFG_PADRAO = {
    empresa: "Master Pinturas", responsavel: "", documento: "", telefone: "(18) 98821-9640",
    instagram: "@masterpinturas.valparaiso", regiao: "Valparaíso-SP e região",
    validade: 15, proximo: 1, prazo: "", parcelamento: "", obs: "",
    url: SCRIPT_URL_PADRAO, chave: CHAVE_PADRAO, formas: ["PIX", "Dinheiro"],
  };
  let cfg = Object.assign({}, CFG_PADRAO, store.get(K.cfg, {}));
  let orcs = store.get(K.orc, []);
  let atual = null;       // orçamento em edição
  let filtro = "todos";

  // ---------------------------------------------------------------- utilidades
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const hoje = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const pad = (n) => String(n).padStart(4, "0");
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    let s = String(v || "").replace(/[^\d,.\-]/g, "");
    if (!s) return 0;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
    const n = parseFloat(s); return isFinite(n) ? n : 0;
  }
  const brl = (v) => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const numBR = (v) => (v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  const dataBR = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
  function addDias(iso, n) { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + (parseInt(n) || 0)); return d.toISOString().slice(0, 10); }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const slug = (s) => String(s || "CLIENTE").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase().slice(0, 40) || "CLIENTE";
  const soDig = (s) => String(s || "").replace(/\D/g, "");
  let tId;
  function toast(m, ms = 2600) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(tId); tId = setTimeout(() => t.classList.remove("on"), ms); }

  // ---------------------------------------------------------------- cálculo
  function totais(o) {
    const mao = o.itens.reduce((s, i) => s + num(i.qtd) * num(i.valorUnit), 0);
    const mat = (o.materiais.itens || []).reduce((s, m) => s + num(m.valor), 0);
    const bruto = mao + mat;
    let desc = num(o.desconto.valor);
    if (o.desconto.tipo === "pct") desc = bruto * Math.min(desc, 100) / 100;
    desc = Math.min(desc, bruto);
    return { mao, mat, desc, total: Math.max(bruto - desc, 0) };
  }

  // ---------------------------------------------------------------- modelo
  function novoOrc() {
    return {
      id: uid(), numero: null, data: hoje(), validadeDias: cfg.validade,
      cliente: { nome: "", telefone: "", endereco: "", cidade: "" },
      itens: [novoItem()],
      materiais: { situacao: "nao_inclusos", itens: [] },
      desconto: { tipo: "valor", valor: "" },
      pagamento: { formas: (cfg.formas || []).slice(), parcelamento: cfg.parcelamento || "" },
      prazo: cfg.prazo || "", observacoes: cfg.obs || "",
      status: "rascunho", statusData: hoje(), criadoEm: new Date().toISOString(), atualizadoEm: null,
      sync: false, pdfUrl: "",
    };
  }
  function novoItem() { return { tipo: TIPOS[0], descricao: "", ambiente: "", qtd: "", unidade: "m²", valorUnit: "" }; }

  // ---------------------------------------------------------------- formulário
  function renderItens() {
    const box = $("#itens"); box.innerHTML = "";
    atual.itens.forEach((it, i) => {
      const d = document.createElement("div"); d.className = "item"; d.dataset.i = i;
      d.innerHTML = `
        <div class="top"><span class="n">SERVIÇO ${i + 1}</span><span class="tot" data-tot>${brl(num(it.qtd) * num(it.valorUnit))}</span>
          <button class="icon" data-act="dup" title="Duplicar" aria-label="Duplicar serviço">⧉</button>
          <button class="icon" data-act="del" title="Remover" aria-label="Remover serviço">✕</button></div>
        <label>Tipo de serviço</label><select data-f="tipo">${TIPOS.map((t) => `<option ${t === it.tipo ? "selected" : ""}>${t}</option>`).join("")}</select>
        <label>Descrição detalhada</label><textarea data-f="descricao" rows="2" placeholder="Ex.: lixamento, correção de trincas, 2 demãos de tinta acrílica">${esc(it.descricao)}</textarea>
        <label>Ambiente / local</label><input data-f="ambiente" value="${esc(it.ambiente)}" placeholder="Ex.: sala, fachada, muro lateral">
        <div class="row">
          <div><label>Metragem / qtd.</label><input data-f="qtd" inputmode="decimal" value="${esc(it.qtd)}" placeholder="0"></div>
          <div class="s"><label>Unidade</label><select data-f="unidade">${UNIDADES.map((u) => `<option ${u === it.unidade ? "selected" : ""}>${u}</option>`).join("")}</select></div>
          <div><label>Valor unit. (R$)</label><input data-f="valorUnit" inputmode="decimal" value="${esc(it.valorUnit)}" placeholder="0,00"></div>
        </div>`;
      box.appendChild(d);
    });
  }
  function renderMat() {
    $$("#segMat button").forEach((b) => b.classList.toggle("on", b.dataset.v === atual.materiais.situacao));
    const box = $("#matLista"); box.innerHTML = "";
    atual.materiais.itens.forEach((m, i) => {
      const d = document.createElement("div"); d.className = "mat-line"; d.dataset.i = i;
      d.innerHTML = `<div><label>Material</label><input data-m="descricao" value="${esc(m.descricao)}" placeholder="Ex.: tinta acrílica fosca"></div>
        <div class="s"><label>Qtd.</label><input data-m="qtd" value="${esc(m.qtd)}" placeholder="2 latas"></div>
        <div class="s"><label>Valor (R$)</label><input data-m="valor" inputmode="decimal" value="${esc(m.valor)}" placeholder="opcional"></div>
        <button class="icon" data-act="delm" aria-label="Remover material">✕</button>`;
      box.appendChild(d);
    });
  }
  function renderChips() {
    $("#chipsPag").innerHTML = FORMAS.map((f) => `<span class="chip ${atual.pagamento.formas.includes(f) ? "on" : ""}" data-f="${f}">${f}</span>`).join("");
  }
  function preencherForm() {
    $("#fNumero").textContent = atual.numero ? "Nº " + pad(atual.numero) : "Nº " + pad(cfg.proximo) + " (novo)";
    $("#fData").value = atual.data; $("#fValidade").value = atual.validadeDias;
    $("#fNome").value = atual.cliente.nome; $("#fTel").value = atual.cliente.telefone;
    $("#fEnd").value = atual.cliente.endereco; $("#fCidade").value = atual.cliente.cidade;
    $$("#segDesc button").forEach((b) => b.classList.toggle("on", b.dataset.v === atual.desconto.tipo));
    $("#fDesc").value = atual.desconto.valor; $("#fParc").value = atual.pagamento.parcelamento;
    $("#fPrazo").value = atual.prazo; $("#fObs").value = atual.observacoes;
    renderItens(); renderMat(); renderChips(); atualizarTotais(); listasAuto();
  }
  function lerForm() {
    atual.data = $("#fData").value || hoje(); atual.validadeDias = parseInt($("#fValidade").value) || 0;
    atual.cliente = { nome: $("#fNome").value.trim(), telefone: $("#fTel").value.trim(), endereco: $("#fEnd").value.trim(), cidade: $("#fCidade").value.trim() };
    atual.desconto.valor = $("#fDesc").value; atual.pagamento.parcelamento = $("#fParc").value.trim();
    atual.prazo = $("#fPrazo").value.trim(); atual.observacoes = $("#fObs").value.trim();
  }
  function atualizarTotais() {
    const t = totais(atual);
    $("#rMao").textContent = brl(t.mao); $("#rMat").textContent = brl(t.mat);
    $("#rDesc").textContent = "– " + brl(t.desc); $("#rTot").textContent = brl(t.total); $("#barTot").textContent = brl(t.total);
    $$("#itens .item").forEach((el) => { const it = atual.itens[el.dataset.i]; if (it) $("[data-tot]", el).textContent = brl(num(it.qtd) * num(it.valorUnit)); });
  }
  let saveT;
  function autosave() { clearTimeout(saveT); saveT = setTimeout(() => { lerForm(); store.set(K.atual, atual); }, 400); }
  function listasAuto() {
    const nomes = [...new Set(orcs.map((o) => o.cliente.nome).filter(Boolean))];
    $("#dlClientes").innerHTML = nomes.map((n) => `<option value="${esc(n)}">`).join("");
    const cid = [...new Set(["Valparaíso-SP", ...orcs.map((o) => o.cliente.cidade).filter(Boolean)])];
    $("#dlCidades").innerHTML = cid.map((n) => `<option value="${esc(n)}">`).join("");
  }

  // eventos do formulário
  function ligarForm() {
    $("#tab-form").addEventListener("input", (e) => {
      const t = e.target;
      const it = t.closest(".item"); const ml = t.closest(".mat-line");
      if (it && t.dataset.f) { atual.itens[it.dataset.i][t.dataset.f] = t.value; }
      if (ml && t.dataset.m) { atual.materiais.itens[ml.dataset.i][t.dataset.m] = t.value; }
      if (t.id === "fDesc") atual.desconto.valor = t.value;
      atualizarTotais(); autosave();
    });
    $("#tab-form").addEventListener("change", (e) => {
      if (e.target.id === "fNome") {
        const n = e.target.value.trim(); const ant = [...orcs].reverse().find((o) => o.cliente.nome === n);
        if (ant) {
          if (!$("#fTel").value) $("#fTel").value = ant.cliente.telefone;
          if (!$("#fEnd").value) $("#fEnd").value = ant.cliente.endereco;
          if (!$("#fCidade").value) $("#fCidade").value = ant.cliente.cidade;
          toast("Dados do cliente preenchidos do histórico.");
        }
      }
      autosave();
    });
    $("#tab-form").addEventListener("click", (e) => {
      const b = e.target.closest("button,.chip"); if (!b) return;
      if (b.dataset.act === "del") { const i = +b.closest(".item").dataset.i; atual.itens.splice(i, 1); if (!atual.itens.length) atual.itens.push(novoItem()); renderItens(); atualizarTotais(); autosave(); }
      if (b.dataset.act === "dup") { const i = +b.closest(".item").dataset.i; atual.itens.splice(i + 1, 0, Object.assign({}, atual.itens[i])); renderItens(); atualizarTotais(); autosave(); }
      if (b.dataset.act === "delm") { atual.materiais.itens.splice(+b.closest(".mat-line").dataset.i, 1); renderMat(); atualizarTotais(); autosave(); }
      if (b.closest("#segMat")) { atual.materiais.situacao = b.dataset.v; renderMat(); autosave(); }
      if (b.closest("#segDesc")) { atual.desconto.tipo = b.dataset.v; $$("#segDesc button").forEach((x) => x.classList.toggle("on", x === b)); atualizarTotais(); autosave(); }
      if (b.classList.contains("chip")) { const f = b.dataset.f; const a = atual.pagamento.formas; const k = a.indexOf(f); k >= 0 ? a.splice(k, 1) : a.push(f); b.classList.toggle("on"); autosave(); }
    });
    $("#btnAddItem").onclick = () => { lerForm(); atual.itens.push(novoItem()); renderItens(); atualizarTotais(); autosave(); const l = $$("#itens .item").pop(); l && l.scrollIntoView({ behavior: "smooth", block: "center" }); };
    $("#btnAddMat").onclick = () => { atual.materiais.itens.push({ descricao: "", qtd: "", valor: "" }); renderMat(); autosave(); };
    $("#btnNovo").onclick = async () => { if (await perguntar("Começar um novo orçamento?", "O orçamento atual continua salvo no histórico, se você já tiver salvo.", "Novo orçamento")) { atual = novoOrc(); store.set(K.atual, atual); preencherForm(); window.scrollTo(0, 0); } };
    $("#btnSalvar").onclick = () => { if (salvarAtual()) toast("Orçamento Nº " + pad(atual.numero) + " salvo."); };
    $("#btnPreview").onclick = () => { if (!salvarAtual()) return; const doc = gerarPDF(atual); abrirPDF(doc); };
    $("#btnGerar").onclick = () => gerarEEnviar();
  }

  function validar() {
    lerForm();
    if (!atual.cliente.nome) { toast("Preencha o nome do cliente."); $("#fNome").focus(); return false; }
    const valido = atual.itens.some((i) => num(i.qtd) > 0 && num(i.valorUnit) > 0);
    if (!valido) { toast("Preencha quantidade e valor em pelo menos um serviço."); return false; }
    return true;
  }
  function salvarAtual() {
    if (!validar()) return false;
    atual.itens = atual.itens.filter((i) => num(i.qtd) || num(i.valorUnit) || i.descricao.trim());
    atual.materiais.itens = atual.materiais.itens.filter((m) => m.descricao.trim() || num(m.valor));
    if (!atual.numero) { atual.numero = cfg.proximo; cfg.proximo += 1; store.set(K.cfg, cfg); }
    atual.atualizadoEm = new Date().toISOString(); atual.sync = false;
    const i = orcs.findIndex((o) => o.id === atual.id);
    if (i >= 0) orcs[i] = clone(atual); else orcs.push(clone(atual));
    store.set(K.orc, orcs); store.set(K.atual, atual);
    $("#fNumero").textContent = "Nº " + pad(atual.numero);
    renderItens(); renderMat(); atualizarTotais(); listasAuto(); syncInfo();
    return true;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const nomeArquivo = (o) => `ORCAMENTO_${pad(o.numero)}_${slug(o.cliente.nome)}.pdf`;

  // ---------------------------------------------------------------- PDF
  let fontesOk = false;
  function prepararFontes(doc) {
    const A = window.MP_ASSETS;
    [["Display", A.fontDisplay, "normal"], ["Label", A.fontLabel, "normal"], ["Body", A.fontBody, "normal"], ["Body", A.fontBodyBold, "bold"]].forEach(([n, b64, st]) => {
      const f = `${n}-${st}.ttf`; doc.addFileToVFS(f, b64); doc.addFont(f, n, st);
    });
    fontesOk = true;
  }
  const COR = { g: [20, 20, 20], cal: [244, 241, 236], lat: [168, 134, 47], ouro: [201, 164, 76], ped: [226, 221, 211], conc: [156, 152, 144], c2: [38, 38, 38], tx2: [95, 92, 86], faixa: [250, 248, 245] };

  function gerarPDF(o) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
    prepararFontes(doc);
    const A = window.MP_ASSETS; const W = 210, H = 297, M = 16, CW = W - 2 * M;
    const t = totais(o);
    const fill = (c) => doc.setFillColor(...c), tcol = (c) => doc.setTextColor(...c), dcol = (c) => doc.setDrawColor(...c);
    const label = (s, x, y, c = COR.lat, al = "left") => { doc.setFont("Label", "normal"); doc.setFontSize(7); tcol(c); doc.text(s.toUpperCase(), x, y, { charSpace: 0.9, align: al }); };
    let y;

    // cabeçalho
    fill(COR.g); doc.rect(0, 0, W, 40, "F");
    doc.addImage(A.logo, "PNG", M, 20 - 58 * A.logoRatio / 2, 58, 58 * A.logoRatio);
    label("Orçamento", W - M, 14, COR.ouro, "right");
    doc.setFont("Display", "normal"); doc.setFontSize(19); tcol(COR.cal); doc.text("Nº " + pad(o.numero), W - M, 24, { align: "right" });
    doc.setFont("Body", "normal"); doc.setFontSize(8); tcol(COR.ped);
    doc.text(`Emitido em ${dataBR(o.data)}  ·  Válido até ${dataBR(addDias(o.data, o.validadeDias))}`, W - M, 31, { align: "right" });
    y = 52;

    // cliente
    label("Dados do cliente", M, y); y += 6;
    const campo = (lab, val, x, w) => {
      doc.setFont("Label", "normal"); doc.setFontSize(6.2); tcol(COR.conc); doc.text(lab.toUpperCase(), x, y, { charSpace: 0.6 });
      doc.setFont("Body", "normal"); doc.setFontSize(10); tcol(COR.g);
      const lines = doc.splitTextToSize(val || "—", w); doc.text(lines[0], x, y + 5.5);
      dcol(COR.ped); doc.setLineWidth(0.25); doc.line(x, y + 8, x + w, y + 8);
    };
    const half = (CW - 8) / 2;
    campo("Cliente", o.cliente.nome, M, half); campo("Telefone", o.cliente.telefone, M + half + 8, half); y += 13;
    campo("Endereço da obra", o.cliente.endereco, M, half * 1.35); campo("Cidade", o.cliente.cidade, M + half * 1.35 + 8, CW - half * 1.35 - 8); y += 17;

    // serviços
    label("Serviços", M, y); y += 3;
    const corpo = o.itens.map((it, i) => [String(i + 1), { content: it.tipo + (it.descricao ? "\n" + it.descricao : ""), tipo: it.tipo }, it.ambiente || "—",
      numBR(num(it.qtd)), it.unidade, brl(num(it.valorUnit)), brl(num(it.qtd) * num(it.valorUnit))]);
    doc.autoTable({
      startY: y, margin: { left: M, right: M, top: 22, bottom: 24 },
      head: [["Nº", "Serviço / descrição", "Ambiente", "Qtd.", "Un.", "Valor unit.", "Total"]], body: corpo, theme: "plain",
      styles: { font: "Body", fontSize: 8.4, textColor: COR.g, cellPadding: { top: 2.3, bottom: 2.3, left: 2.2, right: 2.2 }, lineColor: COR.ped, valign: "middle" },
      headStyles: { font: "Label", fontSize: 6.6, fillColor: COR.g, textColor: COR.cal, cellPadding: { top: 3, bottom: 3, left: 2.2, right: 2.2 } },
      alternateRowStyles: { fillColor: COR.faixa },
      columnStyles: { 0: { cellWidth: 8, textColor: COR.lat }, 1: { cellWidth: 66 }, 2: { cellWidth: 28 }, 3: { cellWidth: 14, halign: "right" }, 4: { cellWidth: 12 }, 5: { cellWidth: 25, halign: "right" }, 6: { cellWidth: 25, halign: "right", fontStyle: "bold" } },
      didParseCell: (d) => { if (d.section === "head" && d.column.index >= 5) d.cell.styles.halign = "right"; if (d.section === "head" && d.column.index === 3) d.cell.styles.halign = "right"; },
      willDrawCell: (d) => {
        if (d.section === "body" && d.column.index === 1 && d.cell.raw && d.cell.raw.tipo) { d.cell.__lines = d.cell.text; d.cell.text = []; }
      },
      didDrawCell: (d) => {
        if (d.section !== "body") return;
        dcol(COR.ped); doc.setLineWidth(0.2); doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
        const L = d.cell.__lines; if (!L) return;
        const fs = 8.4, lh = fs * 0.3528 * 1.15, w = d.cell.width - d.cell.padding("left") - d.cell.padding("right");
        doc.setFont("Body", "bold"); doc.setFontSize(fs); const k = doc.splitTextToSize(d.cell.raw.tipo, w).length;
        let yy = d.cell.y + (d.cell.height - L.length * lh) / 2 + fs * 0.3528 * 0.85;
        L.forEach((ln, i) => { doc.setFont("Body", i < k ? "bold" : "normal"); tcol(i < k ? COR.g : COR.tx2); doc.text(ln, d.cell.x + d.cell.padding("left"), yy); yy += lh; });
      },
    });
    y = doc.lastAutoTable.finalY;

    // materiais
    y += 8; y = garantir(doc, y, 30);
    label("Materiais", M, y); y += 6;
    const opts = Object.entries(MAT); let x = M;
    opts.forEach(([k, v]) => {
      dcol(COR.g); doc.setLineWidth(0.35); doc.rect(x, y - 3.3, 3.8, 3.8);
      if (o.materiais.situacao === k) { fill(COR.ouro); doc.rect(x + 0.8, y - 2.5, 2.2, 2.2, "F"); }
      doc.setFont("Body", o.materiais.situacao === k ? "bold" : "normal"); doc.setFontSize(9); tcol(COR.g); doc.text(v, x + 6, y);
      x += 52;
    });
    y += 4;
    if (o.materiais.itens.length) {
      doc.autoTable({
        startY: y + 1, margin: { left: M, right: M, top: 22, bottom: 24 }, theme: "plain",
        head: [["Material", "Quantidade", "Valor"]],
        body: o.materiais.itens.map((m) => [m.descricao || "—", m.qtd || "—", num(m.valor) ? brl(num(m.valor)) : "—"]),
        styles: { font: "Body", fontSize: 8.4, textColor: COR.g, cellPadding: 1.8, lineColor: COR.ped },
        headStyles: { font: "Label", fontSize: 6.6, fillColor: COR.cal, textColor: COR.tx2 },
        columnStyles: { 0: { cellWidth: 110 }, 1: { cellWidth: 38 }, 2: { cellWidth: CW - 148, halign: "right" } },
        didParseCell: (d) => { if (d.section === "head" && d.column.index === 2) d.cell.styles.halign = "right"; },
        didDrawCell: (d) => { if (d.section === "body") { dcol(COR.ped); doc.setLineWidth(0.2); doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height); } },
      });
      y = doc.lastAutoTable.finalY + 2;
    } else if (o.materiais.situacao === "nao_inclusos") {
      doc.setFont("Body", "normal"); doc.setFontSize(8.4); tcol(COR.tx2); doc.text("Materiais por conta do cliente.", M, y + 4); y += 6;
    }

    // condições + totais
    y += 6; y = garantir(doc, y, 58);
    label("Condições comerciais", M, y);
    const yC = y + 6; const colW = 92;
    const cond = [["Forma de pagamento", (o.pagamento.formas || []).join(", ") || "A combinar"], ["Condições de parcelamento", o.pagamento.parcelamento || "—"],
      ["Prazo estimado de execução", o.prazo || "A combinar"], ["Validade da proposta", `${o.validadeDias} dias (até ${dataBR(addDias(o.data, o.validadeDias))})`]];
    let yy = yC;
    cond.forEach(([l, v]) => {
      doc.setFont("Label", "normal"); doc.setFontSize(6.2); tcol(COR.conc); doc.text(l.toUpperCase(), M, yy, { charSpace: 0.6 });
      doc.setFont("Body", "normal"); doc.setFontSize(9.4); tcol(COR.g);
      const ls = doc.splitTextToSize(v, colW); doc.text(ls.slice(0, 2), M, yy + 5);
      yy += 6.5 + Math.min(ls.length, 2) * 4.2;
      dcol(COR.ped); doc.setLineWidth(0.2); doc.line(M, yy - 2.6, M + colW, yy - 2.6);
    });
    // totais
    const tx = M + colW + 10, tw = CW - colW - 10; let ty = yC - 1;
    [["Mão de obra", brl(t.mao)], ["Materiais", brl(t.mat)], ["Desconto", (t.desc ? "– " : "") + brl(t.desc)]].forEach(([l, v]) => {
      doc.setFont("Body", "normal"); doc.setFontSize(9.4); tcol(COR.tx2); doc.text(l, tx + 3, ty + 4);
      tcol(COR.g); doc.text(v, tx + tw - 3, ty + 4, { align: "right" });
      dcol(COR.ped); doc.setLineWidth(0.2); doc.line(tx, ty + 7, tx + tw, ty + 7); ty += 8.5;
    });
    ty += 2; fill(COR.g); doc.rect(tx, ty, tw, 15, "F");
    label("Valor total", tx + 4, ty + 9.2, COR.ouro);
    doc.setFont("Display", "normal"); doc.setFontSize(15); tcol(COR.cal); doc.text(brl(t.total), tx + tw - 4, ty + 10, { align: "right" });
    y = Math.max(yy, ty + 15) + 6;

    // observações
    if (o.observacoes) {
      const ls = doc.splitTextToSize(o.observacoes, CW);
      y = garantir(doc, y, 10 + ls.length * 4.4);
      label("Observações", M, y); doc.setFont("Body", "normal"); doc.setFontSize(9); tcol(COR.g);
      doc.text(ls, M, y + 5.5, { lineHeightFactor: 1.4 }); y += 8 + ls.length * 4.4;
    }

    // aprovação
    y += 1; y = garantir(doc, y, 27);
    fill([247, 245, 241]); doc.rect(M, y, CW, 26, "F");
    label("Aprovação do cliente", M + 5, y + 7);
    doc.setFont("Body", "normal"); doc.setFontSize(8.4); tcol(COR.tx2);
    doc.text("Declaro estar de acordo com os serviços, valores e condições descritos neste orçamento.", M + 5, y + 12);
    dcol(COR.g); doc.setLineWidth(0.3); doc.line(M + 5, y + 20, M + 108, y + 20); doc.line(M + 120, y + 20, W - M - 5, y + 20);
    doc.setFontSize(7); tcol(COR.conc); doc.text("Assinatura do cliente", M + 5, y + 23.5); doc.text("Data", M + 120, y + 23.5);

    // rodapé e cabeçalho de continuação em todas as páginas
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      doc.setPage(p);
      if (p > 1) {
        fill(COR.g); doc.rect(0, 0, W, 14, "F");
        doc.addImage(A.logo, "PNG", M, 7 - 26 * A.logoRatio / 2, 26, 26 * A.logoRatio);
        doc.setFont("Body", "normal"); doc.setFontSize(8); tcol(COR.ped); doc.text(`Orçamento Nº ${pad(o.numero)} · ${o.cliente.nome}`, W - M, 8.6, { align: "right" });
      }
      dcol(COR.ouro); doc.setLineWidth(0.35); doc.line(M, H - 16, W - M, H - 16);
      doc.setFont("Body", "normal"); doc.setFontSize(7.4); tcol(COR.tx2);
      const linha = [cfg.empresa, cfg.responsavel, cfg.documento, cfg.telefone && "WhatsApp " + cfg.telefone, cfg.instagram, cfg.regiao].filter(Boolean).join("  ·  ");
      doc.text(doc.splitTextToSize(linha, CW - 22)[0], M, H - 10.5);
      doc.addImage(A.simbolo, "PNG", W - M - 3.2, H - 14.4, 3.2, 3.2 * A.simboloRatio);
      if (n > 1) { doc.setFontSize(7); tcol(COR.conc); doc.text(`${p}/${n}`, W - M - 8, H - 10.5, { align: "right" }); }
    }
    return doc;
  }
  function garantir(doc, y, h) { if (y + h > 297 - 19) { doc.addPage(); return 24; } return y; }

  function abrirPDF(doc) {
    const url = URL.createObjectURL(doc.output("blob"));
    const w = window.open(url, "_blank"); if (!w) { const a = document.createElement("a"); a.href = url; a.download = nomeArquivo(atual); a.click(); }
  }

  async function gerarEEnviar() {
    if (!salvarAtual()) return;
    const doc = gerarPDF(atual); const nome = nomeArquivo(atual);
    const blob = doc.output("blob"); const file = new File([blob], nome, { type: "application/pdf" });
    if (atual.status === "rascunho") { atual.status = "enviado"; atual.statusData = hoje(); }
    gravar(atual);
    sincronizar(atual, blob);
    const texto = `Olá, ${atual.cliente.nome.split(" ")[0]}! Segue o orçamento Nº ${pad(atual.numero)} da ${cfg.empresa}. Qualquer dúvida, estou à disposição.`;
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: nome, text: texto }); toast("Orçamento enviado."); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nome; document.body.appendChild(a); a.click(); a.remove();
    toast("PDF baixado. Anexe no WhatsApp do cliente.", 4000);
  }
  function gravar(o) {
    o.atualizadoEm = new Date().toISOString(); o.sync = false;
    const i = orcs.findIndex((x) => x.id === o.id); if (i >= 0) orcs[i] = clone(o); else orcs.push(clone(o));
    store.set(K.orc, orcs); if (atual && atual.id === o.id) { atual = clone(o); store.set(K.atual, atual); }
    syncInfo();
  }

  // ---------------------------------------------------------------- planilha (Apps Script)
  const temPlanilha = () => !!(cfg.url && /^https:\/\/script\.google(usercontent)?\.com\//.test(cfg.url));
  function blobB64(blob) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); }); }
  async function post(corpo) {
    const r = await fetch(cfg.url, { method: "POST", body: JSON.stringify(Object.assign({ chave: cfg.chave }, corpo)), redirect: "follow" });
    const j = await r.json(); if (!j.ok) throw new Error(j.erro || "Erro na planilha"); return j;
  }
  function payload(o) { const t = totais(o); return Object.assign(clone(o), { totais: t, statusTexto: STATUS[o.status], materiaisTexto: MAT[o.materiais.situacao], validoAte: addDias(o.data, o.validadeDias), versaoApp: VERSAO }); }
  let sincronizando = false;
  async function sincronizar(o, pdfBlob) {
    if (!temPlanilha() || !navigator.onLine) { syncInfo(); return false; }
    try {
      const corpo = { acao: "salvar", orcamento: payload(o) };
      if (pdfBlob) { corpo.pdfBase64 = await blobB64(pdfBlob); corpo.pdfNome = nomeArquivo(o); }
      const j = await post(corpo);
      const i = orcs.findIndex((x) => x.id === o.id);
      if (i >= 0) { orcs[i].sync = true; if (j.pdfUrl) orcs[i].pdfUrl = j.pdfUrl; store.set(K.orc, orcs); }
      if (atual && atual.id === o.id) { atual.sync = true; if (j.pdfUrl) atual.pdfUrl = j.pdfUrl; store.set(K.atual, atual); }
      if (j.maiorNumero && j.maiorNumero >= cfg.proximo) { cfg.proximo = j.maiorNumero + 1; store.set(K.cfg, cfg); }
      syncInfo(); return true;
    } catch (e) { syncInfo(); return false; }
  }
  async function sincronizarPendentes() {
    if (sincronizando || !temPlanilha() || !navigator.onLine) return;
    sincronizando = true; let ok = 0;
    for (const o of orcs.filter((x) => !x.sync)) { if (await sincronizar(o)) ok++; }
    sincronizando = false; if (ok) toast(`${ok} orçamento(s) enviados para a planilha.`); renderLista();
  }
  function syncInfo() {
    const pend = orcs.filter((o) => !o.sync).length;
    const dot = $("#syncDot"), txt = $("#syncTxt");
    if (!temPlanilha()) { dot.className = "dot"; txt.textContent = "Sem planilha"; }
    else if (!navigator.onLine) { dot.className = "dot wait"; txt.textContent = "Sem internet"; }
    else if (pend) { dot.className = "dot wait"; txt.textContent = pend + " pendente" + (pend > 1 ? "s" : ""); }
    else { dot.className = "dot on"; txt.textContent = "Planilha em dia"; }
    const b = $("#bannerSync");
    if (temPlanilha() && pend) { b.classList.remove("hide"); $("#bannerTxt").textContent = `${pend} orçamento(s) ainda não foram para a planilha.`; } else b.classList.add("hide");
  }

  // ---------------------------------------------------------------- histórico
  const FILTROS = [["todos", "Todos"], ["enviado", "Enviados"], ["aprovado", "Aprovados"], ["concluido", "Concluídos"], ["recusado", "Recusados"], ["rascunho", "Rascunhos"]];
  function renderLista() {
    $("#filtros").innerHTML = FILTROS.map(([k, v]) => `<span class="chip ${filtro === k ? "on" : ""}" data-k="${k}">${v}</span>`).join("");
    const q = $("#busca").value.trim().toLowerCase();
    const lista = orcs.slice().sort((a, b) => (b.numero || 0) - (a.numero || 0))
      .filter((o) => filtro === "todos" || o.status === filtro)
      .filter((o) => !q || [o.cliente.nome, o.cliente.cidade, pad(o.numero), String(o.numero)].join(" ").toLowerCase().includes(q));
    // indicadores do mês
    const mes = hoje().slice(0, 7); const doMes = orcs.filter((o) => (o.data || "").slice(0, 7) === mes && o.status !== "rascunho");
    const fech = doMes.filter((o) => o.status === "aprovado" || o.status === "concluido");
    const soma = (a) => a.reduce((s, o) => s + totais(o).total, 0);
    $("#kpis").innerHTML = `<div><small>Orçado no mês</small><b>${brl(soma(doMes))}</b><div style="font-size:12px;color:var(--conc)">${doMes.length} orçamento(s)</div></div>
      <div><small>Fechado no mês</small><b>${brl(soma(fech))}</b><div style="font-size:12px;color:var(--conc)">${fech.length} venda(s)</div></div>`;
    $("#lista").innerHTML = lista.length ? lista.map((o) => `
      <div class="q" data-id="${o.id}">
        <div class="l"><div class="nm">${esc(o.cliente.nome || "Sem nome")}</div>
          <div class="meta">Nº ${pad(o.numero)} · ${dataBR(o.data)}${o.cliente.cidade ? " · " + esc(o.cliente.cidade) : ""}</div>
          <span class="st ${o.status}">${STATUS[o.status]}</span>${o.sync || !temPlanilha() ? "" : ' <span class="meta">· aguardando envio</span>'}</div>
        <div class="v">${brl(totais(o).total)}</div>
      </div>`).join("") : `<div class="empty">Nenhum orçamento ${filtro === "todos" && !q ? "ainda. Crie o primeiro na aba Orçamento." : "encontrado."}</div>`;
    syncInfo();
  }
  function ligarLista() {
    $("#filtros").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; filtro = c.dataset.k; renderLista(); });
    $("#busca").addEventListener("input", renderLista);
    $("#lista").addEventListener("click", (e) => { const q = e.target.closest(".q"); if (q) abrirAcoes(q.dataset.id); });
    $("#btnSyncAgora").onclick = sincronizarPendentes;
  }
  function abrirAcoes(id) {
    const o = orcs.find((x) => x.id === id); if (!o) return;
    const tel = soDig(o.cliente.telefone); const wa = tel ? `https://wa.me/${tel.length <= 11 ? "55" + tel : tel}` : "";
    abrirSheet(`
      <h3>${esc(o.cliente.nome)}</h3><div class="meta">Nº ${pad(o.numero)} · ${dataBR(o.data)} · <b>${brl(totais(o).total)}</b></div>
      <label>Status</label>
      <div class="chips" id="stChips">${Object.entries(STATUS).map(([k, v]) => `<span class="chip ${o.status === k ? "on" : ""}" data-s="${k}">${v}</span>`).join("")}</div>
      <div class="grid">
        <button class="btn pri" data-a="editar">Editar</button>
        <button class="btn acc" data-a="pdf">PDF / enviar</button>
        <button class="btn gh" data-a="duplicar">Duplicar</button>
        ${wa ? `<a class="btn gh" href="${wa}" target="_blank" rel="noopener" style="text-decoration:none">WhatsApp</a>` : `<button class="btn gh" disabled>Sem telefone</button>`}
        ${o.pdfUrl ? `<a class="btn gh" href="${esc(o.pdfUrl)}" target="_blank" rel="noopener" style="text-decoration:none">PDF no Drive</a>` : ""}
        <button class="btn danger" data-a="excluir">Excluir</button>
      </div>
      <button class="btn gh w" data-a="fechar" style="margin-top:10px">Fechar</button>`);
    $("#sheet").onclick = async (e) => {
      const c = e.target.closest("[data-s]");
      if (c) { o.status = c.dataset.s; o.statusData = hoje(); gravar(o); $$("#stChips .chip").forEach((x) => x.classList.toggle("on", x === c)); renderLista(); sincronizar(o); toast("Status: " + STATUS[o.status]); return; }
      const b = e.target.closest("[data-a]"); if (!b) return;
      const a = b.dataset.a;
      if (a === "fechar") fecharSheet();
      if (a === "editar") { atual = clone(o); store.set(K.atual, atual); preencherForm(); fecharSheet(); irPara("form"); }
      if (a === "pdf") { atual = clone(o); store.set(K.atual, atual); preencherForm(); fecharSheet(); irPara("form"); gerarEEnviar(); }
      if (a === "duplicar") { const n = clone(o); Object.assign(n, { id: uid(), numero: null, data: hoje(), status: "rascunho", statusData: hoje(), sync: false, pdfUrl: "", criadoEm: new Date().toISOString() }); atual = n; store.set(K.atual, atual); preencherForm(); fecharSheet(); irPara("form"); toast("Cópia criada. Ajuste e salve."); }
      if (a === "excluir") {
        fecharSheet();
        if (!(await perguntar("Excluir este orçamento?", `Nº ${pad(o.numero)} · ${o.cliente.nome}. Ele também sai da planilha.`, "Excluir"))) return;
        orcs = orcs.filter((x) => x.id !== o.id); store.set(K.orc, orcs); renderLista();
        if (temPlanilha()) { try { await post({ acao: "excluir", id: o.id }); } catch (e) { toast("Excluído no celular. Não foi possível remover da planilha agora."); } }
      }
    };
  }
  function abrirSheet(html) { $("#sheet").innerHTML = html; $("#sheetBg").classList.add("on"); }
  function fecharSheet() { $("#sheetBg").classList.remove("on"); }
  function perguntar(titulo, texto, ok) {
    return new Promise((res) => {
      abrirSheet(`<h3>${esc(titulo)}</h3><p style="color:#6F6A62;font-size:14px">${esc(texto)}</p><div class="grid"><button class="btn gh" data-r="0">Cancelar</button><button class="btn pri" data-r="1">${esc(ok)}</button></div>`);
      $("#sheet").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; fecharSheet(); res(b.dataset.r === "1"); };
    });
  }

  // ---------------------------------------------------------------- ajustes
  const CAMPOS = { cEmpresa: "empresa", cResp: "responsavel", cDoc: "documento", cTel: "telefone", cIg: "instagram", cRegiao: "regiao", cValidade: "validade", cProx: "proximo", cPrazo: "prazo", cParc: "parcelamento", cObs: "obs", cUrl: "url", cChave: "chave" };
  function preencherCfg() { Object.entries(CAMPOS).forEach(([id, k]) => { $("#" + id).value = cfg[k] == null ? "" : cfg[k]; }); }
  function lerCfg() {
    Object.entries(CAMPOS).forEach(([id, k]) => { cfg[k] = $("#" + id).value.trim(); });
    cfg.validade = parseInt(cfg.validade) || 15; cfg.proximo = Math.max(parseInt(cfg.proximo) || 1, 1);
    store.set(K.cfg, cfg);
  }
  function ligarAjustes() {
    $("#btnSalvarCfg").onclick = () => { lerCfg(); toast("Ajustes salvos."); syncInfo(); if (!atual.numero) preencherForm(); sincronizarPendentes(); };
    $("#btnTestar").onclick = async () => {
      lerCfg(); const s = $("#cStatus");
      if (!temPlanilha()) { s.textContent = "Cole a URL do app da web (começa com https://script.google.com/)."; return; }
      s.textContent = "Testando…";
      try { const r = await fetch(cfg.url + "?acao=teste&chave=" + encodeURIComponent(cfg.chave)); const j = await r.json();
        if (!j.ok) throw new Error(j.erro); s.textContent = `Conectado à planilha “${j.planilha}”. ${j.total} orçamento(s) registrados.`; syncInfo(); sincronizarPendentes();
      } catch (e) { s.textContent = "Não conectou: " + (e.message || "verifique a URL e a chave") + "."; }
    };
    $("#btnRestaurar").onclick = async () => {
      lerCfg(); if (!temPlanilha()) { toast("Configure a planilha primeiro."); return; }
      if (!(await perguntar("Restaurar da planilha?", "Os orçamentos da planilha que não estão neste celular serão trazidos para cá.", "Restaurar"))) return;
      try {
        const r = await fetch(cfg.url + "?acao=listar&chave=" + encodeURIComponent(cfg.chave)); const j = await r.json(); if (!j.ok) throw new Error(j.erro);
        let novos = 0;
        j.orcamentos.forEach((o) => { o.sync = true; const i = orcs.findIndex((x) => x.id === o.id); if (i < 0) { orcs.push(o); novos++; } else if (orcs[i].sync) orcs[i] = o; });
        const maior = orcs.reduce((m, o) => Math.max(m, o.numero || 0), 0); if (maior >= cfg.proximo) cfg.proximo = maior + 1;
        store.set(K.orc, orcs); store.set(K.cfg, cfg); preencherCfg(); renderLista(); toast(`${novos} orçamento(s) restaurados.`);
      } catch (e) { toast("Não foi possível restaurar: " + e.message); }
    };
    $("#btnExport").onclick = () => {
      const blob = new Blob([JSON.stringify({ app: "orcamentos-master-pinturas", versao: VERSAO, data: new Date().toISOString(), cfg, orcs }, null, 1)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `backup_orcamentos_${hoje()}.json`; a.click();
    };
    $("#btnImport").onclick = () => $("#fileImport").click();
    $("#fileImport").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const j = JSON.parse(await f.text()); if (!Array.isArray(j.orcs)) throw 0;
        let n = 0; j.orcs.forEach((o) => { if (!orcs.some((x) => x.id === o.id)) { o.sync = false; orcs.push(o); n++; } });
        const maior = orcs.reduce((m, o) => Math.max(m, o.numero || 0), 0); if (maior >= cfg.proximo) cfg.proximo = maior + 1;
        store.set(K.orc, orcs); store.set(K.cfg, cfg); preencherCfg(); renderLista(); toast(`${n} orçamento(s) importados.`); sincronizarPendentes();
      } catch (er) { toast("Arquivo de backup inválido."); }
      e.target.value = "";
    };
  }

  // ---------------------------------------------------------------- navegação
  function irPara(tab) {
    $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + tab));
    $$("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("#barra").classList.toggle("hide", tab !== "form");
    $("#hdrSub").textContent = { form: "Orçamento", lista: "Histórico", ajustes: "Ajustes" }[tab];
    if (tab === "lista") renderLista(); if (tab === "ajustes") preencherCfg();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- início
  function iniciar() {
    atual = store.get(K.atual, null) || novoOrc();
    if (!atual.materiais) atual = novoOrc();
    ligarForm(); ligarLista(); ligarAjustes(); preencherForm(); syncInfo();
    $$("nav button").forEach((b) => (b.onclick = () => { lerForm(); irPara(b.dataset.tab); }));
    $("#sheetBg").addEventListener("click", (e) => { if (e.target.id === "sheetBg") fecharSheet(); });
    window.addEventListener("online", () => { syncInfo(); sincronizarPendentes(); });
    window.addEventListener("offline", syncInfo);
    setTimeout(sincronizarPendentes, 1500);
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // exposto para testes
  window.MP = { gerarPDF: (o) => gerarPDF(o), totais, num, estado: () => ({ cfg, orcs, atual }) };
  document.addEventListener("DOMContentLoaded", iniciar);
})();
