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
  currentReader: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function uid() {
  return "b_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", async () => {
  buildShelfFilters();
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
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  const images = files.filter((f) => IMAGE_EXT.includes(extOf(f.name)));
  const others = files.filter((f) => !IMAGE_EXT.includes(extOf(f.name)));

  $("#addBtn").disabled = true;
  $("#addBtn").textContent = "Import en cours…";

  try {
    // les images sélectionnées ensemble = un seul livre (planches)
    if (images.length) {
      await importOne(images.length === 1 ? images : images, true);
    }
    for (const file of others) {
      await importOne(file, false);
    }
    await refreshLibrary();
    updateStorageBar();
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
  if (isImageGroup) {
    parsed = await parseImageSet(fileOrFiles);
    titleGuess = "Planches importées";
  } else {
    parsed = await parseFile(fileOrFiles);
    titleGuess = fileOrFiles.name.replace(/\.[^/.]+$/, "");
  }
  if (!parsed) return;

  const id = uid();
  const book = {
    id,
    title: titleGuess,
    author: "",
    shelf: "Manga",
    tags: [],
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

function renderLibrary() {
  const grid = $("#library");
  let list = state.books;
  if (state.filter !== "Tous") list = list.filter((b) => b.shelf === state.filter);
  if (state.search)
    list = list.filter(
      (b) =>
        b.title.toLowerCase().includes(state.search) ||
        (b.author || "").toLowerCase().includes(state.search) ||
        (b.tags || []).some((t) => t.toLowerCase().includes(state.search))
    );

  $("#emptyState").style.display = list.length ? "none" : "flex";
  $("#count").textContent = `${list.length} ouvrage${list.length > 1 ? "s" : ""}`;

  grid.querySelectorAll(".book-card").forEach((n) => n.remove());

  const frag = document.createDocumentFragment();
  for (const book of list) {
    const card = document.createElement("div");
    card.className = "book-card";
    const coverURL = book.coverBlob ? URL.createObjectURL(book.coverBlob) : null;
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
      <div class="book-meta">${escapeHTML(book.shelf)}${book.pageCount ? " · " + book.pageCount + " p." : ""}</div>
    `;
    card.querySelector(".cover-wrap img, .cover-fallback")?.addEventListener("click", () => openReader(book));
    card.querySelector(".edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openEdit(book);
    });
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------- Édition ----------
function openEdit(book) {
  state.editingId = book.id;
  $("#editTitle").value = book.title;
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
  book.author = $("#editAuthor").value.trim();
  book.shelf = $("#editShelf").value;
  book.tags = $("#editTags")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  await DB.updateBook(book);
  closeEdit();
  await refreshLibrary();
}
async function deleteFromEdit() {
  if (!confirm("Supprimer définitivement ce livre de la bibliothèque locale ?")) return;
  await DB.deleteBook(state.editingId);
  closeEdit();
  await refreshLibrary();
  updateStorageBar();
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
