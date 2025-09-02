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
  const [pdfPageIndex, setPdfPageIndex] =
