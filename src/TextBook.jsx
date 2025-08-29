import React, { useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import * as pdfjsLib from "pdfjs-dist/build/pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min?url";
import JSZip from "jszip";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const TRIMS = [
  { key: "6x9", w: 6, h: 9, label: "6 × 9 in" },
  { key: "8x10", w: 8, h: 10, label: "8 × 10 in" },
  { key: "8.25x11", w: 8.25, h: 11, label: "8.25 × 11 in" },
  { key: "8.5x11", w: 8.5, h: 11, label: "8.5 × 11 in" },
  { key: "custom", w: 6, h: 9, label: "Personalizzato…" },
];

function calcBleedSize(w, h, bleed){ return bleed ? { w:w+0.125, h:h+0.25 } : { w, h }; }
const nl = s => (s||"").replace(/\r\n?|\u2028|\u2029/g,"\n");

function stripHtml(html){
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.textContent || "").replace(/\u00A0/g," ");
}

function autoRemoveHeadersFooters(pages){
  if (!Array.isArray(pages) || pages.length<3) return pages;
  const first={}, last={};
  const head = (s)=>nl(s).trim().slice(0,120);
  const tail = (s)=>nl(s).trim().slice(-120);
  pages.forEach(p=>{ const f=head(p), l=tail(p); if(f) first[f]=(first[f]||0)+1; if(l) last[l]=(last[l]||0)+1; });
  const minHits = Math.floor(pages.length*0.6);
  const Fs = Object.entries(first).filter(([,c])=>c>=minHits).map(([k])=>k);
  const Ls = Object.entries(last ).filter(([,c])=>c>=minHits).map(([k])=>k);
  return pages.map(p=>{ let t=p; Fs.forEach(f=>t=t.replaceAll(f,"")); Ls.forEach(l=>t=t.replaceAll(l,"")); return t; });
}
function removePublisherLines(text){
  const banned=[/^ *©/i,/^ *copyright/i,/^ *isbn/i,/^ *edizione/i,/^ *impaginazione/i,/^ *stampato in/i,/^ *prima edizione/i,/^ *collana/i];
  return nl(text).split(/\n+/).filter(ln=>!banned.some(re=>re.test(ln))).join("\n");
}
function removeFootnoteMarkers(text){
  let t=nl(text);
  t=t.replace(/\[(\d{1,3})\]/g,"").replace(/\((\d{1,3})\)/g,"").replace(/\^\d{1,3}/g,"").replace(/(\w)\d{1,3}(\b)/g,"$1$2");
  return t;
}
function removeNotesSections(text){
  const re = /\n(?:NOTE|NOTE\s+DELL'EDITORE|NOTA\s+DEL\s+CURATORE)[\s\S]*?(?=\n[A-ZÀ-ÖØ-Ý0-9 ,;:'"-]{8,}\n|$)/g;
  return nl(text).replace(re,"\n");
}
function tidy(text){
  return nl(text).replace(/[\t\f\v]+/g," ").replace(/\s{3,}/g," ").replace(/\u2013|\u2014/g,"-")
    .replace(/\u201C|\u201D/g,'"').replace(/\u2018|\u2019/g,"'").replace(/\n{3,}/g,"\n\n");
}

export default function TextBook(){
  const [rawPages,setRawPages]=useState([]);
  const [body,setBody]=useState("");
  const [title,setTitle]=useState(""); const [author,setAuthor]=useState("");
  const [intro,setIntro]=useState(""); const [bibliography,setBibliography]=useState("");
  const [autoHF,setAutoHF]=useState(true); const [stripPub,setStripPub]=useState(true);
  const [stripMarks,setStripMarks]=useState(true); const [stripNotes,setStripNotes]=useState(true);
  const [trimKey,setTrimKey]=useState("6x9"); const [customW,setCustomW]=useState(6); const [customH,setCustomH]=useState(9);
  const [bleed,setBleed]=useState(false); const [marginIn,setMarginIn]=useState(0.75);
  const [fontSize,setFontSize]=useState(11); const [lineHeight,setLineHeight]=useState(1.4);
  const [useSerif,setUseSerif]=useState(true); const [pageNumbers,setPageNumbers]=useState(true);

  const trim = useMemo(()=>{ const t=TRIMS.find(t=>t.key===trimKey)||TRIMS[0]; return t.key==="custom"?{...t,w:customW,h:customH}:t; },[trimKey,customW,customH]);

  async function onOpenFile(e){
    const f=e.target.files?.[0]; if(!f) return;
    try{
      const name=(f.name||"").toLowerCase();
      if(name.endsWith(".pdf")){
        const buf=await f.arrayBuffer(); const pdf=await pdfjsLib.getDocument({data:buf}).promise;
        const pages=[]; for(let i=1;i<=pdf.numPages;i++){ const p=await pdf.getPage(i); const c=await p.getTextContent(); pages.push(c.items.map(it=>it.str).join(" ")); }
        setRawPages(pages); setBody(pages.join("\n\n"));
      }else if(name.endsWith(".epub")){
        const ab=await f.arrayBuffer(); const zip=await JSZip.loadAsync(ab);
        const htmlPaths=Object.keys(zip.files).filter(p=>/\.(xhtml|html|htm)$/i.test(p)).sort();
        const texts=[]; for(const p of htmlPaths){ const html=await zip.file(p).async("string"); texts.push(stripHtml(html)); }
        setRawPages(texts); setBody(texts.join("\n\n"));
      }else{ alert("Carica un PDF o un EPUB."); }
    }catch(err){ alert("Errore lettura file: "+(err?.message||"")); }
  }

  function runCleanup(){
    let pages=rawPages.slice(); if(autoHF) pages=autoRemoveHeadersFooters(pages);
    let t=pages.join("\n\n"); if(stripPub) t=removePublisherLines(t); if(stripMarks) t=removeFootnoteMarkers(t); if(stripNotes) t=removeNotesSections(t);
    t=tidy(t); setBody(t);
  }

  function flowText(doc,text,x,y,maxX,maxY,leading,withPageNumbers=false){
    const pageW=doc.internal.pageSize.getWidth(); const pageH=doc.internal.pageSize.getHeight();
    const maxWidth=maxX-x; const paragraphs=nl(text).split(/\n\n+/); let curY=y; let pageNum=doc.getNumberOfPages();
    for(const p of paragraphs){ const lines=doc.splitTextToSize(p,maxWidth);
      for(const ln of lines){ if(curY>maxY){ if(withPageNumbers){doc.setFontSize(9); doc.text(String(pageNum),pageW/2,pageH-0.4,{align:"center"}); doc.setFontSize(fontSize);} doc.addPage(); pageNum=doc.getNumberOfPages(); curY=y; }
        doc.text(ln,x,curY); curY+=leading; } curY+=leading*0.5; }
    if(withPageNumbers){ doc.setFontSize(9); doc.text(String(pageNum),pageW/2,pageH-0.4,{align:"center"}); doc.setFontSize(fontSize); }
  }

  function exportPdf(){
    const {w:pageW,h:pageH}=calcBleedSize(trim.w,trim.h,bleed);
    const doc=new jsPDF({unit:"in",format:[pageW,pageH],orientation:"portrait"});
    const m=marginIn; const font=useSerif?"Times":"Helvetica"; const leading=(fontSize/72)*lineHeight;

    if(title){ doc.setFont(font,"bold"); doc.setFontSize(fontSize+8); doc.text(title,pageW/2,pageH*0.35,{align:"center"});
      if(author){ doc.setFont(font,"normal"); doc.setFontSize(fontSize+2); doc.text(author,pageW/2,pageH*0.45,{align:"center"}); }
      doc.addPage();
    }
    if(intro.trim()){ doc.setFont(font,"bold"); doc.setFontSize(fontSize+3); doc.text("Introduzione",m,m);
      doc.setFont(font,"normal"); doc.setFontSize(fontSize); flowText(doc,intro,m,m+0.35,pageW-m,pageH-m,leading,true); doc.addPage(); }

    doc.setFont(font,"normal"); doc.setFontSize(fontSize); flowText(doc,body,m,m,pageW-m,pageH-m,leading,true);

    if(bibliography.trim()){ doc.addPage(); doc.setFont(font,"bold"); doc.setFontSize(fontSize+3); doc.text("Appendici e Bibliografia",m,m);
      doc.setFont(font,"normal"); doc.setFontSize(fontSize); flowText(doc,bibliography,m,m+0.35,pageW-m,pageH-m,leading,true); }

    const safe=(title||"Libro_di_testo").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 _-]/gi,"_").trim().replace(/\s+/g,"_");
    doc.save(`${safe}.pdf`);
  }

  return (
    <div className="p-4 space-y-4">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-xl font-bold">Libro di Testo – PDF/EPUB</h2>
          <p className="text-sm text-neutral-600">Importa, pulisci e re-impagina un'opera di pubblico dominio. Vai a <code>/#text</code> per aprire questa sezione.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input type="file" accept=".pdf,.epub" onChange={onOpenFile} className="hidden" id="textbook-file" />
          <label htmlFor="textbook-file" className="px-3 py-2 rounded-xl border shadow-sm cursor-pointer">Carica PDF/EPUB</label>
          <button className="px-3 py-2 rounded-xl border shadow-sm" onClick={runCleanup}>Pulisci</button>
          <button className="px-4 py-2 rounded-2xl shadow bg-black text-white" onClick={exportPdf}>Esporta PDF</button>
        </div>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Pulizia automatica</h3>
          <label className="block text-sm mb-1"><input type="checkbox" className="mr-2" checked={autoHF} onChange={e=>setAutoHF(e.target.checked)}/> Rimuovi header/footer ripetitivi</label>
          <label className="block text-sm mb-1"><input type="checkbox" className="mr-2" checked={stripPub} onChange={e=>setStripPub(e.target.checked)}/> Rimuovi righe dell'editore (©, ISBN, ecc.)</label>
          <label className="block text-sm mb-1"><input type="checkbox" className="mr-2" checked={stripMarks} onChange={e=>setStripMarks(e.target.checked)}/> Rimuovi marcatori di nota ([1], (1), ^1)</label>
          <label className="block text-sm"><input type="checkbox" className="mr-2" checked={stripNotes} onChange={e=>setStripNotes(e.target.checked)}/> Rimuovi blocchi “NOTE”/apparati</label>
        </div>

        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Impaginazione</h3>
          <label className="block text-sm mb-1">Trim size</label>
          <select value={trimKey} onChange={e=>setTrimKey(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2">
            {TRIMS.map(t=><option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {trimKey==="custom" && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div><label className="block text-xs mb-1">Larghezza (in)</label>
                <input type="number" step="0.01" value={customW} onChange={e=>setCustomW(parseFloat(e.target.value)||customW)} className="w-full border rounded-xl px-3 py-2" /></div>
              <div><label className="block text-xs mb-1">Altezza (in)</label>
                <input type="number" step="0.01" value={customH} onChange={e=>setCustomH(parseFloat(e.target.value)||customH)} className="w-full border rounded-xl px-3 py-2" /></div>
            </div>
          )}
          <label className="block text-sm mb-1"><input type="checkbox" className="mr-2" checked={bleed} onChange={e=>setBleed(e.target.checked)}/> Con bleed (+0.125\" W, +0.25\" H)</label>
          <label className="block text-sm mb-1">Margini (in)</label>
          <input type="number" step="0.05" min="0.25" value={marginIn} onChange={e=>setMarginIn(parseFloat(e.target.value)||marginIn)} className="w-full border rounded-xl px-3 py-2 mb-2" />
          <div className="grid grid-cols-3 gap-2">
            <div><label className="block text-xs mb-1">Serif</label><label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={useSerif} onChange={e=>setUseSerif(e.target.checked)}/> Serif</label></div>
            <div><label className="block text-xs mb-1">Dimensione (pt)</label><input type="number" min="9" step="1" value={fontSize} onChange={e=>setFontSize(parseInt(e.target.value)||fontSize)} className="w-full border rounded-xl px-3 py-2"/></div>
            <div><label className="block text-xs mb-1">Interlinea</label><input type="number" min="1" step="0.05" value={lineHeight} onChange={e=>setLineHeight(parseFloat(e.target.value)||lineHeight)} className="w-full border rounded-xl px-3 py-2"/></div>
          </div>
          <label className="block text-sm mt-2"><input type="checkbox" className="mr-2" checked={pageNumbers} onChange={e=>setPageNumbers(e.target.checked)}/> Numeri di pagina</label>
        </div>

        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Front/Back matter</h3>
          <label className="block text-sm mb-1">Titolo</label>
          <input value={title} onChange={e=>setTitle(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2"/>
          <label className="block text-sm mb-1">Autore/Editore</label>
          <input value={author} onChange={e=>setAuthor(e.target.value)} className="w-full border rounded-xl px-3 py-2 mb-2"/>
          <label className="block text-sm mb-1">Introduzione</label>
          <textarea value={intro} onChange={e=>setIntro(e.target.value)} className="w-full h-24 border rounded-xl px-3 py-2 mb-2"/>
          <label className="block text-sm mb-1">Appendici / Bibliografia</label>
          <textarea value={bibliography} onChange={e=>setBibliography(e.target.value)} className="w-full h-24 border rounded-xl px-3 py-2"/>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Anteprima testo (pulito)</h3>
          <textarea value={body} onChange={e=>setBody(e.target.value)} className="w-full h-[50vh] border rounded-xl px-3 py-2 whitespace-pre-wrap" />
        </div>
        <div className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Info origine</h3>
          <p className="text-sm text-neutral-600">Pagine lette: {rawPages.length || 0}</p>
          <ul className="text-xs text-neutral-500 list-disc ml-5 mt-2 space-y-1">
            <li>Se il PDF è solo uno scan immagine, qui non c’è OCR (possiamo aggiungerlo in seguito).</li>
            <li>Rimuovi eventuali apparati/introduzioni recenti non in pubblico dominio.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
