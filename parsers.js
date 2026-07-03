// Détection de format + extraction de couverture pour chaque type de fichier.

const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

function extOf(filename) {
  return filename.split(".").pop().toLowerCase();
}

function detectFormat(filename) {
  const ext = extOf(filename);
  if (ext === "pdf") return "pdf";
  if (ext === "cbz" || ext === "zip") return "cbz";
  if (ext === "cbr" || ext === "rar") return "cbr";
  if (ext === "epub") return "epub";
  if (IMAGE_EXT.includes(ext)) return "image";
  return "unknown";
}

async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------- Détection automatique série + tome/chapitre depuis le nom de fichier ----------
// Ex: "One Piece Tome 12.cbz" -> { series: "One Piece", volume: 12 }
// Ex: "Naruto - Chapitre 004.cbz" -> { series: "Naruto", volume: 4 }
// Ex: "Berserk #34.cbz" -> { series: "Berserk", volume: 34 }
// Ex: "Solo Leveling 07.pdf" -> { series: "Solo Leveling", volume: 7 }
function parseSeriesAndVolume(filename) {
  const base = filename.replace(/\.[^/.]+$/, "").trim();

  const patterns = [
    /^(.*?)[\s_\-–]+(?:tome|vol(?:ume)?\.?|t)[\s_\-.]*0*(\d{1,4})\b/i,
    /^(.*?)[\s_\-–]+(?:chapitre|chapter|ch\.?|episode|épisode|ep\.?)[\s_\-.]*0*(\d{1,4})\b/i,
    /^(.*?)[\s_\-–]*#0*(\d{1,4})\b/,
    /^(.*?)[\s_\-–]+0*(\d{1,4})$/, // numéro final tout seul
  ];

  for (const re of patterns) {
    const m = base.match(re);
    if (m) {
      let series = m[1].trim().replace(/[\s_\-–]+$/, "");
      series = series.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
      const volume = parseInt(m[2], 10);
      if (series.length > 0 && !isNaN(volume)) {
        return { series, volume };
      }
    }
  }
  // pas de numéro détecté : toute la chaîne est la série, pas de tome
  return { series: base.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim(), volume: null };
}

// ---------- PDF ----------
async function parsePDF(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 0.6 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  const coverBlob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  return {
    format: "pdf",
    coverBlob,
    pageCount: pdf.numPages,
    fileBlob: file,
  };
}

// ---------- CBZ (zip d'images) ----------
async function parseCBZ(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && IMAGE_EXT.includes(extOf(f.name)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (entries.length === 0) throw new Error("Aucune image trouvée dans le CBZ");
  const coverBlob = await entries[0].async("blob");
  return {
    format: "cbz",
    coverBlob,
    pageCount: entries.length,
    fileBlob: file,
  };
}

// ---------- EPUB ----------
async function parseEPUB(file) {
  const buf = await file.arrayBuffer();
  let coverBlob = null;
  try {
    const zip = await JSZip.loadAsync(buf.slice(0));
    // cherche le fichier OPF
    const containerXml = await zip.file("META-INF/container.xml").async("text");
    const opfPathMatch = containerXml.match(/full-path="([^"]+)"/);
    if (opfPathMatch) {
      const opfPath = opfPathMatch[1];
      const opfText = await zip.file(opfPath).async("text");
      const basePath = opfPath.split("/").slice(0, -1).join("/");
      // cherche meta cover puis l'item correspondant
      let coverHref = null;
      const metaMatch = opfText.match(/<meta[^>]*name="cover"[^>]*content="([^"]+)"/);
      if (metaMatch) {
        const coverId = metaMatch[1];
        const itemRegex = new RegExp(`<item[^>]*id="${coverId}"[^>]*href="([^"]+)"`);
        const itemMatch = opfText.match(itemRegex);
        if (itemMatch) coverHref = itemMatch[1];
      }
      if (!coverHref) {
        const imgItemMatch = opfText.match(/<item[^>]*href="([^"]+)"[^>]*media-type="image\/[^"]+"/);
        if (imgItemMatch) coverHref = imgItemMatch[1];
      }
      if (coverHref) {
        const fullPath = basePath ? `${basePath}/${coverHref}` : coverHref;
        const imgFile = zip.file(fullPath) || zip.file(decodeURIComponent(fullPath));
        if (imgFile) coverBlob = await imgFile.async("blob");
      }
    }
  } catch (e) {
    console.warn("Impossible d'extraire la couverture EPUB, utilisation d'une couverture par défaut", e);
  }
  return {
    format: "epub",
    coverBlob,
    pageCount: null,
    fileBlob: file,
  };
}

// ---------- Images (groupées comme un seul livre) ----------
async function parseImageSet(files) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return {
    format: "images",
    coverBlob: sorted[0],
    pageCount: sorted.length,
    fileBlob: null,
    pageBlobs: sorted,
  };
}

async function parseFile(file) {
  const format = detectFormat(file.name);
  switch (format) {
    case "pdf":
      return parsePDF(file);
    case "cbz":
      return parseCBZ(file);
    case "epub":
      return parseEPUB(file);
    case "cbr":
      throw new Error(
        `"${file.name}" est un CBR (RAR), non supporté par le navigateur. Convertis-le en CBZ (avec 7-Zip par ex.) puis réessaie.`
      );
    case "image":
      return null; // géré séparément en groupe
    default:
      throw new Error(`Format non reconnu pour "${file.name}"`);
  }
}
