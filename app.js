// ---------- Config libs externes ----------
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const SHELVES = ["Manga", "Doujinshi", "Livre", "BD", "Autre"];

let state = {
  books: [],
  filter: "Tous",
  search: "",
  sort: "serie", // "serie" | "alpha" | "recent"
  currentReader: null,
  currentSeriesName: null, // série actuellement ouverte dans la modale "pile"
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function uid() {
  return "b_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", async () => {
  buildShelfFilters();
  buildSortControls();
  bindUI();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  }
  await refreshLibrary();
  updateStorageBar();
});

function buildShelfFilters() {
  const wrap = $("#shelfFilters");
  const chips = ["Tous", ...SHELVES];
  wrap.innerHTML = chips
    .map((s) => `<button class="chip" data-shelf="${s}">${s}</button>`)
    .join("");
  wrap.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.shelf;
      wrap.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderLibrary();
    });
  });
  wrap.querySelector('[data-shelf="Tous"]').classList.add("active");
}

function buildSortControls() {
  const wrap = $("#sortControls");
  const options = [
    { key: "serie", label: "Piles par série" },
    { key: "author", label: "Par auteur" },
    { key: "alpha", label: "Alphabétique" },
    { key: "recent", label: "Date d'ajout" },
  ];
  wrap.innerHTML = options
    .map((o) => `<button class="chip" data-sort="${o.key}">${o.label}</button>`)
    .join("");
  wrap.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sort = btn.dataset.sort;
      wrap.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderLibrary();
    });
  });
  wrap.querySelector(`[data-sort="${state.sort}"]`).classList.add("active");
}

function bindUI() {
  $("#addBtn").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (e) => handleFiles(e.target.files));

  $("#searchInput").addEventListener("input", (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderLibrary();
  });

  $("#closeReader").addEventListener("click", closeReader);
  $("#closeEdit").addEventListener("click", closeEdit);
  $("#editForm").addEventListener("submit", saveEdit);
  $("#deleteBookBtn").addEventListener("click", deleteFromEdit);
  $("#closeSeries").addEventListener("click", closeSeriesView);

  // drag & drop sur toute la zone bibliothèque
  const drop = $("#library");
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("dragover");
    })
  );
  drop.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
}

// ---------- Ajout de fichiers ----------
function normalizedName(name) {
  return name.trim().toLowerCase();
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  const images = files.filter((f) => IMAGE_EXT.includes(extOf(f.name)));
  const others = files.filter((f) => !IMAGE_EXT.includes(extOf(f.name)));

  $("#addBtn").disabled = true;

  // ensemble des noms de fichiers déjà présents dans la bibliothèque, pour éviter les doublons
  const existing = await DB.getAllBooks();
  const knownNames = new Set(
    existing.filter((b) => b.originalFilename).map((b) => normalizedName(b.originalFilename))
  );

  const skipped = [];
  let imported = 0;
  const totalToImport = (images.length ? 1 : 0) + others.length;
  let done = 0;

  const updateProgress = () => {
    $("#addBtn").textContent = `Import ${done}/${totalToImport}…`;
  };
  updateProgress();

  try {
    // les images sélectionnées ensemble = un seul livre (planches), pas de check doublon dessus
    if (images.length) {
      await importOne(images, true, knownNames);
      imported++;
      done++;
      updateProgress();
    }
    for (const file of others) {
      const key = normalizedName(file.name);
      if (knownNames.has(key)) {
        skipped.push(file.name);
        done++;
        updateProgress();
        continue;
      }
      const added = await importOne(file, false, knownNames);
      if (added) {
        imported++;
        knownNames.add(key);
      }
      done++;
      updateProgress();
    }
    await refreshLibrary();
    updateStorageBar();

    if (skipped.length) {
      alert(
        `${skipped.length} fichier${skipped.length > 1 ? "s" : ""} déjà présent${
          skipped.length > 1 ? "s" : ""
        } dans la bibliothèque, ignoré${skipped.length > 1 ? "s" : ""} :\n\n` + skipped.join("\n")
      );
    }
  } catch (err) {
    alert(err.message || "Erreur pendant l'import");
    console.error(err);
  } finally {
    $("#addBtn").disabled = false;
    $("#addBtn").textContent = "+ Ajouter";
    $("#fileInput").value = "";
  }
}

async function importOne(fileOrFiles, isImageGroup) {
  let parsed;
  let titleGuess;
  let seriesGuess = "";
  let volumeGuess = null;
  let originalFilename = null;
  if (isImageGroup) {
    parsed = await parseImageSet(fileOrFiles);
    titleGuess = "Planches importées";
    seriesGuess = titleGuess;
  } else {
    parsed = await parseFile(fileOrFiles);
    titleGuess = fileOrFiles.name.replace(/\.[^/.]+$/, "");
    const guess = parseSeriesAndVolume(fileOrFiles.name);
    seriesGuess = guess.series || titleGuess;
    volumeGuess = guess.volume;
    originalFilename = fileOrFiles.name;
  }
  if (!parsed) return null;

  const id = uid();
  const book = {
    id,
    title: titleGuess,
    author: "",
    shelf: "Manga",
    tags: [],
    series: seriesGuess,
    volume: volumeGuess,
    originalFilename,
    format: parsed.format,
    pageCount: parsed.pageCount,
    addedAt: Date.now(),
    favorite: false,
    coverBlob: parsed.coverBlob || null,
    fileBlob: parsed.fileBlob || null,
    pageBlobs: parsed.pageBlobs || null,
  };
  await DB.addBook(book);
  return book;
}

// ---------- Rendu bibliothèque ----------
async function refreshLibrary() {
  state.books = await DB.getAllBooks();
  state.books.sort((a, b) => b.addedAt - a.addedAt);
  renderLibrary();
}

function sortBooks(list) {
  const copy = [...list];
  if (state.sort === "alpha") {
    copy.sort((a, b) => a.title.localeCompare(b.title, "fr", { sensitivity: "base" }));
  } else if (state.sort === "recent") {
    copy.sort((a, b) => b.addedAt - a.addedAt);
  } else if (state.sort === "author") {
    copy.sort((a, b) => {
      const aa = (a.author || "Auteur inconnu").toLowerCase();
      const ab = (b.author || "Auteur inconnu").toLowerCase();
      if (aa !== ab) return aa.localeCompare(ab, "fr", { sensitivity: "base" });
      const sa = (a.series || a.title).toLowerCase();
      const sb = (b.series || b.title).toLowerCase();
      if (sa !== sb) return sa.localeCompare(sb, "fr", { sensitivity: "base" });
      const va = a.volume ?? Infinity;
      const vb = b.volume ?? Infinity;
      return va - vb;
    });
  } else {
    // "serie" : par série (alpha), puis par tome (numérique), puis par titre
    copy.sort((a, b) => {
      const sa = (a.series || a.title).toLowerCase();
      const sb = (b.series || b.title).toLowerCase();
      if (sa !== sb) return sa.localeCompare(sb, "fr", { sensitivity: "base" });
      const va = a.volume ?? Infinity;
      const vb = b.volume ?? Infinity;
      if (va !== vb) return va - vb;
      return a.title.localeCompare(b.title, "fr", { sensitivity: "base" });
    });
  }
  return copy;
}

function groupBySeries(list) {
  const groups = new Map();
  for (const book of list) {
    const key = book.series || book.title;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(book);
  }
  return groups;
}

function getFilteredSortedList() {
  let list = state.books;
  if (state.filter !== "Tous") list = list.filter((b) => b.shelf === state.filter);
  if (state.search)
    list = list.filter(
      (b) =>
        b.title.toLowerCase().includes(state.search) ||
        (b.author || "").toLowerCase().includes(state.search) ||
        (b.series || "").toLowerCase().includes(state.search) ||
        (b.tags || []).some((t) => t.toLowerCase().includes(state.search))
    );
  return sortBooks(list);
}

function renderLibrary() {
  const grid = $("#library");
  const list = getFilteredSortedList();

  $("#emptyState").style.display = list.length ? "none" : "flex";

  grid.querySelectorAll(".book-card, .group-header").forEach((n) => n.remove());
  const frag = document.createDocumentFragment();

  if (state.sort === "serie") {
    const groups = groupBySeries(list);
    $("#count").textContent = `${groups.size} série${groups.size > 1 ? "s" : ""} · ${list.length} ouvrage${
      list.length > 1 ? "s" : ""
    }`;
    for (const [seriesName, books] of groups) {
      if (books.length > 1) {
        frag.appendChild(createStackCardElement(seriesName, books));
      } else {
        frag.appendChild(createBookCardElement(books[0]));
      }
    }
  } else if (state.sort === "author") {
    $("#count").textContent = `${list.length} ouvrage${list.length > 1 ? "s" : ""}`;
    let lastAuthor = null;
    for (const book of list) {
      const authorLabel = book.author || "Auteur inconnu";
      if (authorLabel !== lastAuthor) {
        const header = document.createElement("div");
        header.className = "group-header";
        header.textContent = authorLabel;
        frag.appendChild(header);
        lastAuthor = authorLabel;
      }
      frag.appendChild(createBookCardElement(book));
    }
  } else {
    $("#count").textContent = `${list.length} ouvrage${list.length > 1 ? "s" : ""}`;
    for (const book of list) {
      frag.appendChild(createBookCardElement(book));
    }
  }
  grid.appendChild(frag);
}

function createBookCardElement(book) {
  const card = document.createElement("div");
  card.className = "book-card";
  const coverURL = book.coverBlob ? URL.createObjectURL(book.coverBlob) : null;
  const metaBits = [];
  if (book.volume != null) metaBits.push("T" + book.volume);
  metaBits.push(book.shelf);
  if (book.pageCount) metaBits.push(book.pageCount + " p.");
  card.innerHTML = `
    <div class="cover-wrap">
      ${
        coverURL
          ? `<img src="${coverURL}" alt="${escapeHTML(book.title)}" loading="lazy">`
          : `<div class="cover-fallback">${escapeHTML(book.title.slice(0, 2).toUpperCase())}</div>`
      }
      <span class="format-badge">${book.format}</span>
      <button class="edit-btn" title="Modifier" data-id="${book.id}">✎</button>
    </div>
    <div class="book-title">${escapeHTML(book.title)}</div>
    <div class="book-meta">${escapeHTML(metaBits.join(" · "))}</div>
  `;
  card.querySelector(".cover-wrap img, .cover-fallback")?.addEventListener("click", () => openReader(book));
  card.querySelector(".edit-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openEdit(book);
  });
  return card;
}

function createStackCardElement(seriesName, books) {
  // représentant de la pile : le tome le plus bas (ou le premier alphabétiquement)
  const sorted = [...books].sort((a, b) => (a.volume ?? Infinity) - (b.volume ?? Infinity));
  const rep = sorted[0];
  const card = document.createElement("div");
  card.className = "book-card stack-card";
  const coverURL = rep.coverBlob ? URL.createObjectURL(rep.coverBlob) : null;
  card.innerHTML = `
    <div class="cover-wrap">
      ${
        coverURL
          ? `<img src="${coverURL}" alt="${escapeHTML(seriesName)}" loading="lazy">`
          : `<div class="cover-fallback">${escapeHTML(seriesName.slice(0, 2).toUpperCase())}</div>`
      }
      <span class="stack-badge">×${books.length}</span>
    </div>
    <div class="book-title">${escapeHTML(seriesName)}</div>
    <div class="book-meta">${books.length} tome${books.length > 1 ? "s" : ""}</div>
  `;
  card.addEventListener("click", () => openSeriesView(seriesName, books));
  return card;
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------- Vue "pile" d'une série ----------
function openSeriesView(seriesName, books) {
  state.currentSeriesName = seriesName;
  renderSeriesView();
  $("#seriesModal").classList.add("open");
}

function renderSeriesView() {
  const seriesName = state.currentSeriesName;
  if (!seriesName) return;
  const books = state.books
    .filter((b) => (b.series || b.title) === seriesName)
    .sort((a, b) => (a.volume ?? Infinity) - (b.volume ?? Infinity) || a.title.localeCompare(b.title, "fr"));

  $("#seriesTitle").textContent = seriesName;
  $("#seriesCount").textContent = `${books.length} tome${books.length > 1 ? "s" : ""}`;
  const grid = $("#seriesGrid");
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const book of books) {
    frag.appendChild(createBookCardElement(book));
  }
  grid.appendChild(frag);
}

function closeSeriesView() {
  $("#seriesModal").classList.remove("open");
  state.currentSeriesName = null;
}

// ---------- Édition ----------
function openEdit(book) {
  state.editingId = book.id;
  $("#editTitle").value = book.title;
  $("#editSeries").value = book.series || "";
  $("#editVolume").value = book.volume ?? "";
  $("#editAuthor").value = book.author || "";
  $("#editShelf").innerHTML = SHELVES.map(
    (s) => `<option value="${s}" ${s === book.shelf ? "selected" : ""}>${s}</option>`
  ).join("");
  $("#editTags").value = (book.tags || []).join(", ");
  $("#editModal").classList.add("open");
}
function closeEdit() {
  $("#editModal").classList.remove("open");
  state.editingId = null;
}
async function saveEdit(e) {
  e.preventDefault();
  const book = await DB.getBook(state.editingId);
  book.title = $("#editTitle").value.trim() || book.title;
  book.series = $("#editSeries").value.trim() || book.title;
  const volRaw = $("#editVolume").value.trim();
  book.volume = volRaw === "" ? null : parseInt(volRaw, 10);
  book.author = $("#editAuthor").value.trim();
  book.shelf = $("#editShelf").value;
  book.tags = $("#editTags")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  await DB.updateBook(book);
  closeEdit();
  await refreshLibrary();
  if (state.currentSeriesName) renderSeriesView();
}
async function deleteFromEdit() {
  if (!confirm("Supprimer définitivement ce livre de la bibliothèque locale ?")) return;
  await DB.deleteBook(state.editingId);
  closeEdit();
  await refreshLibrary();
  updateStorageBar();
  if (state.currentSeriesName) renderSeriesView();
}

// ---------- Lecteur ----------
async function openReader(book) {
  state.currentReader = { book, page: 0 };
  $("#readerModal").classList.add("open");
  $("#readerTitle").textContent = book.title;
  const viewer = $("#readerViewer");
  viewer.innerHTML = `<p class="reader-loading">Chargement…</p>`;

  if (book.format === "epub") {
    viewer.innerHTML = `<div id="epubArea" style="width:100%;height:100%;"></div>`;
    const rendition = ePub(book.fileBlob).renderTo("epubArea", { width: "100%", height: "100%" });
    rendition.display();
    $("#readerNav").innerHTML = `
      <button id="prevPage">‹ Précédent</button>
      <span></span>
      <button id="nextPage">Suivant ›</button>`;
    $("#prevPage").addEventListener("click", () => rendition.prev());
    $("#nextPage").addEventListener("click", () => rendition.next());
    return;
  }

  if (book.format === "pdf") {
    const buf = await book.fileBlob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    state.currentReader.pdf = pdf;
    state.currentReader.total = pdf.numPages;
    await renderPDFPage(0);
    setupPageNav();
    return;
  }

  if (book.format === "cbz") {
    const zip = await JSZip.loadAsync(book.fileBlob);
    const entries = Object.values(zip.files)
      .filter((f) => !f.dir && IMAGE_EXT.includes(extOf(f.name)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const urls = [];
    for (const entry of entries) {
      const blob = await entry.async("blob");
      urls.push(URL.createObjectURL(blob));
    }
    state.currentReader.pages = urls;
    state.currentReader.total = urls.length;
    renderImagePage(0);
    setupPageNav();
    return;
  }

  if (book.format === "images") {
    const urls = book.pageBlobs.map((b) => URL.createObjectURL(b));
    state.currentReader.pages = urls;
    state.currentReader.total = urls.length;
    renderImagePage(0);
    setupPageNav();
    return;
  }
}

async function renderPDFPage(i) {
  const { pdf } = state.currentReader;
  state.currentReader.page = i;
  const page = await pdf.getPage(i + 1);
  const viewport = page.getViewport({ scale: Math.min(2, (window.innerWidth * 0.9) / page.getViewport({ scale: 1 }).width) });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  $("#readerViewer").innerHTML = "";
  $("#readerViewer").appendChild(canvas);
  updatePageLabel();
}

function renderImagePage(i) {
  state.currentReader.page = i;
  const url = state.currentReader.pages[i];
  $("#readerViewer").innerHTML = `<img src="${url}" class="page-img" alt="page ${i + 1}">`;
  updatePageLabel();
}

function updatePageLabel() {
  const { page, total } = state.currentReader;
  const label = document.querySelector("#pageLabel");
  if (label) label.textContent = `${page + 1} / ${total}`;
}

function setupPageNav() {
  $("#readerNav").innerHTML = `
    <button id="prevPage">‹</button>
    <span id="pageLabel"></span>
    <button id="nextPage">›</button>`;
  updatePageLabel();
  $("#prevPage").addEventListener("click", () => goPage(-1));
  $("#nextPage").addEventListener("click", () => goPage(1));
}

function goPage(delta) {
  const r = state.currentReader;
  const next = r.page + delta;
  if (next < 0 || next >= r.total) return;
  if (r.book.format === "pdf") renderPDFPage(next);
  else renderImagePage(next);
}

function closeReader() {
  $("#readerModal").classList.remove("open");
  $("#readerViewer").innerHTML = "";
  state.currentReader = null;
}

// ---------- Stockage ----------
async function updateStorageBar() {
  const est = await DB.estimateUsage();
  const el = $("#storageInfo");
  if (!est || !el) return;
  const usedMB = (est.usage / (1024 * 1024)).toFixed(0);
  const quotaMB = (est.quota / (1024 * 1024)).toFixed(0);
  const pct = est.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;
  el.innerHTML = `<div class="storage-bar"><div class="storage-fill" style="width:${pct}%"></div></div>
    <span>${usedMB} Mo utilisés sur ${quotaMB} Mo (espace navigateur)</span>`;
}
