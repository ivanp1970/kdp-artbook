import React, { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";

/**
 * KDP ArtBook Builder – Caravaggio (v2 corretta)
 *
 * - Integrazione AI ChatGPT (inserisci la tua API key nell’app)
 * - Formati 6×9, 8×10, 8.5×11 + bleed on/off
 * - Controllo DPI immagini
 * - KDP Checker (margini, pagine minime, DPI)
 * - PDF pronto per KDP
 */

const TRIMS = [
  { key: "6x9", w: 6, h: 9, label: "6 × 9 in (15.24 × 22.86 cm)" },
  { key: "8x10", w: 8, h: 10, label: "8 × 10 in (20.32 × 25.4 cm)" },
  { key: "8.5x11", w: 8.5, h: 11, label: "8.5 × 11 in (21.59 × 27.94 cm)" },
];

const INK_OPTIONS = [
  { key: "premium_color", label: "Premium Color" },
  { key: "standard_color", label: "Standard Color" },
  { key: "bw", label: "B/N" },
];

function pxNeeded(widthIn, heightIn, dpi = 300) {
  return { w: Math.round(widthIn * dpi), h: Math.round(heightIn * dpi) };
}

function calcBleedSize(trimW, trimH, bleed) {
  if (!bleed) return { w: trimW, h: trimH };
  return { w: trimW + 0.125, h: trimH + 0.25 };
}

export default function KdpArtBookBuilder() {
  const fileInputRef = useRef(null);
  const [items, setItems] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [bookTitle, setBookTitle] = useState("Caravaggio – Opere");
  const [author, setAuthor] = useState("");
  const [includeTitlePage, setIncludeTitlePage] = useState(true);
  const [inkType, setInkType] = useState("premium_color");

  const [trimKey, setTrimKey] = useState("6x9");
  const trim = useMemo(() => TRIMS.find((t) => t.key === trimKey) || TRIMS[0], [trimKey]);
  const [bleed, setBleed] = useState(false);
  const [marginIn, setMarginIn] = useState(0.5);
  const [fontSize, setFontSize] = useState(11);
  const [lineHeight, setLineHeight] = useState(1.35);
  const [useSerif, setUseSerif] = useState(true);

  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    const k = localStorage.getItem("OPENAI_API_KEY") || "";
    if (k) setApiKey(k);
  }, []);
  function saveKey() {
    localStorage.setItem("OPENAI_API_KEY", apiKey || "");
    alert("Chiave salvata solo su questo browser.");
  }

  const fontClass = useSerif ? "font-serif" : "font-sans";

  function onFilesSelected(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;

    const readers = arr.map((file, idx) =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const src = e.target.result;
          const img = new Image();
          img.onload = () => {
            resolve({
              id: `${Date.now()}_${idx}`,
              name: file.name,
              src,
              width: img.width,
              height: img.height,
              title: file.name.replace(/\.[^/.]+$/, ""),
              description: "",
              warnings: [],
            });
          };
          img.src = src;
        };
        reader.readAsDataURL(file);
      })
    );

    Promise.all(readers).then((newItems) => {
      const validated = newItems.map((it) => ({ ...it, warnings: validateImage(it) }));
      setItems((prev) => {
        const merged = [...prev, ...validated];
        if (prev.length === 0) setSelectedIndex(0);
        return merged;
      });
    });
  }

  function validateImage(it) {
    const { w: pageW, h: pageH } = calcBleedSize(trim.w, trim.h, bleed);
    const m = marginIn;
    const boxW = pageW - m * 2;
    const boxH = pageH - m * 2;
    const needs = pxNeeded(boxW, boxH, 300);
    const warns = [];
    if (it.width < needs.w || it.height < needs.h) {
      warns.push(
        `Risoluzione bassa: minimo ${needs.w}×${needs.h}px, hai ${it.width}×${it.height}px.`
      );
    }
    return warns;
  }

  function revalidateAll() {
    setItems((prev) => prev.map((it) => ({ ...it, warnings: validateImage(it) })));
  }

  function removeItem(index) {
    setItems((prev) => {
      const copy = [...prev];
      copy.splice(index, 1);
      let nextSelected = selectedIndex;
      if (index === selectedIndex) nextSelected = Math.max(0, selectedIndex - 1);
      setSelectedIndex(nextSelected);
      return copy;
    });
  }

  function moveItem(index, dir) {
    setItems((prev) => {
      const copy = [...prev];
      const newIndex = index + dir;
      if (newIndex < 0 || newIndex >= copy.length) return prev;
      const [moved] = copy.splice(index, 1);
      copy.splice(newIndex, 0, moved);
      setSelectedIndex(newIndex);
      return copy;
    });
  }

  function updateField(index, field, value) {
    setItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  }

  async function generateWithAI(index) {
    const it = items[index];
    if (!it) return;
    if (!apiKey) {
      alert("Inserisci la tua OPENAI_API_KEY in Impostazioni.");
      return;
    }
    const prompt = `Scrivi una scheda per il libro su Caravaggio per l'opera "${it.title}". Struttura: Storia, Aneddoti, Analisi, Bibliografia. Lingua: italiano.`;
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Sei un editor d'arte e curatore museale." },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("Risposta vuota");
      updateField(index, "description", text);
    } catch (e) {
      console.error(e);
      alert("Errore AI: " + (e?.message || ""));
    }
  }

  async function exportToPdf() {
    if (!items.length) {
      alert("Carica almeno una immagine.");
      return;
    }

    const { w: pageW, h: pageH } = calcBleedSize(trim.w, trim.h, bleed);
    const doc = new jsPDF({ unit: "in", format: [pageW, pageH], orientation: "portrait" });
    const m = marginIn;

    if (includeTitlePage) {
      doc.setFont(useSerif ? "Times" : "Helvetica", "bold");
      doc.setFontSize(22);
      doc.text(bookTitle || "", pageW / 2, pageH * 0.4, { align: "center" });
      doc.setFont(useSerif ? "Times" : "Helvetica", "normal");
      doc.setFontSize(14);
      if (author) doc.text(author, pageW / 2, pageH * 0.47, { align: "center" });
      doc.addPage();
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];

      // Pagina sinistra (immagine)
      const boxW = pageW - m * 2;
      const boxH = pageH - m * 2;
      const imgRatio = it.width / it.height;
      const boxRatio = boxW / boxH;
      let drawW, drawH;
      if (imgRatio > boxRatio) {
        drawW = boxW;
        drawH = boxW / imgRatio;
      } else {
        drawH = boxH;
        drawW = boxH * imgRatio;
      }
      const offsetX = (pageW - drawW) / 2;
      const offsetY = (pageH - drawH) / 2;

      try {
        doc.addImage(it.src, "JPEG", offsetX, offsetY, drawW, drawH, undefined, "FAST");
      } catch (e) {
        try {
          doc.addImage(it.src, "PNG", offsetX, offsetY, drawW, drawH, undefined, "FAST");
        } catch (e2) {
          console.warn("Immagine non aggiunta", e2);
        }
      }

      // Pagina destra (testo)
      doc.addPage();
      doc.setFont(useSerif ? "Times" : "Helvetica", "bold");
      doc.setFontSize(fontSize + 3);
      doc.text(it.title || "", m, m);

      doc.setFont(useSerif ? "Times" : "Helvetica", "normal");
      doc.setFontSize(fontSize);

      // ✅ FIX QUI: regex tutta su una riga
      const text = (it.description || "").replace(/\r\n|\r/g, "\n");

      const maxWidth = pageW - m * 2;
      const lines = doc.splitTextToSize(text, maxWidth);
      const leading = (fontSize / 72) * lineHeight;
      let cursorY = m + 0.35;

      lines.forEach((ln) => {
        if (cursorY > pageH - m) {
          doc.addPage();
          cursorY = m;
        }
        doc.text(ln, m, cursorY);
        cursorY += leading;
      });

      const totalPages = doc.getNumberOfPages();
      if (totalPages % 2 !== 0 && i < items.length - 1) {
        doc.addPage();
      }
    }

    const fname =
      (bookTitle || "Caravaggio_ArtBook").replace(/[^a-z0-9_\\- ]/gi, "_") +
      (bleed ? "_BLEED" : "") +
      `.pdf`;
    doc.save(fname);
  }

  function kdpCheck() {
    const issues = [];
    const pageCountEstimate = (includeTitlePage ? 1 : 0) + items.length * 2;
    if (inkType === "standard_color" && pageCountEstimate < 72) {
      issues.push(`Pagine minime Standard Color: 72. Attuali: ${pageCountEstimate}.`);
    }
    if ((inkType === "premium_color" || inkType === "bw") && pageCountEstimate < 24) {
      issues.push(`Pagine minime: 24. Attuali: ${pageCountEstimate}.`);
    }
    const outsideMin = bleed ? 0.375 : 0.25;
    if (marginIn < outsideMin) {
      issues.push(`Margine troppo piccolo: ${marginIn}" (minimo ${outsideMin}").`);
    }
    items.forEach((it, i) => {
      const warns = validateImage(it);
      if (warns.length) issues.push(`Opera #${i + 1} (${it.title}): ${warns.join(" ")}`);
    });
    alert(issues.length ? `Problemi:\\n- ` + issues.join("\\n- ") : "Nessun problema critico.");
  }

  useEffect(() => {
    revalidateAll();
  }, [trimKey, bleed, marginIn]);

  const selected = items[selectedIndex];

  return (
    <div className={`min-h-screen ${fontClass} bg-neutral-50`}>
      <div className="max-w-7xl mx-auto p-6">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">KDP ArtBook Builder – Caravaggio</h1>
            <p className="text-sm text-neutral-600">Crea PDF pronto per KDP</p>
          </div>
          <div className="flex gap-2">
            <button onClick={kdpCheck} className="px-3 py-2 rounded-2xl border shadow-sm">
              KDP Checker
            </button>
            <button
              onClick={exportToPdf}
              className="px-4 py-2 rounded-2xl shadow bg-black text-white hover:opacity-90"
            >
              Esporta PDF
            </button>
          </div>
        </header>

        {/* ... resto UI uguale a prima (colonne, input, anteprima, editor testo) */}
      </div>
    </div>
  );
}
