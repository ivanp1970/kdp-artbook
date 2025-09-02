import React, { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import * as pdfjsLib from "pdfjs-dist/build/pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min?url";
import JSZip from "jszip";
import Tesseract from "tesseract.js";
import FinalPreview from "./FinalPreview"; // ⬅️ NUOVO

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Trim suggeriti
const TRIMS = [
  { key: "6x9", w: 6, h: 9, label: "6 × 9 in" },
  { key: "8x10", w: 8, h: 10, label: "8 × 10 in" },
  { key: "8.25x11", w: 8.25, h: 11, label: "8.25 × 11 in" },
  { key: "8.5x11", w: 8.5, h: 11, label: "8.5 × 11 in" },
  { key: "custom", w: 6, h: 9, label: "Personalizzato…" },
];

function calcBleedSize(w, h, bleed) {
  return bleed ? { w: w + 0.125, h: h + 0.25 } : { w, h };
}
const nl = (s) => (s || "").replace(/\r\n?|\u2028|\u2029/g, "\n");

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.textContent || "").replace(/\u00A0/g, " ");
}

/* ---------------- Pulizia (opzionale) ---------------- */
function autoRemoveHeadersFooters(pages) {
  if (!Array.isArray(pages) || pages.length < 3) return pages;
  const first = {}, last = {};
  const head = (s) => nl(s).trim().slice(0, 120);
  const tail = (s) => nl(s).trim().slice(-120);
  pages.forEach((p) => {
    const f = head(p), l = tail(p);
    if (f) first[f] = (first[f] || 0) + 1;
    if (l) last[l] = (last[l] || 0) + 1;
  });
  const minHits = Math.floor(pages.length * 0.6);
  const Fs = Object.entries(first).filter(([, c]) => c >= minHits).map(([k]) => k);
  const Ls = Object.entries(last).filter(([, c]) => c >= minHits).map(([k]) => k);
  return pages.map((p) => {
    let t = p;
    Fs.forEach((f) => (t = t.replaceAll(f, "")));
    Ls.forEach((l) => (t = t.replaceAll(l, "")));
    return t;
  });
}
function removePublisherLines(text) {
  const banned = [/^ *©/i, /^ *copyright/i, /^ *isbn/i, /^ *edizione/i, /^ *impaginazione/i, /^ *stampato in/i, /^ *prima edizione/i, /^ *collana/i];
  return nl(text).split(/\n+/).filter((ln) => !banned.some((re) => re.test(ln))).join("\n");
}
function removeFootnoteMarkers(text) {
  let t = nl(text);
  t = t.replace(/\[(\d{1,3})\]/g, "").replace(/\((\d{1,3})\)/g, "").replace(/\^\d{1,3}/g, "").replace(/(\w)\d{1,3}(\b)/g, "$1$2");
  return t;
}
function removeNotesSections(text) {
  const re = /\n(?:NOTE|NOTE\s+DELL'EDITORE|NOTA\s+DEL\s+CURATORE)[\s\S]*?(?=\n[A-ZÀ-ÖØ-Ý0-9 ,;:'"-]{8,}\n|$)/g;
  return nl(text).replace(re, "\n");
}
function tidy(text) {
  return nl(text)
    .replace(/[\t\f\v]+/g, " ")
    .replace(/\s{3,}/g, " ")
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\n{3,}/g, "\n\n");
}

/* ---------------- Diff semplice (word-level LCS) ---------------- */
function diffWordsHTML(a, b) {
  const AT = a.split(/(\s+)/);
  const BT = b.split(/(\s+)/);
  const n = AT.length, m = BT.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = AT[i] === BT[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  const out = [];
  while (i < n && j < m) {
    if (AT[i] === BT[j]) {
      out.push(escapeHtml(AT[i]));
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`<span class="bg-red-100 line-through">${escapeHtml(AT[i])}</span>`);
      i++;
    } else {
      out.push(`<span class="bg-green-100">${escapeHtml(BT[j])}</span>`);
      j++;
    }
  }
  while (i < n) { out.push(`<span class="bg-red-100 line-through">${escapeHtml(AT[i++])}</span>`); }
  while (j < m) { out.push(`<span class="bg-green-100">${escapeHtml(BT[j++])}</span>`); }
  return out.join("");
}
function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/* ---------------- Component ---------------- */
export default function TextBook() {
  /* Originale */
  const [originalType, setOriginalType] = useState(null); // "pdf" | "epub"
  // PDF
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfNumPages, setPdfNumPages] = useState(0);
  const [pdfPageIndex, setPdfPageIndex] = useState(0);
  const [pdfScale, setPdfScale] = useState(1.25);
  const pdfCanvasRef = useRef(null);
  // EPUB
  const [epubChapters, setEpubChapters] = useState([]); // [{path, htmlBlobUrl, textOnly, headings: [{level,text}]}]
  const [epubIndex, setEpubIndex] = useState(0);

  /* Testo per unità (pagina/capitolo) – non pulito */
  const [rawUnits, setRawUnits] = useState([]); // string[]
  /* Modifiche locali */
  const [edits, setEdits] = useState({}); // { "pdf:0": "text", "epub:path": "text" }
  /* Body da impaginare */
  const [body, setBody] = useState("");

  /* Front/Back matter */
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [intro, setIntro] = useState("");
  const [bibliography, setBibliography] = useState("");

  /* Pulizia (opzionale) */
  const [autoHF, setAutoHF] = useState(true);
  const [stripPub, setStripPub] = useState(true);
  const [stripMarks, setStripMarks] = useState(true);
  const [stripNotes, setStripNotes] = useState(true);

  /* Layout */
  const [trimKey, setTrimKey] = useState("6x9");
  const [customW, setCustomW] = useState(6);
  const [customH, setCustomH] = useState(9);
  const [bleed, setBleed] = useState(false);
  const [marginIn, setMarginIn] = useState(0.75);
  const [fontSize, setFontSize] = useState(11);
  const [lineHeight, setLineHeight] = useState(1.4);
  const [useSerif, setUseSerif] = useState(true);
  const [pageNumbers, setPageNumbers] = useState(true);

  /* Diff */
  const [showDiff, setShowDiff] = useState(true);

  /* OCR */
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState(""); // messaggi
  const [ocrRunning, setOcrRunning] = useState(false);

  const trim = useMemo(() => {
    const t = TRIMS.find((t) => t.key === trimKey) || TRIMS[0];
    return t.key === "custom" ? { ...t, w: customW, h: customH } : t;
  }, [trimKey, customW, customH]);

  /* -------------- Import file -------------- */
  async function onOpenFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const name = (f.name || "").toLowerCase();
    resetAll();
    try {
      if (name.endsWith(".pdf")) {
        setOriginalType("pdf");
        await loadPdf(f);
      } else if (name.endsWith(".epub")) {
        setOriginalType("epub");
        await loadEpub(f);
      } else {
        alert("Formato non supportato. Carica un PDF o un EPUB.");
      }
    } catch (err) {
      console.error(err);
      alert("Errore lettura file: " + (err?.message || ""));
    }
  }
  function resetAll() {
    setPdfDoc(null); setPdfNumPages(0); setPdfPageIndex(0);
    setEpubChapters([]); setEpubIndex(0);
    setRawUnits([]); setEdits({});
    setBody(""); setOcrProgress(0); setOcrStatus(""); setOcrRunning(false);
  }

  /* -------------- PDF: carica + estrai testo -------------- */
  async function loadPdf(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    setPdfDoc(pdf);
    setPdfNumPages(pdf.numPages);

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const c = await p.getTextContent();
      const text = c.items.map((it) => it.str).join(" ");
      pages.push(text);
    }
    setRawUnits(pages);
    setBody(pages.join("\n\n"));
  }

  /* -------------- EPUB: CSS inline + risorse + TOC -------------- */
  async function loadEpub(file) {
    const ab = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(ab);
    const paths = Object.keys(zip.files).filter((p) => /\.(xhtml|html|htm)$/i.test(p)).sort();

    const resourceUrl = {};
    async function getResourceUrl(relPath, basePath) {
      let full = relPath;
      if (!/^https?:/i.test(relPath)) {
        const baseDir = basePath.split("/").slice(0, -1).join("/");
        full = (baseDir ? baseDir + "/" : "") + relPath;
      }
      const f = zip.file(full);
      if (!f) return relPath; // esterno
      if (resourceUrl[full]) return resourceUrl[full];

      const ext = full.split(".").pop().toLowerCase();
      const mime =
        ext === "png" ? "image/png" :
        ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
        ext === "gif" ? "image/gif" :
        ext === "svg" ? "image/svg+xml" :
        ext === "css" ? "text/css" : "application/octet-stream";

      const blob = new Blob([await f.async("arraybuffer")], { type: mime });
      const url = URL.createObjectURL(blob);
      resourceUrl[full] = url;
      return url;
    }

    async function inlineCss(cssText, basePath) {
      const re = /url\((['"]?)([^'")]+)\1\)/g;
      const parts = [];
      let last = 0;
      for (let m; (m = re.exec(cssText)); ) {
        parts.push(cssText.slice(last, m.index));
        const asset = m[2];
        // eslint-disable-next-line no-await-in-loop
        const url = await getResourceUrl(asset, basePath);
        parts.push(`url('${url}')`);
        last = re.lastIndex;
      }
      parts.push(cssText.slice(last));
      return parts.join("");
    }

    const chapters = [];
    for (const p of paths) {
      const html = await zip.file(p).async("string");
      const doc = new DOMParser().parseFromString(html, "text/html");

      // IMMAGINI
      const imgs = Array.from(doc.querySelectorAll("img[src]"));
      for (const img of imgs) {
        const src = img.getAttribute("src");
        // eslint-disable-next-line no-await-in-loop
        const url = await getResourceUrl(src, p);
        img.setAttribute("src", url);
      }

      // CSS → inline style
      const links = Array.from(doc.querySelectorAll("link[rel=stylesheet][href]"));
      for (const link of links) {
        const href = link.getAttribute("href");
        const f = p.split("/").slice(0, -1).join("/");
        const basePath = (f ? f + "/" : "") + href;
        const cssFile = zip.file(basePath);
        if (cssFile) {
          // eslint-disable-next-line no-await-in-loop
          let cssText = await cssFile.async("string");
          // eslint-disable-next-line no-await-in-loop
          cssText = await inlineCss(cssText, basePath);
          const style = doc.createElement("style");
          style.textContent = cssText;
          link.parentNode.replaceChild(style, link);
        }
      }

      // Crea TOC dal documento: H1-H3
      const headings = Array.from(doc.querySelectorAll("h1, h2, h3")).map((h) => ({
        level: h.tagName.toLowerCase(),
        text: (h.textContent || "").trim().replace(/\s+/g, " "),
      }));

      // Blob URL per anteprima
      const htmlString = "<!doctype html>" + (doc.documentElement?.outerHTML || "");
      const blob = new Blob([htmlString], { type: "text/html" });
      const htmlBlobUrl = URL.createObjectURL(blob);

      chapters.push({
        path: p,
        htmlBlobUrl,
        textOnly: stripHtml(html),
        headings,
      });
    }

    setEpubChapters(chapters);
    setRawUnits(chapters.map((c) => c.textOnly));
    setBody(chapters.map((c) => c.textOnly).join("\n\n"));
  }

  /* -------------- Anteprima PDF (render canvas) -------------- */
  useEffect(() => {
    if (originalType !== "pdf" || !pdfDoc) return;
    let cancelled = false;
    (async () => {
      try {
        const pageNum = pdfPageIndex + 1;
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: pdfScale });
        const canvas = pdfCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const renderContext = { canvasContext: ctx, viewport };
        const task = page.render(renderContext);
        await task.promise;
        if (cancelled) return;
      } catch (e) {
        console.error(e);
      }
    })();
    return () => { cancelled = true; };
  }, [originalType, pdfDoc, pdfPageIndex, pdfScale]);

  /* -------------- Editor selezione corrente -------------- */
  const currentKey =
    originalType === "pdf" ? `pdf:${pdfPageIndex}` :
    originalType === "epub" ? `epub:${epubChapters[epubIndex]?.path || ""}` : "";

  const currentOriginalText =
    originalType === "pdf" ? (rawUnits[pdfPageIndex] || "") :
    originalType === "epub" ? (epubChapters[epubIndex]?.textOnly || "") : "";

  const currentEditedText = edits[currentKey] ?? currentOriginalText;

  function saveCurrentEdit() {
    if (!currentKey) return;
    setEdits((prev) => ({ ...prev, [currentKey]: currentEditedText }));
    alert("Modifica salvata per l’elemento corrente.");
  }

  /* Trova/Sostituisci */
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  function applyReplace() {
    if (!currentKey) return;
    const target = edits[currentKey] ?? currentOriginalText;
    if (!findText) return;
    const re = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const replaced = target.replace(re, replaceText);
    setEdits((prev) => ({ ...prev, [currentKey]: replaced }));
  }

  /* BODY da modifiche (senza pulizia) */
  function buildBodyFromEdits() {
    if (originalType === "pdf") {
      const arr = rawUnits.map((txt, i) => edits[`pdf:${i}`] ?? txt);
      setBody(arr.join("\n\n"));
    } else if (originalType === "epub") {
      const arr = epubChapters.map((c) => edits[`epub:${c.path}`] ?? c.textOnly);
      setBody(arr.join("\n\n"));
    } else {
      alert("Carica prima un PDF o EPUB.");
    }
  }

  /* -------------- OCR (PDF) -------------- */
  async function ocrCurrentPage() {
    if (originalType !== "pdf" || !pdfDoc) return;
    setOcrRunning(true);
    setOcrProgress(0);
    setOcrStatus("Render pagina…");
    try {
      const page = await pdfDoc.getPage(pdfPageIndex + 1);
      const scale = 2.0; // OCR migliore
      const viewport = page.getViewport({ scale });
      const cnv = document.createElement("canvas");
      cnv.width = viewport.width;
      cnv.height = viewport.height;
      const ctx = cnv.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      setOcrStatus("OCR in corso… (ita+eng)");
      const { data } = await Tesseract.recognize(cnv, "ita+eng", {
        logger: (m) => setOcrProgress(m.progress || 0),
      });
      const text = tidy(data?.text || "");
      setEdits((prev) => ({ ...prev, [currentKey]: text }));
      setOcrStatus("Fatto.");
    } catch (e) {
      console.error(e);
      setOcrStatus("Errore OCR: " + (e?.message || ""));
    } finally {
      setOcrRunning(false);
    }
  }

  async function ocrAllPages() {
    if (originalType !== "pdf" || !pdfDoc) return;
    if (!confirm("Eseguo OCR su TUTTE le pagine? Può richiedere tempo.")) return;
    setOcrRunning(true);
    try {
      for (let idx = 0; idx < pdfNumPages; idx++) {
        setOcrStatus(`Pagina ${idx + 1}/${pdfNumPages} – render…`);
        const page = await pdfDoc.getPage(idx + 1);
        const scale = 2.0;
        const viewport = page.getViewport({ scale });
        const cnv = document.createElement("canvas");
        cnv.width = viewport.width;
        cnv.height = viewport.height;
        const ctx = cnv.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;

        setOcrStatus(`Pagina ${idx + 1}/${pdfNumPages} – OCR…`);
        setOcrProgress(0);
        const { data } = await Tesseract.recognize(cnv, "ita+eng", {
          logger: (m) => setOcrProgress(m.progress || 0),
        });
        const text = tidy(data?.text || "");
        const key = `pdf:${idx}`;
        setEdits((prev) => ({ ...prev, [key]: text }));
      }
      setOcrStatus("OCR completo.");
    } catch (e) {
      console.error(e);
      setOcrStatus("Errore OCR: " + (e?.message || ""));
    } finally {
      setOcrRunning(false);
    }
  }

  /* -------------- Pulizia automatica (opzionale) -------------- */
  function runCleanup() {
    let pages = rawUnits && rawUnits.length ? rawUnits.slice() : (body ? body.split(/\n{2,}/) : []);
    if (!pages.length) {
      alert("Nessun testo da pulire: carica un PDF/EPUB o incolla testo.");
      return;
    }
    if (autoHF && originalType === "pdf") pages = autoRemoveHeadersFooters(pages);
    let t = pages.join("\n\n");
    if (stripPub) t = removePublisherLines(t);
    if (stripMarks) t = removeFootnoteMarkers(t);
    if (stripNotes) t = removeNotesSections(t);
    t = tidy(t);
    setBody(t);
  }

  /* -------------- Impaginazione PDF finale -------------- */
  function exportPdf() {
    const { w: pageW, h: pageH } = calcBleedSize(trim.w, trim.h, bleed);
    const doc = new jsPDF({ unit: "in", format: [pageW, pageH], orientation: "portrait" });
    const m = marginIn;
    const font = useSerif ? "Times" : "Helvetica";
    const leading = (fontSize / 72) * lineHeight;

    if (title) {
      doc.setFont(font, "bold");
      doc.setFontSize(fontSize + 8);
      doc.text(title, pageW / 2, pageH * 0.35, { align: "center" });
      if (author) {
        doc.setFont(font, "normal");
        doc.setFontSize(fontSize + 2);
        doc.text(author, pageW / 2, pageH * 0.45, { align: "center" });
      }
      doc.addPage();
    }
    if (intro.trim()) {
      doc.setFont(font, "bold");
      doc.setFontSize(fontSize + 3);
      doc.text("Introduzione", m, m);
      doc.setFont(font, "normal");
      doc.setFontSize(fontSize);
      flowText(doc, intro, m, m + 0.35, pageW - m, pageH - m, leading, pageNumbers);
      doc.addPage();
    }

    doc.setFont(font, "normal");
    doc.setFontSize(fontSize);
    flowText(doc, body, m, m, pageW - m, pageH - m, leading, pageNumbers);

    if (bibliography.trim()) {
      doc.addPage();
      doc.setFont(font, "bold");
      doc.setFontSize(fontSize + 3);
      doc.text("Appendici e Bibliografia", m, m);
      doc.setFont(font, "normal");
      doc.setFontSize(fontSize);
      flowText(doc, bibliography, m, m + 0.35, pageW - m, pageH - m, leading, pageNumbers);
    }

    const safe = (title || "Libro_di_testo")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 _-]/gi, "_").trim().replace(/\s+/g, "_");
    doc.save(`${safe}.pdf`);
  }

  function flowText(doc, text, x, y, maxX, maxY, leading, withPageNumbers = false) {
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const maxWidth = maxX - x;
    const paragraphs = nl(text).split(/\n\n+/);
    let curY = y;
    let pageNum = doc.getNumberOfPages();

    for (const p of paragraphs) {
      const lines = doc.splitTextToSize(p, maxWidth);
      for (const ln of lines) {
        if (curY > maxY) {
          if (withPageNumbers) addPageNumber(doc, pageNum, pageW, pageH);
          doc.addPage();
          pageNum = doc.getNumberOfPages();
          curY = y;
        }
        doc.text(ln, x, curY);
        curY += leading;
      }
      curY += leading * 0.5;
    }
    if (withPageNumbers) addPageNumber(doc, pageNum, pageW, pageH);
  }

  function addPageNumber(doc, pageNum, pageW, pageH) {
    doc.setFontSize(9);
    doc.text(String(pageNum), pageW / 2, pageH - 0.4, { align: "center" });
  }

  /* -------- Copertina rapida: salva immagini e vai al Designer -------- */
  function storeCoverAndGo(side, file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = (e) => {
      try {
        localStorage.setItem(side === "front" ? "kdp_cover_front" : "kdp_cover_back", e.target.result);
        window.location.hash = "#cover";
      } catch (err) {
        alert("Errore nel salvataggio locale dell'immagine: " + (err?.message || ""));
      }
    };
    fr.readAsDataURL(file);
  }

  /* -------------- UI -------------- */
  const toc = useMemo(() => {
    if (originalType !== "epub") return [];
    const out = [];
    epubChapters.forEach((c, idx) => {
      (c.headings || []).forEach((h) => {
        out.push({ chapterIndex: idx, level: h.level, text: h.text });
      });
    });
    return out;
  }, [originalType, epubChapters]);

  const diffHTML = useMemo(() => {
    if (!showDiff) return "";
    return diffWordsHTML(currentOriginalText, currentEditedText);
  }, [showDiff, currentOriginalText, currentEditedText]);

  return (
    <div className="p-4 space-y-4">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-xl font-bold">Libro di Testo – PDF/EPUB</h2>
          <p className="text-sm text-neutral-600">
            Anteprima originale completa; modifica mirata senza pulizia; Diff, OCR (PDF), CSS inline & Indice (EPUB); esporta PDF KDP.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input type="file" accept=".pdf,.epub" onChange={onOpenFile} className="hidden" id="textbook-file" />
          <label htmlFor="textbook-file" className="px-3 py-2 rounded-xl border shadow-sm cursor-pointer">Carica PDF/EPUB</label>

          {originalType === "pdf" && (
            <>
              <button className="px-3 py-2 rounded-xl border shadow-sm" onClick={ocrCurrentPage} disabled={ocrRunning}>
                OCR pagina
              </button>
              <button className="px-3 py-2 rounded-xl border shadow-sm" onClick={ocrAllPages} disabled={ocrRunning}>
                OCR tutto (lento)
              </button>
            </>
          )}

          <button className="px-3 py-2 rounded-xl border shadow-sm" onClick={buildBodyFromEdits}>Crea testo modificato (senza pulizia)</button>
          <button className="px-3 py-2 rounded-xl border shadow-sm" onClick={runCleanup}>Pulisci</button>
          <button className="px-4 py-2 rounded-2xl shadow bg-black text-white" onClick={exportPdf}>Esporta PDF</button>
        </div>
      </header>

      {/* Stato OCR */}
      {ocrRunning && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-3">
          <div className="flex-1">
            <div className="h-2 bg-amber-100 rounded">
              <div className="h-2 bg-amber-400 rounded" style={{ width: `${Math.round(ocrProgress * 100)}%` }} />
            </div>
            <p className="text-xs mt-1 text-amber-800">{ocrStatus} — {Math.round(ocrProgress * 100)}%</p>
          </div>
        </div>
      )}

      {/* 1) ANTEPRIMA ORIGINALE */}
      <section className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* TOC per EPUB */}
        <aside className="lg:col-span-1 bg-white rounded-2xl shadow p-4 h-[70vh] overflow-auto">
          <h3 className="font-semibold mb-2">Indice (EPUB)</h3>
          {originalType === "epub" && toc.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {toc.map((e, i) => (
                <li key={i}>
                  <button
                    className="text-left w-full hover:underline"
                    style={{ paddingLeft: e.level === "h1" ? 0 : e.level === "h2" ? 12 : 24 }}
                    onClick={() => setEpubIndex(e.chapterIndex)}
                  >
                    {e.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-neutral-500">Carica un EPUB per vedere l’indice.</p>
          )}
        </aside>

        {/* Preview */}
        <div className="lg:col-span-3 bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Anteprima originale</h3>
            {originalType === "pdf" && (
              <div className="flex items-center gap-2 text-sm">
                <button className="px-2 py-1 border rounded" onClick={()=>setPdfPageIndex(Math.max(0, pdfPageIndex-1))}>◀</button>
                <span>Pagina {pdfPageIndex+1} / {pdfNumPages || 0}</span>
                <button className="px-2 py-1 border rounded" onClick={()=>setPdfPageIndex(Math.min(pdfNumPages-1, pdfPageIndex+1))}>▶</button>
                <span className="ml-4">Zoom</span>
                <input type="range" min="0.6" max="2" step="0.05" value={pdfScale} onChange={(e)=>setPdfScale(parseFloat(e.target.value)||1.25)} />
                <span className="w-10 text-right">{Math.round(pdfScale*100)}%</span>
              </div>
            )}
            {originalType === "epub" && (
              <div className="flex items-center gap-2 text-sm">
                <button className="px-2 py-1 border rounded" onClick={()=>setEpubIndex(Math.max(0, epubIndex-1))}>◀</button>
                <span>Capitolo {epubIndex+1} / {epubChapters.length || 0}</span>
                <button className="px-2 py-1 border rounded" onClick={()=>setEpubIndex(Math.min(epubChapters.length-1, epubIndex+1))}>▶</button>
              </div>
            )}
          </div>

          {originalType === "pdf" && (
            <div className="w-full overflow-auto border rounded-xl p-2">
              <canvas ref={pdfCanvasRef} className="block mx-auto" />
            </div>
          )}

          {originalType === "epub" && epubChapters[epubIndex] && (
            <div className="w-full overflow-auto border rounded-xl p-2 h-[70vh]">
              <iframe
                title="EPUB preview"
                src={epubChapters[epubIndex].htmlBlobUrl}
                className="w-full h-full rounded"
              />
            </div>
          )}

          {!originalType && (
            <p className="text-sm text-neutral-500">Carica un PDF o un EPUB per vedere l’anteprima completa (copertina, note, immagini).</p>
          )}
        </div>
      </section>

      {/* 2) EDITOR + DIFF */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Editor (elemento selezionato)</h3>
          <p className="text-xs text-neutral-600 mb-2">
            {originalType === "pdf" ? `PDF – Pagina ${pdfPageIndex+1}` :
             originalType === "epub" ? `EPUB – ${epubChapters[epubIndex]?.path || ""}` :
             "Nessun file caricato"}
          </p>

          <textarea
            value={currentEditedText}
            onChange={(e) => setEdits((prev) => ({ ...prev, [currentKey]: e.target.value }))}
            className="w-full h-[40vh] border rounded-xl px-3 py-2 whitespace-pre-wrap"
            placeholder="Testo di questa pagina/capitolo..."
          />

          <div className="mt-3 flex items-end gap-3 flex-wrap">
            <div>
              <label className="block text-xs">Trova</label>
              <input value={findText} onChange={(e)=>setFindText(e.target.value)} className="border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs">Sostituisci con</label>
              <input value={replaceText} onChange={(e)=>setReplaceText(e.target.value)} className="border rounded px-2 py-1" />
            </div>
            <button className="px-3 py-2 border rounded-xl" onClick={applyReplace}>Sostituisci (solo selezionato)</button>
            <button className="px-3 py-2 border rounded-xl" onClick={saveCurrentEdit}>Salva modifica</button>
            <label className="inline-flex items-center gap-2 text-sm ml-auto">
              <input type="checkbox" checked={showDiff} onChange={(e)=>setShowDiff(e.target.checked)} />
              Mostra diff
            </label>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Diff (originale vs modificato)</h3>
          {showDiff ? (
            <div
              className="prose max-w-none text-sm p-3 border rounded-xl overflow-auto h-[40vh] whitespace-pre-wrap"
              dangerouslySetInnerHTML={{ __html: diffHTML }}
            />
          ) : (
            <p className="text-xs text-neutral-500">Attiva “Mostra diff” per evidenziare le modifiche.</p>
          )}
          <p className="text-xs text-neutral-500 mt-2">
            Verde = aggiunte; Rosso barrato = rimosse. Il diff è per l’elemento selezionato (pagina/capitolo).
          </p>
        </div>
      </section>

      {/* 3) Body risultante + Impaginazione */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Anteprima testo risultante</h3>
          <p className="text-xs text-neutral-600 mb-2">
            Questo è il testo su cui verrà fatta l’impaginazione. Genera da “Crea testo modificato (senza pulizia)” o usa “Pulisci”.
          </p>
          <textarea
            value={body}
            onChange={(e)=>setBody(e.target.value)}
            className="w-full h-[40vh] border rounded-xl px-3 py-2 whitespace-pre-wrap"
          />
        </div>

        {/* Impaginazione */}
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Impaginazione</h3>
          <label className="block text-sm mb-1">Trim size</label>
          <select value={trimKey} onChange={(e)=>setTrimKey(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2">
            {TRIMS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {trimKey === "custom" && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <label className="block text-xs mb-1">Larghezza (in)</label>
                <input type="number" step="0.01" value={customW} onChange={(e)=>setCustomW(parseFloat(e.target.value)||customW)} className="w-full border rounded-xl px-3 py-2"/>
              </div>
              <div>
                <label className="block text-xs mb-1">Altezza (in)</label>
                <input type="number" step="0.01" value={customH} onChange={(e)=>setCustomH(parseFloat(e.target.value)||customH)} className="w-full border rounded-xl px-3 py-2"/>
              </div>
            </div>
          )}
          <label className="block text-sm mb-1"><input type="checkbox" className="mr-2" checked={bleed} onChange={(e)=>setBleed(e.target.checked)} /> Con bleed (+0.125″ W, +0.25″ H)</label>
          <label className="block text-sm mb-1">Margini (in)</label>
          <input type="number" step="0.05" min="0.25" value={marginIn} onChange={(e)=>setMarginIn(parseFloat(e.target.value)||marginIn)} className="w-full border rounded-xl px-3 py-2 mb-2"/>
          <div className="grid grid-cols-3 gap-2">
            <div><label className="block text-xs mb-1">Serif</label><label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={useSerif} onChange={(e)=>setUseSerif(e.target.checked)} /> Serif</label></div>
            <div><label className="block text-xs mb-1">Dimensione (pt)</label><input type="number" min="9" step="1" value={fontSize} onChange={(e)=>setFontSize(parseInt(e.target.value)||fontSize)} className="w-full border rounded-xl px-3 py-2"/></div>
            <div><label className="block text-xs mb-1">Interlinea</label><input type="number" min="1" step="0.05" value={lineHeight} onChange={(e)=>setLineHeight(parseFloat(e.target.value)||lineHeight)} className="w-full border rounded-xl px-3 py-2"/></div>
          </div>
          <label className="block text-sm mt-2"><input type="checkbox" className="mr-2" checked={pageNumbers} onChange={(e)=>setPageNumbers(e.target.checked)} /> Numeri di pagina</label>

          <div className="mt-4">
            <h4 className="font-semibold mb-2">Front/Back matter</h4>
            <label className="block text-sm mb-1">Titolo</label>
            <input value={title} onChange={(e)=>setTitle(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2"/>
            <label className="block text-sm mb-1">Autore/Editore</label>
            <input value={author} onChange={(e)=>setAuthor(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2"/>
            <label className="block text-sm mb-1">Introduzione</label>
            <textarea value={intro} onChange={(e)=>setIntro(e.target.value)} className="w-full h-20 border rounded-xl px-3 py-2 mb-2"/>
            <label className="block text-sm mb-1">Appendici / Bibliografia</label>
            <textarea value={bibliography} onChange={(e)=>setBibliography(e.target.value)} className="w-full h-20 border rounded-xl px-3 py-2"/>
          </div>
        </div>
      </section>

      {/* 5) Copertina rapida (PRIMA/QUARTA) */}
      <section className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-2">Copertina rapida (PRIMA/QUARTA)</h3>
        <p className="text-sm text-neutral-600 mb-3">
          Carica qui le immagini di <b>PRIMA</b> e <b>QUARTA</b>. Verranno aperte nel Designer Copertina e posizionate automaticamente.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm mb-1">Prima di copertina (fronte)</label>
            <input type="file" accept="image/*" onChange={(e)=> e.target.files && storeCoverAndGo("front", e.target.files[0])} />
          </div>
          <div>
            <label className="block text-sm mb-1">Quarta di copertina (retro)</label>
            <input type="file" accept="image/*" onChange={(e)=> e.target.files && storeCoverAndGo("back", e.target.files[0])} />
          </div>
        </div>
        <div className="mt-3">
          <a href="#cover" className="px-3 py-2 rounded-xl border shadow-sm inline-block">Apri Designer Copertina</a>
        </div>
      </section>

      {/* 6) Anteprima finale impaginata */}
      <FinalPreview
        body={body}
        title={title}
        author={author}
        intro={intro}
        bibliography={bibliography}
        trimW={trim.w}
        trimH={trim.h}
        bleed={bleed}
        marginIn={marginIn}
        fontSize={fontSize}
        lineHeight={lineHeight}
        useSerif={useSerif}
      />
    </div>
  );
}
