// ---------- Config libs externes ----------
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const SHELVES = ["Manga", "Doujinshi", "Livre", "BD", "Autre"];
const SHELF_ICONS = { Manga: "📖", Doujinshi: "🌙", Livre: "📚", BD: "💥", Autre: "🗂️" };
const FAVORITES_KEY = "__favoris__";
const PRIVATE_KEY = "__prive__";
const PRIVATE_HASH_STORAGE_KEY = "biblio_private_hash";

const FILTERS = [
  { key: "Tous", label: "Tous" },
  ...SHELVES.map((s) => ({ key: s, label: s })),
  { key: FAVORITES_KEY, label: "★ Favoris" },
  { key: PRIVATE_KEY, label: "🔒 Privé" },
];

let state = {
  books: [],
  filter: "Tous",
  search: "",
  sort: "serie", // "serie" | "author" | "alpha" | "recent"
  currentReader: null,
  currentSeriesName: null,
  privateUnlocked: false,
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
  setupSwipeNav();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  }
  await refreshLibrary();
  updateStorageBar();
});

function buildShelfFilters() {
  const wrap = $("#shelfFilters");
  wrap.innerHTML = FILTERS.map((f) => `<button class="chip" data-key="${f.key}">${f.label}</button>`).join("");
  wrap.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      if (key === PRIVATE_KEY) {
        const ok = await ensurePrivateUnlocked();
        if (!ok) return;
      }
      state.filter = key;
      wrap.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderLibrary();
    });
  });
  wrap.querySelector('[data-key="Tous"]').classList.add("active");
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

// ---------- Section privée (verrou par mot de passe, côté interface) ----------
async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function openPasswordModal(mode) {
  return new Promise((resolve) => {
    const modal = $("#passwordModal");
    const form = $("#passwordForm");
    const title = $("#passwordTitle");
    const desc = $("#passwordDesc");
    const pw1 = $("#pw1");
    const pw2Wrap = $("#pw2Wrap");
    const pw2 = $("#pw2");
    const errorEl = $("#passwordError");

    errorEl.textContent = "";
    pw1.value = "";
    pw2.value = "";

    if (mode === "create") {
      title.textContent = "Créer un mot de passe";
      desc.textContent =
        "Cette section sera masquée du reste de la bibliothèque. Retiens bien ce mot de passe : il n'y a aucun moyen de le récupérer si tu l'oublies (rien n'est envoyé nulle part, tout reste sur cet appareil).";
      pw2Wrap.style.display = "block";
    } else {
      title.textContent = "Section privée";
      desc.textContent = "Entre ton mot de passe pour y accéder.";
      pw2Wrap.style.display = "none";
    }

    modal.classList.add("open");
    pw1.focus();

    function cleanup() {
      form.removeEventListener("submit", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      modal.classList.remove("open");
    }
    async function onSubmit(e) {
      e.preventDefault();
      if (mode === "create") {
        if (pw1.value.length < 4) {
          errorEl.textContent = "4 caractères minimum.";
          return;
        }
        if (pw1.value !== pw2.value) {
          errorEl.textContent = "Les deux mots de passe ne correspondent pas.";
          return;
        }
        const hash = await sha256Hex(pw1.value);
        localStorage.setItem(PRIVATE_HASH_STORAGE_KEY, hash);
        cleanup();
        resolve(true);
      } else {
        const hash = await sha256Hex(pw1.value);
        const stored = localStorage.getItem(PRIVATE_HASH_STORAGE_KEY);
        if (hash === stored) {
          cleanup();
          resolve(true);
        } else {
          errorEl.textContent = "Mot de passe incorrect.";
          pw1.value = "";
          pw1.focus();
        }
      }
    }
    function onCancel() {
      cleanup();
      resolve(false);
    }
    const cancelBtn = $("#passwordCancel");
    form.addEventListener("submit", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
  });
}

async function ensurePrivateUnlocked() {
  if (state.privateUnlocked) return true;
  const hasPassword = !!localStorage.getItem(PRIVATE_HASH_STORAGE_KEY);
  const ok = await openPasswordModal(hasPassword ? "unlock" : "create");
  if (ok) state.privateUnlocked = true;
  return ok;
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

  const existing = await DB.getAllBooks();
  const knownNames = new Set(
    existing.filter((b) => b.originalFilename).map((b) => normalizedName(b.originalFilename))
  );

  const skipped = [];
  let importedCount = 0;
  const totalToImport = (images.length ? 1 : 0) + others.length;
  let done = 0;

  const updateProgress = () => {
    $("#addBtn").textContent = `Import ${done}/${totalToImport}…`;
  };
  updateProgress();

  try {
    if (images.length) {
      await importSingle(images, true, knownNames, skipped);
      importedCount++;
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
      const added = await importSingle(file, false, knownNames, skipped);
      importedCount += added;
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

// Importe un fichier sélectionné (ou un groupe d'images). Peut ajouter plusieurs
// livres d'un coup si c'est une archive contenant plusieurs PDF (plusieurs épisodes).
// Retourne le nombre de livres effectivement ajoutés.
async function importSingle(fileOrFiles, isImageGroup, knownNames, skipped) {
  if (isImageGroup) {
    const parsed = await parseImageSet(fileOrFiles);
    await createAndStoreBook({
      titleGuess: "Planches importées",
      seriesGuess: "Planches importées",
      volumeGuess: null,
      originalFilename: null,
      parsed,
    });
    return 1;
  }

  const parsed = await parseFile(fileOrFiles);

  if (parsed.format === "bundle-pdf") {
    let added = 0;
    for (const entry of parsed.entries) {
      const innerName = entry.name.split("/").pop();
      const key = normalizedName(innerName);
      if (knownNames.has(key)) {
        skipped.push(innerName);
        continue;
      }
      const blob = await entry.async("blob");
      const innerParsed = await parsePDFFromBlob(blob);
      const guess = parseSeriesAndVolume(innerName);
      await createAndStoreBook({
        titleGuess: innerName.replace(/\.[^/.]+$/, ""),
        seriesGuess: guess.series || innerName,
        volumeGuess: guess.volume,
        originalFilename: innerName,
        parsed: innerParsed,
      });
      knownNames.add(key);
      added++;
    }
    return added;
  }

  const titleGuess = fileOrFiles.name.replace(/\.[^/.]+$/, "");
  const guess = parseSeriesAndVolume(fileOrFiles.name);
  await createAndStoreBook({
    titleGuess,
    seriesGuess: guess.series || titleGuess,
    volumeGuess: guess.volume,
    originalFilename: fileOrFiles.name,
    parsed,
  });
  return 1;
}

async function createAndStoreBook({ titleGuess, seriesGuess, volumeGuess, originalFilename, parsed }) {
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
    private: false,
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
  let list = state.books.filter((b) => !b.private || (state.filter === PRIVATE_KEY && state.privateUnlocked));

  if (state.filter === FAVORITES_KEY) {
    list = list.filter((b) => b.favorite);
  } else if (state.filter === PRIVATE_KEY) {
    list = list.filter((b) => b.private);
  } else if (state.filter !== "Tous") {
    list = list.filter((b) => b.shelf === state.filter);
  }

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

// Ajoute au fragment le rendu (piles / auteur / plat) d'une liste déjà triée,
// selon le mode de tri actif. Réutilisé à la fois pour une catégorie unique
// et pour chaque section de catégorie dans la vue "Tous".
function renderBooksInto(frag, list) {
  if (state.sort === "serie") {
    const groups = groupBySeries(list);
    for (const [seriesName, books] of groups) {
      if (books.length > 1) frag.appendChild(createStackCardElement(seriesName, books));
      else frag.appendChild(createBookCardElement(books[0]));
    }
  } else if (state.sort === "author") {
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
    for (const book of list) frag.appendChild(createBookCardElement(book));
  }
}

function renderLibrary() {
  const grid = $("#library");
  const list = getFilteredSortedList();

  $("#emptyState").style.display = list.length ? "none" : "flex";
  $("#count").textContent = `${list.length} ouvrage${list.length > 1 ? "s" : ""}`;

  grid.querySelectorAll(".book-card, .group-header, .category-header").forEach((n) => n.remove());
  const frag = document.createDocumentFragment();

  if (state.filter === "Tous") {
    // vue "Tous" : une section bien distincte par catégorie, pour une lecture plus claire
    for (const shelf of SHELVES) {
      const shelfBooks = list.filter((b) => b.shelf === shelf);
      if (!shelfBooks.length) continue;
      const header = document.createElement("div");
      header.className = "category-header";
      header.innerHTML = `<span>${SHELF_ICONS[shelf] || "📁"} ${escapeHTML(shelf)}</span><span class="category-count">${shelfBooks.length}</span>`;
      frag.appendChild(header);
      renderBooksInto(frag, shelfBooks);
    }
    // livres dont l'étagère ne correspond à aucune catégorie connue (sécurité)
    const others = list.filter((b) => !SHELVES.includes(b.shelf));
    if (others.length) {
      const header = document.createElement("div");
      header.className = "category-header";
      header.innerHTML = `<span>🗂️ Autre</span><span class="category-count">${others.length}</span>`;
      frag.appendChild(header);
      renderBooksInto(frag, others);
    }
  } else {
    renderBooksInto(frag, list);
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
      <button class="fav-btn ${book.favorite ? "active" : ""}" title="Favori">${book.favorite ? "♥" : "♡"}</button>
    </div>
    <div class="book-title">${escapeHTML(book.title)}</div>
    <div class="book-meta">${escapeHTML(metaBits.join(" · "))}</div>
  `;
  card.querySelector(".cover-wrap img, .cover-fallback")?.addEventListener("click", () => openReader(book));
  card.querySelector(".edit-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openEdit(book);
  });
  card.querySelector(".fav-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    book.favorite = !book.favorite;
    await DB.updateBook(book);
    const btn = e.currentTarget;
    btn.textContent = book.favorite ? "♥" : "♡";
    btn.classList.toggle("active", book.favorite);
    if (state.filter === FAVORITES_KEY) renderLibrary();
  });
  return card;
}

function createStackCardElement(seriesName, books) {
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
    .filter((b) => (!b.private || state.filter === PRIVATE_KEY) && (b.series || b.title) === seriesName)
    .sort((a, b) => (a.volume ?? Infinity) - (b.volume ?? Infinity) || a.title.localeCompare(b.title, "fr"));

  $("#seriesTitle").textContent = seriesName;
  $("#seriesCount").textContent = `${books.length} tome${books.length > 1 ? "s" : ""}`;
  const grid = $("#seriesGrid");
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const book of books) frag.appendChild(createBookCardElement(book));
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
  $("#editPrivate").checked = !!book.private;
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
  book.private = $("#editPrivate").checked;
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
  state.currentReader = { book, page: 0, zoomScale: 1, mode: "page" };
  $("#readerModal").classList.add("open");
  $("#readerTitle").textContent = book.title;
  $("#readerViewer").classList.remove("scroll-mode");
  const modeBtn = $("#readerModeBtn");
  modeBtn.style.display = "none";
  const nativeBtn = $("#readerNativeBtn");
  nativeBtn.style.display = "none";
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
    enableWebtoonToggle();
    nativeBtn.style.display = "inline-flex";
    nativeBtn.title = "Ouvrir avec la visionneuse PDF native";
    nativeBtn.textContent = "⧉";
    nativeBtn.onclick = () => toggleNativePDFView(book);
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
    enableWebtoonToggle();
    return;
  }

  if (book.format === "images") {
    const urls = book.pageBlobs.map((b) => URL.createObjectURL(b));
    state.currentReader.pages = urls;
    state.currentReader.total = urls.length;
    renderImagePage(0);
    setupPageNav();
    enableWebtoonToggle();
    return;
  }
}

function enableWebtoonToggle() {
  const modeBtn = $("#readerModeBtn");
  modeBtn.style.display = "inline-flex";
  modeBtn.textContent = "↕";
  modeBtn.title = "Passer en défilement continu (Webtoon)";
  modeBtn.onclick = toggleReaderMode;
}

// Affiche le PDF via la visionneuse native d'iOS, intégrée dans le lecteur
// (iframe) plutôt qu'en nouvel onglet, ce qui évite un bug WebKit connu
// (WebKitBlobResource) où les URL blob ne s'ouvrent pas correctement en
// dehors du document qui les a créées, notamment depuis une PWA installée.
function toggleNativePDFView(book) {
  const r = state.currentReader;
  if (!r) return;
  const viewer = $("#readerViewer");
  const nativeBtn = $("#readerNativeBtn");
  const modeBtn = $("#readerModeBtn");

  if (r.viewMode === "native") {
    r.viewMode = "custom";
    nativeBtn.textContent = "⧉";
    nativeBtn.title = "Ouvrir avec la visionneuse PDF native";
    modeBtn.style.display = "inline-flex";
    $("#readerNav").style.display = "flex";
    clearNativeBlob(r);
    renderPDFPage(r.page || 0);
  } else {
    r.scrollObserver?.disconnect();
    r.scrollObserver = null;
    r.viewMode = "native";
    viewer.classList.remove("scroll-mode");
    viewer.innerHTML = `<p class="reader-loading">Préparation de la visionneuse native…</p>`;
    activateNativeBlob(book, r, viewer);
    nativeBtn.textContent = "↩";
    nativeBtn.title = "Revenir à la vue habituelle";
    modeBtn.style.display = "none";
    $("#readerNav").style.display = "none";
  }
}

async function activateNativeBlob(book, r, viewer) {
  try {
    const registration = await navigator.serviceWorker.ready;
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new Error("Service worker non actif");
    const id = "pdf-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    controller.postMessage({ type: "store-blob", id, blob: book.fileBlob });
    r.nativeBlobId = id;
    // petite marge pour laisser le service worker enregistrer le blob avant de le demander
    await new Promise((res) => setTimeout(res, 80));
    if (r.viewMode !== "native") return; // l'utilisateur a déjà changé d'avis
    viewer.innerHTML = `<iframe src="./__blob__/${id}" class="native-pdf-frame" title="${escapeHTML(
      book.title
    )}"></iframe>`;
  } catch (err) {
    console.error(err);
    viewer.innerHTML = `<p class="reader-loading">Impossible d'ouvrir la visionneuse native. Réessaie après avoir rechargé l'appli.</p>`;
  }
}

function clearNativeBlob(r) {
  if (r.nativeBlobId && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "clear-blob", id: r.nativeBlobId });
  }
  r.nativeBlobId = null;
}

function toggleReaderMode() {
  const r = state.currentReader;
  if (!r) return;
  r.mode = r.mode === "scroll" ? "page" : "scroll";
  const modeBtn = $("#readerModeBtn");
  const viewer = $("#readerViewer");
  if (r.mode === "scroll") {
    modeBtn.textContent = "▤";
    modeBtn.title = "Repasser en page par page";
    viewer.classList.add("scroll-mode");
    $("#readerNav").style.display = "none";
    if (r.book.format === "pdf") renderScrollModePDF();
    else renderScrollMode();
  } else {
    modeBtn.textContent = "↕";
    modeBtn.title = "Passer en défilement continu (Webtoon)";
    viewer.classList.remove("scroll-mode");
    $("#readerNav").style.display = "flex";
    r.scrollObserver?.disconnect();
    r.scrollObserver = null;
    if (r.book.format === "pdf") renderPDFPage(r.page);
    else renderImagePage(r.page);
  }
}

function renderScrollMode() {
  const { pages } = state.currentReader;
  const viewer = $("#readerViewer");
  viewer.innerHTML = pages
    .map((url, i) => `<img src="${url}" class="scroll-page" data-i="${i}" alt="page ${i + 1}">`)
    .join("");
}

// Rend UNE page PDF dans `container`, en la découpant automatiquement en
// plusieurs tranches (canvas) si elle est trop haute pour être dessinée d'un
// coup en toute sécurité (cas fréquent des PDF webtoon/toomics : tout un
// chapitre empilé sur une seule page géante). Chaque tranche reste nette,
// sans jamais dépasser une taille de canvas qui ferait planter Safari.
async function renderPDFPageTiles(page, container, dpr) {
  const baseViewport = page.getViewport({ scale: 1 });
  const baseWidth = baseViewport.width;
  const fitScale = (window.innerWidth * 0.97 * dpr) / baseWidth;
  const scale = Math.min(4, fitScale);
  const viewport = page.getViewport({ scale });
  const fullW = Math.round(viewport.width);
  const fullH = Math.round(viewport.height);
  const MAX_TILE_H = 3000; // hauteur de tranche sûre sur tous les appareils

  if (fullH <= MAX_TILE_H) {
    const canvas = document.createElement("canvas");
    canvas.width = fullW;
    canvas.height = fullH;
    canvas.className = "pdf-tile";
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    container.appendChild(canvas);
    return;
  }

  const numSlices = Math.ceil(fullH / MAX_TILE_H);
  for (let k = 0; k < numSlices; k++) {
    const sliceH = Math.min(MAX_TILE_H, fullH - k * MAX_TILE_H);
    const canvas = document.createElement("canvas");
    canvas.width = fullW;
    canvas.height = sliceH;
    canvas.className = "pdf-tile";
    const ctx = canvas.getContext("2d");
    ctx.translate(0, -k * MAX_TILE_H);
    await page.render({ canvasContext: ctx, viewport }).promise;
    container.appendChild(canvas);
  }
}

async function renderScrollModePDF() {
  const { pdf, total } = state.currentReader;
  const viewer = $("#readerViewer");
  viewer.innerHTML = `<p class="reader-loading">Préparation…</p>`;
  const dpr = Math.min(3, window.devicePixelRatio || 1);

  // on récupère d'abord juste les dimensions de chaque page (rapide, sans
  // dessiner de pixels) pour réserver l'espace exact de chacune et permettre
  // un chargement progressif au défilement plutôt que tout dessiner d'un coup
  const pageInfos = [];
  for (let i = 1; i <= total; i++) {
    if (state.currentReader?.mode !== "scroll") return;
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    pageInfos.push({ num: i, ratio: vp.height / vp.width });
  }
  if (state.currentReader?.mode !== "scroll") return;

  const container = document.createElement("div");
  container.className = "pdf-page-container";
  viewer.innerHTML = "";
  viewer.appendChild(container);

  const placeholders = pageInfos.map((info) => {
    const ph = document.createElement("div");
    ph.className = "pdf-page-placeholder";
    ph.dataset.page = info.num;
    ph.style.aspectRatio = `1 / ${info.ratio}`;
    container.appendChild(ph);
    return ph;
  });

  const rendered = new Set();

  async function renderPlaceholder(ph, pageNum) {
    if (rendered.has(pageNum)) return;
    rendered.add(pageNum);
    ph.style.aspectRatio = "";
    const page = await pdf.getPage(pageNum);
    // vérifie qu'on est toujours en mode scroll et que la case existe encore
    // (l'utilisateur a pu changer de page/mode pendant le chargement)
    if (state.currentReader?.mode !== "scroll" || !ph.isConnected) return;
    await renderPDFPageTiles(page, ph, dpr);
  }

  function unrenderPlaceholder(ph, pageNum) {
    if (!rendered.has(pageNum)) return;
    rendered.delete(pageNum);
    const info = pageInfos.find((p) => p.num === pageNum);
    ph.innerHTML = "";
    ph.style.aspectRatio = info ? `1 / ${info.ratio}` : "";
  }

  // marge large : on garde ~1200px chargés avant/après l'écran visible,
  // ce qui suffit à un défilement fluide sans jamais garder tout le fichier
  // dessiné en mémoire en même temps (essentiel pour les très gros PDF)
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const ph = entry.target;
        const pageNum = parseInt(ph.dataset.page, 10);
        if (entry.isIntersecting) renderPlaceholder(ph, pageNum);
        else unrenderPlaceholder(ph, pageNum);
      }
    },
    { root: viewer, rootMargin: "1200px 0px 1200px 0px" }
  );
  placeholders.forEach((ph) => observer.observe(ph));

  state.currentReader.scrollObserver = observer;
  state.currentReader.zoomScale = 1;
  enableZoomPan(container, (s) => (state.currentReader.zoomScale = s));
}

async function renderPDFPage(i) {
  const { pdf } = state.currentReader;
  state.currentReader.page = i;
  const page = await pdf.getPage(i + 1);
  const dpr = Math.min(3, window.devicePixelRatio || 1);

  const viewer = $("#readerViewer");
  viewer.innerHTML = "";
  viewer.classList.add("scroll-mode"); // affichage en haut + défilement, adapté aux pages très hautes
  const container = document.createElement("div");
  container.className = "pdf-page-container";
  viewer.appendChild(container);

  await renderPDFPageTiles(page, container, dpr);

  state.currentReader.zoomScale = 1;
  enableZoomPan(container, (s) => (state.currentReader.zoomScale = s));
  updatePageLabel();
}

function renderImagePage(i) {
  state.currentReader.page = i;
  const url = state.currentReader.pages[i];
  $("#readerViewer").innerHTML = `<img src="${url}" class="page-img" alt="page ${i + 1}">`;
  state.currentReader.zoomScale = 1;
  enableZoomPan($("#readerViewer .page-img"), (s) => (state.currentReader.zoomScale = s));
  updatePageLabel();
}

function updatePageLabel() {
  const { page, total } = state.currentReader;
  const label = document.querySelector("#pageLabel");
  if (label) label.textContent = `${page + 1} / ${total}`;
}

function setupPageNav() {
  $("#readerNav").style.display = "flex";
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
  state.currentReader?.scrollObserver?.disconnect();
  clearNativeBlob(state.currentReader || {});
  $("#readerModal").classList.remove("open");
  $("#readerViewer").innerHTML = "";
  $("#readerViewer").classList.remove("scroll-mode");
  $("#readerModeBtn").style.display = "none";
  $("#readerNativeBtn").style.display = "none";
  state.currentReader = null;
}

// ---------- Glisser pour tourner les pages ----------
function setupSwipeNav() {
  const viewer = $("#readerViewer");
  let sx = 0,
    sy = 0,
    st = 0;
  viewer.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      st = Date.now();
    },
    { passive: true }
  );
  viewer.addEventListener("touchend", (e) => {
    if (!state.currentReader) return;
    if (state.currentReader.mode === "scroll") return; // le scroll vertical gère lui-même la navigation
    if (state.currentReader.zoomScale > 1.05) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - sx;
    const dy = touch.clientY - sy;
    const dt = Date.now() - st;
    if (dt < 600 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      goPage(dx < 0 ? 1 : -1);
    }
  });
}

// ---------- Zoom / pan (pincer pour zoomer, double-tap, glisser une fois zoomé) ----------
function enableZoomPan(el, onScaleChange) {
  if (!el) return;
  let scale = 1,
    translateX = 0,
    translateY = 0;
  let lastTapTime = 0;
  let startDist = 0,
    startScale = 1;
  let dragging = false,
    startX = 0,
    startY = 0,
    startTX = 0,
    startTY = 0;

  el.style.transformOrigin = "center center";
  el.style.transition = "transform 0.15s ease-out";
  el.style.touchAction = "pan-y";

  function applyTransform() {
    el.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    onScaleChange && onScaleChange(scale);
  }
  function resetZoom() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    applyTransform();
  }

  el.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        startDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        startScale = scale;
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTapTime < 300) {
          scale = scale > 1 ? 1 : 2.5;
          translateX = 0;
          translateY = 0;
          applyTransform();
        }
        lastTapTime = now;
        if (scale > 1) {
          dragging = true;
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          startTX = translateX;
          startTY = translateY;
        }
      }
    },
    { passive: true }
  );

  el.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && startDist) {
        const [a, b] = e.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        scale = Math.min(4, Math.max(1, startScale * (dist / startDist)));
        applyTransform();
      } else if (dragging && e.touches.length === 1) {
        translateX = startTX + (e.touches[0].clientX - startX);
        translateY = startTY + (e.touches[0].clientY - startY);
        applyTransform();
      }
    },
    { passive: true }
  );

  el.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) {
      dragging = false;
      startDist = 0;
      if (scale <= 1.02) resetZoom();
    }
  });
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
