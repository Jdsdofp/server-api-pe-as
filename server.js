// =============================================================================
// Search Proxy Server — Playwright + Stealth
// =============================================================================

const express        = require("express");
const { chromium }   = require("playwright-extra");
const StealthPlugin  = require("puppeteer-extra-plugin-stealth");
const { createWorker } = require("tesseract.js");
const fs             = require("fs");

chromium.use(StealthPlugin());

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// ---------------------------------------------------------------------------
// Browser singletons
// ---------------------------------------------------------------------------
let browserHeadless = null;
let browserVisible  = null;

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--lang=en-US",
];

async function getBrowser(headless = true) {
  if (headless) {
    if (browserHeadless) return browserHeadless;
    console.log("[BROWSER] Iniciando Playwright headless...");
    browserHeadless = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    return browserHeadless;
  } else {
    if (browserVisible) return browserVisible;
    console.log("[BROWSER] Iniciando Playwright visible (bypass CF)...");
    browserVisible = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
    return browserVisible;
  }
}

async function newPage(headless = true, locale = "en-US") {
  const browser = await getBrowser(headless);
  const ctx     = await browser.newContext({
    locale,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    viewport : { width: 1366, height: 768 },
    extraHTTPHeaders: { "Accept-Language": `${locale},en;q=0.9` },
  });
  return ctx.newPage();
}

// ---------------------------------------------------------------------------
// Busca no DuckDuckGo
// ---------------------------------------------------------------------------
async function searchDDG(query, maxResults = 10, region = "br-pt") {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&kl=${region}`;
  console.log(`[SEARCH] → ${url}`);

  const page = await newPage(true, "pt-BR");

  try {
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "stylesheet", "font", "media"].includes(type)) route.abort();
      else route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

    const RESULT_SEL = "[data-testid='result']";
    await page.waitForSelector(RESULT_SEL, { timeout: 10000 }).catch(() =>
      console.warn("[SEARCH] Seletor não apareceu.")
    );
    await page.waitForSelector("[data-testid='result-snippet']", { timeout: 5000 }).catch(() =>
      console.warn("[SEARCH] Snippets não apareceram.")
    );

    fs.writeFileSync("debug_ddg.html", await page.content(), "utf8");

    const results = await page.evaluate((sel, max) => {
      const items = [...document.querySelectorAll(sel)].slice(0, max);
      return items.map((item) => {
        const titleEl   = item.querySelector("[data-testid='result-title-a']");
        const snippetEl = item.querySelector("[data-testid='result-snippet']");
        const anySnip   = item.querySelector(".result__snippet, span[class*='snippet'], div[class*='snippet']");
        return {
          title  : titleEl?.innerText.trim() ?? "",
          url    : titleEl?.href ?? "",
          snippet: snippetEl?.innerText.trim() ?? anySnip?.innerText.trim() ?? "",
        };
      }).filter((r) => r.title && r.url);
    }, RESULT_SEL, maxResults);

    console.log(`[SEARCH] ${results.length} resultado(s).`);
    return results;

  } finally {
    await page.context().close();
  }
}

// ---------------------------------------------------------------------------
// Scraping GMPartsDirect (visible para bypassar CF Turnstile)
// ---------------------------------------------------------------------------
async function scrapeGMPartsDirect(sku) {
  const url = `https://www.gmpartsdirect.com/search?search_str=${encodeURIComponent(sku)}`;
  console.log(`[GMD] → ${url}`);

  // Contexto isolado — evita conflito com o browser visível singleton
  const browser  = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
  const ctx      = await browser.newContext({ locale: "en-US", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36", viewport: { width: 1366, height: 768 } });
  const page     = await ctx.newPage();
  let capturedProduct = null;

  try {
    // Intercepta respostas JSON da RevolutionParts API
    page.on("response", async (response) => {
      const ct = response.headers()["content-type"] ?? "";
      if (!ct.includes("application/json")) return;
      const respUrl = response.url();
      if (!respUrl.includes("/ajax") && !respUrl.includes("search_str") && !respUrl.includes("/parts")) return;
      try {
        const json = await response.json();
        const arr  = json?.results ?? json?.products ?? json?.parts ?? (Array.isArray(json) ? json : null);
        if (arr?.length > 0) {
          capturedProduct = arr.find((p) => String(p.sku ?? p.id ?? "").includes(String(sku))) ?? arr[0];
          console.log(`[GMD] Capturado via rede: ${capturedProduct?.name ?? "?"}`);
        }
      } catch (_) {}
    });

    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) route.abort();
      else route.continue();
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 40000 });

    // Aguarda sair do challenge CF
    await page.waitForFunction(
      () => !document.title.includes("Just a moment"),
      { timeout: 30000 }
    ).catch(() => console.warn("[GMD] CF challenge não resolvido."));

    fs.writeFileSync("debug_gm.html", await page.content(), "utf8");

    if (capturedProduct) {
      const price = parseFloat(capturedProduct.price ?? capturedProduct.sale_price ?? 0) || null;
      return {
        source    : "gmpartsdirect.com",
        name      : capturedProduct.name ?? capturedProduct.title ?? null,
        price,
        priceRaw  : price ? `$${price.toFixed(2)}` : null,
        inStock   : !!(capturedProduct.in_stock ?? capturedProduct.available),
        stockText : capturedProduct.in_stock ? "In Stock" : "Out of Stock",
        image     : capturedProduct.image ?? capturedProduct.image_url ?? null,
        productUrl: capturedProduct.url ?? capturedProduct.product_url ?? null,
      };
    }

    // Fallback: extrai do HTML renderizado
    return await page.evaluate((skuStr) => {
      const txt      = (el) => el?.innerText.trim() ?? null;
      const priceEl  = document.querySelector(".part-price, [class*='price'], [itemprop='price'], [data-price]");
      const nameEl   = document.querySelector("h1, [itemprop='name'], [class*='part-name']");
      const stockEl  = document.querySelector("[class*='stock'], [class*='availability']");
      const imgEl    = document.querySelector("img[src*='s3.amazonaws'], img[src*='rp-part']");
      const linkEl   = document.querySelector("a[href*='oem-parts']");
      const rawPrice = txt(priceEl) ?? "";
      const price    = parseFloat(rawPrice.replace(/[^0-9.]/g, "")) || null;
      return {
        source    : "gmpartsdirect.com",
        name      : txt(nameEl),
        price,
        priceRaw  : rawPrice || null,
        inStock   : stockEl ? !stockEl.innerText.toLowerCase().includes("out") : null,
        stockText : txt(stockEl),
        image     : imgEl?.src ?? null,
        productUrl: linkEl?.href ?? null,
      };
    }, String(sku));

  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// OCR — resolve CAPTCHA de imagem simples
// ---------------------------------------------------------------------------
async function solveCaptcha(page) {
  const imgEl = await page.$("form img");
  if (!imgEl) return false;

  console.log("[CAPTCHA] Detectado — tirando screenshot da imagem...");
  const imgPath = "captcha_tmp.png";
  await imgEl.screenshot({ path: imgPath });

  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    tessedit_pageseg_mode  : "7", // linha única
  });
  const { data: { text } } = await worker.recognize(imgPath);
  await worker.terminate();

  const code = text.trim().replace(/\s/g, "");
  console.log(`[CAPTCHA] OCR leu: "${code}"`);

  if (!code) return false;

  const input = await page.$("form input[type='text'], form input:not([type='submit'])");
  if (!input) return false;

  await input.fill(code);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }).catch(() => {}),
    page.click("form input[type='submit'], form button"),
  ]);

  console.log("[CAPTCHA] Submetido. URL atual:", page.url());
  return true;
}

// ---------------------------------------------------------------------------
// Scraping RockAuto (sem Cloudflare)
// ---------------------------------------------------------------------------
async function scrapeRockAuto(sku) {
  const url = `https://www.rockauto.com/en/partsearch/?partnum=${encodeURIComponent(sku)}`;
  console.log(`[ROCKAUTO] → ${url}`);

  const page = await newPage(true, "en-US");

  try {
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) route.abort();
      else route.continue();
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 40000 });

    // Resolve CAPTCHA se aparecer (até 2 tentativas)
    for (let i = 0; i < 2; i++) {
      if (page.url().includes("/captcha/")) {
        const solved = await solveCaptcha(page);
        if (!solved) break;
        await page.waitForLoadState("networkidle").catch(() => {});
      } else break;
    }

    await page.waitForSelector("tbody.listing-inner", { timeout: 15000 })
      .catch(() => console.warn("[ROCKAUTO] Nenhum listing encontrado."));

    fs.writeFileSync("debug_rockauto.html", await page.content(), "utf8");

    const results = await page.evaluate((skuStr) => {
      const txt      = (el) => el?.innerText.trim() ?? null;
      const listings = [...document.querySelectorAll("tbody.listing-inner")];

      return listings.map((row) => {
        // Parte que lista os OE/alternate numbers inclui o SKU buscado
        const altEl    = row.querySelector("span[title*='Alternate'], span[title*='OE Part']");
        const isMatch  = altEl?.innerText.includes(skuStr) ?? false;

        const brand    = txt(row.querySelector(".listing-final-manufacturer"));
        const partNum  = txt(row.querySelector(".listing-final-partnumber"));
        const noteEl   = row.querySelector(".listing-footnote-text");
        const name     = brand && partNum ? `${brand} ${partNum}` : null;
        const desc     = txt(noteEl)?.replace(/^Category:\s*/i, "") ?? null;

        // Preço unitário: span[id^='dprice'][id$='[v]']
        const priceSpans = [...row.querySelectorAll("span[id^='dprice'][id$='[v]']")];
        const rawPrice   = txt(priceSpans[0])?.replace(/[()]/g, "") ?? "";
        const price      = parseFloat(rawPrice.replace(/[^0-9.,]/g, "").replace(",", ".")) || null;

        const linkEl   = row.querySelector("a.ra-btn-moreinfo");
        const imgEl    = row.querySelector("img.listing-inline-image");

        return {
          source    : "rockauto.com",
          brand,
          partNum,
          name,
          description: desc,
          price,
          priceRaw  : rawPrice || null,
          isOEMatch : isMatch,
          inStock   : true,
          image     : imgEl ? `https://www.rockauto.com${imgEl.getAttribute("src")}` : null,
          productUrl: linkEl?.href ?? null,
        };
      }).filter((r) => r.name);
    }, String(sku));

    console.log(`[ROCKAUTO] ${results.length} resultado(s) encontrado(s).`);

    // Prioriza correspondência exata de OE; senão retorna todos
    const oeMatches = results.filter((r) => r.isOEMatch);
    return oeMatches.length > 0 ? oeMatches : results;

  } finally {
    await page.context().close();
  }
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

// POST /api/search
app.post("/api/search", async (req, res) => {
  const { query, maxResults = 10, region = "br-pt" } = req.body ?? {};
  if (!query?.trim()) return res.status(400).json({ error: 'Campo "query" é obrigatório.' });
  try {
    const results = await searchDDG(query.trim(), Number(maxResults), region);
    return res.json({ query, region, total: results.length, results });
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
});

// GET /api/search?q=...&max=10&region=br-pt
app.get("/api/search", async (req, res) => {
  const query      = req.query.q ?? "";
  const maxResults = Number(req.query.max ?? 10);
  const region     = req.query.region ?? "br-pt";
  if (!query.trim()) return res.status(400).json({ error: 'Parâmetro "q" é obrigatório.' });
  try {
    const results = await searchDDG(query.trim(), maxResults, region);
    return res.json({ query, region, total: results.length, results });
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
});

// GET /api/preco?sku=12616850&sources=all|rockauto|gmpartsdirect
app.get("/api/preco", async (req, res) => {
  const sku     = req.query.sku?.trim() ?? "";
  const sources = (req.query.sources ?? "rockauto").toLowerCase();

  if (!sku) return res.status(400).json({ error: 'Parâmetro "sku" é obrigatório.' });

  const tasks = {};
  if (sources === "all" || sources === "rockauto")      tasks.rockauto      = scrapeRockAuto(sku);
  if (sources === "all" || sources === "gmpartsdirect") tasks.gmpartsdirect = scrapeGMPartsDirect(sku);

  const keys    = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));

  const result = { sku };
  keys.forEach((key, i) => {
    result[key] = settled[i].status === "fulfilled"
      ? settled[i].value
      : { error: settled[i].reason?.message };
  });

  return res.json(result);
});

// ---------------------------------------------------------------------------
// Cadastro — AutoZone
// ---------------------------------------------------------------------------
async function scrapeAutoZone(partNumber) {
  const url = `https://www.autozone.com/searchresult?searchText=${encodeURIComponent(partNumber)}`;
  console.log(`[AUTOZONE] → ${url}`);
  const page = await newPage(true, "en-US");
  try {
    await page.route("**/*", (route) => {
      if (["image", "font", "media"].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 35000 });
    await page.waitForSelector("[class*='product'], [data-testid*='product'], h1", { timeout: 10000 })
      .catch(() => console.warn("[AUTOZONE] Seletor não encontrado."));
    fs.writeFileSync("debug_autozone.html", await page.content(), "utf8");

    return await page.evaluate((pn) => {
      const txt    = (el) => el?.innerText.trim() ?? null;
      const attr   = (el, a) => el?.getAttribute(a) ?? null;

      // Tenta página de produto direto ou resultado de busca
      const nameEl  = document.querySelector("h1, [data-testid='product-name'], [class*='product-name']");
      const descEl  = document.querySelector("[data-testid='product-description'], [class*='description'], [class*='desc']");
      const catEl   = document.querySelector("[class*='breadcrumb'] a:last-child, nav[aria-label*='breadcrumb'] a:last-child");
      const imgEl   = document.querySelector("img[data-testid*='product'], img[class*='product'], img[alt*='Part']");
      const specEls = [...document.querySelectorAll("[class*='spec'] tr, [class*='attribute'] tr, [class*='detail'] tr")];
      const appEls  = [...document.querySelectorAll("[class*='fitment'] li, [class*='vehicle'] li, [class*='application'] li")];

      const specs = specEls.reduce((acc, row) => {
        const cells = [...row.querySelectorAll("td, th")];
        if (cells.length >= 2) acc[cells[0].innerText.trim()] = cells[1].innerText.trim();
        return acc;
      }, {});

      return {
        source      : "autozone.com",
        partNumber  : pn,
        name        : txt(nameEl),
        description : txt(descEl),
        category    : txt(catEl),
        image       : attr(imgEl, "src"),
        specifications: Object.keys(specs).length > 0 ? specs : null,
        applications: appEls.map((el) => el.innerText.trim()).filter(Boolean).slice(0, 10),
      };
    }, partNumber);
  } finally {
    await page.context().close();
  }
}

// ---------------------------------------------------------------------------
// Cadastro — NAPA Auto Parts
// ---------------------------------------------------------------------------
async function scrapeNAPA(partNumber) {
  const url = `https://www.napaonline.com/en/search?q=${encodeURIComponent(partNumber)}`;
  console.log(`[NAPA] → ${url}`);
  const page = await newPage(true, "en-US");
  try {
    await page.route("**/*", (route) => {
      if (["image", "font", "media"].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 35000 });
    await page.waitForSelector("[class*='product'], h1, [data-testid]", { timeout: 10000 })
      .catch(() => console.warn("[NAPA] Seletor não encontrado."));
    fs.writeFileSync("debug_napa.html", await page.content(), "utf8");

    return await page.evaluate((pn) => {
      const txt  = (el) => el?.innerText.trim() ?? null;
      const attr = (el, a) => el?.getAttribute(a) ?? null;

      const nameEl  = document.querySelector("h1, [class*='product-name'], [class*='productName']");
      const descEl  = document.querySelector("[class*='description'], [class*='productDesc'], [class*='product-desc']");
      const catEl   = document.querySelector("[class*='breadcrumb'] a:last-child, [class*='Breadcrumb'] a:last-child");
      const imgEl   = document.querySelector("img[class*='product'], img[class*='Product'], img[alt*='part'], img[alt*='Part']");
      const specRows = [...document.querySelectorAll("[class*='spec'] tr, [class*='Spec'] tr, table tr")];
      const appEls  = [...document.querySelectorAll("[class*='fitment'] li, [class*='application'] li, [class*='vehicle'] li")];

      const specs = specRows.reduce((acc, row) => {
        const cells = [...row.querySelectorAll("td, th")];
        if (cells.length >= 2) acc[cells[0].innerText.trim()] = cells[1].innerText.trim();
        return acc;
      }, {});

      return {
        source        : "napaonline.com",
        partNumber    : pn,
        name          : txt(nameEl),
        description   : txt(descEl),
        category      : txt(catEl),
        image         : attr(imgEl, "src"),
        specifications: Object.keys(specs).length > 0 ? specs : null,
        applications  : appEls.map((el) => el.innerText.trim()).filter(Boolean).slice(0, 10),
      };
    }, partNumber);
  } finally {
    await page.context().close();
  }
}

// ---------------------------------------------------------------------------
// Cadastro — ACDelco (oficial GM)
// ---------------------------------------------------------------------------
async function scrapeACDelco(partNumber) {
  const url = `https://www.acdelco.com/search#q=${encodeURIComponent(partNumber)}&t=All`;
  console.log(`[ACDELCO] → ${url}`);
  const page = await newPage(true, "en-US");
  try {
    await page.route("**/*", (route) => {
      if (["image", "font", "media"].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 35000 });
    await page.waitForSelector("[class*='product'], [class*='result'], h1", { timeout: 10000 })
      .catch(() => console.warn("[ACDELCO] Seletor não encontrado."));
    fs.writeFileSync("debug_acdelco.html", await page.content(), "utf8");

    return await page.evaluate((pn) => {
      const txt  = (el) => el?.innerText.trim() ?? null;
      const attr = (el, a) => el?.getAttribute(a) ?? null;

      const nameEl  = document.querySelector("h1, [class*='product-name'], [class*='ProductName'], [class*='title']");
      const descEl  = document.querySelector("[class*='description'], [class*='Description']");
      const catEl   = document.querySelector("[class*='breadcrumb'] a:last-child, [class*='category']");
      const imgEl   = document.querySelector("img[class*='product'], img[class*='Product']");
      const specRows = [...document.querySelectorAll("table tr, [class*='spec'] tr")];
      const appEls  = [...document.querySelectorAll("[class*='application'] li, [class*='fitment'] li, [class*='vehicle'] li")];

      const specs = specRows.reduce((acc, row) => {
        const cells = [...row.querySelectorAll("td, th")];
        if (cells.length >= 2) {
          const key = cells[0].innerText.trim();
          if (key) acc[key] = cells[1].innerText.trim();
        }
        return acc;
      }, {});

      return {
        source        : "acdelco.com",
        partNumber    : pn,
        name          : txt(nameEl),
        description   : txt(descEl),
        category      : txt(catEl),
        image         : attr(imgEl, "src"),
        specifications: Object.keys(specs).length > 0 ? specs : null,
        applications  : appEls.map((el) => el.innerText.trim()).filter(Boolean).slice(0, 10),
      };
    }, partNumber);
  } finally {
    await page.context().close();
  }
}

// GET /api/peca?num=12616850&sources=all|autozone|napa|acdelco|rockauto
app.get("/api/peca", async (req, res) => {
  const num     = req.query.num?.trim() ?? "";
  const sources = (req.query.sources ?? "all").toLowerCase();

  if (!num) return res.status(400).json({ error: 'Parâmetro "num" é obrigatório.' });

  const available = {
    autozone  : () => scrapeAutoZone(num),
    napa      : () => scrapeNAPA(num),
    acdelco   : () => scrapeACDelco(num),
    rockauto  : () => scrapeRockAuto(num),
  };

  const keys = sources === "all"
    ? Object.keys(available)
    : sources.split(",").map((s) => s.trim()).filter((s) => available[s]);

  const settled = await Promise.allSettled(keys.map((k) => available[k]()));

  const result = { partNumber: num };
  keys.forEach((key, i) => {
    result[key] = settled[i].status === "fulfilled"
      ? settled[i].value
      : { error: settled[i].reason?.message };
  });

  return res.json(result);
});

// ---------------------------------------------------------------------------
// Google Shopping scraper
// ---------------------------------------------------------------------------
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanMove(page, x, y) {
  await page.mouse.move(x, y, { steps: randomDelay(8, 20) });
  await page.waitForTimeout(randomDelay(80, 200));
}

async function isCaptchaPage(page) {
  return page.evaluate(() => {
    const url   = location.href;
    const title = document.title.toLowerCase();
    return (
      url.includes("/sorry/") ||
      url.includes("google.com/recaptcha") ||
      title.includes("unusual traffic") ||
      title.includes("before you continue") ||
      !!document.querySelector("iframe[src*='recaptcha'], #recaptcha, .g-recaptcha, form#captcha-form")
    );
  });
}

async function extractShoppingProducts(page) {
  return page.evaluate(() => {
    const selectors = ['div[data-docid]', '.u30d4', '.sh-dgr__gr-auto', '.KZmu8e', '.i0X6df', '.mnr-c'];
    let cards = [];
    for (const sel of selectors) {
      cards = [...document.querySelectorAll(sel)];
      if (cards.length) break;
    }
    return cards.map((card) => ({
      name      : card.querySelector('h3, [role="heading"], .tAxDx, .sh-np__click-target, .Xjkr3b')?.textContent?.trim() || null,
      price     : card.querySelector('.a8Pemb, .kHxwFf, .T14wmb, .g9WBQb, .HRLxBb, .OFFNJ')?.textContent?.trim() || null,
      store     : card.querySelector('.aULzUe, .LbUacb, .IuHnof, .E5ocAb, .zPEcBd')?.textContent?.trim() || null,
      image     : card.querySelector('img')?.src || null,
      productUrl: card.querySelector('a[href]')?.href || null,
    })).filter((p) => p.name || p.price);
  });
}

// ---------------------------------------------------------------------------
// Helpers de normalização
// ---------------------------------------------------------------------------
function parsePrice(raw) {
  if (!raw) return null;
  // Remove símbolo de moeda e espaços; trata vírgula decimal (BRL) e ponto decimal (USD)
  const clean = raw.replace(/[^\d.,]/g, "").trim();
  // Se tem vírgula e ponto: "1.234,56" → 1234.56 (BRL) | "1,234.56" → 1234.56 (USD)
  let normalized;
  if (clean.includes(",") && clean.includes(".")) {
    normalized = clean.indexOf(",") > clean.indexOf(".") ? clean.replace(".", "").replace(",", ".") : clean.replace(",", "");
  } else if (clean.includes(",")) {
    // Só vírgula: pode ser decimal BRL ("10,33") ou milhar USD ("1,234")
    normalized = clean.replace(",", ".");
  } else {
    normalized = clean;
  }
  const num = parseFloat(normalized);
  return isNaN(num) ? null : num;
}

function skuMatchScore(text, sku) {
  if (!text || !sku) return 0;
  const normalized = text.replace(/[-\s]/g, "").toUpperCase();
  const skuClean   = String(sku).replace(/[-\s]/g, "").toUpperCase();
  if (normalized.includes(skuClean)) return 2;
  // Correspondência parcial (≥6 dígitos consecutivos em comum)
  for (let len = skuClean.length; len >= 6; len--) {
    if (normalized.includes(skuClean.slice(0, len))) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Bing Shopping
// ---------------------------------------------------------------------------
async function scrapeBingShopping(query, skuFilter = null) {
  const url = `https://www.bing.com/shop?q=${encodeURIComponent(query)}&setlang=en-US&cc=US&setmkt=en-US`;
  console.log(`[SHOPPING] → ${url}`);

  const page = await newPage(true, "en-US");

  try {
    await page.route("**/*", (route) => {
      if (["font", "media"].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForTimeout(randomDelay(800, 1400));

    await page.waitForSelector(
      ".br-item, .br-gOffCard, .b_algo",
      { timeout: 12000 }
    ).catch(() => console.warn("[SHOPPING] Seletores de produto não encontrados."));

    await page.waitForTimeout(randomDelay(500, 900));

    fs.writeFileSync("debug_shopping.html", await page.content(), "utf8");

    const raw = await page.evaluate(() => {
      // Seletores confirmados pelo HTML real do Bing Shopping
      const selectors = [".br-item", ".br-gOffCard", ".br-narrowOffCard"];
      let cards = [];
      for (const sel of selectors) {
        cards = [...document.querySelectorAll(sel)];
        if (cards.length) break;
      }
      // Fallback: resultados web que contenham preço
      if (!cards.length) {
        cards = [...document.querySelectorAll(".b_algo")].filter(
          (el) => el.querySelector(".b_price, .br-offPrice, [class*='price']")
        );
      }

      return cards.slice(0, 30).map((card) => {
        // URL real: ignora javascript:void(0) e wishlist links
        const linkEl   = card.querySelector("a[href*='bing.com/ck'], a[href*='/shop/'], a[target='_blank'][href*='http']");
        const priceEl  = card.querySelector(".br-offPrice, .b_price, [class*='price']");
        const storeEl  = card.querySelector(".br-offSlrTxt, .br-offSlr");
        const ratingEl = card.querySelector("[id$='-rating'][aria-label]");
        // Nome: usa o alt da imagem principal (contém o nome real do produto no Bing)
        const imgEl    = card.querySelector("img[alt]:not([alt=''])");
        const realUrl  = linkEl?.href && !linkEl.href.includes("void(0)") ? linkEl.href : null;
        const fullText = card.innerText || "";

        const name = imgEl?.getAttribute("alt")?.trim() || null;

        return {
          name,
          priceRaw  : priceEl?.textContent?.trim() || null,
          store     : storeEl?.textContent?.trim() || null,
          rating    : ratingEl?.textContent?.trim() || ratingEl?.getAttribute("aria-label") || null,
          image     : imgEl?.src || null,
          productUrl: realUrl,
          _fullText : fullText,
        };
      });
    });

    // Enriquece, filtra por SKU e ordena
    let products = raw
      .filter((p) => p.name || p.priceRaw)
      .map((p) => {
        const price = parsePrice(p.priceRaw);
        const score = skuFilter ? skuMatchScore(p.name + " " + p._fullText, skuFilter) : 0;
        return { ...p, price, skuMatch: score, _fullText: undefined };
      });

    // Se há filtro de SKU, mantém só os que têm correspondência (score > 0)
    // Se nenhum tiver, retorna todos (busca pode estar usando o nome em vez do número)
    if (skuFilter) {
      const matched = products.filter((p) => p.skuMatch > 0);
      if (matched.length > 0) products = matched;
    }

    // Ordena: maior skuMatch primeiro, depois menor preço
    products.sort((a, b) => {
      if (b.skuMatch !== a.skuMatch) return b.skuMatch - a.skuMatch;
      if (a.price && b.price) return a.price - b.price;
      return a.price ? -1 : 1;
    });

    const buf        = await page.screenshot({ type: "jpeg", quality: 82 });
    const screenshot = `data:image/jpeg;base64,${buf.toString("base64")}`;

    console.log(`[SHOPPING] ${products.length} produto(s) após filtro.`);
    return { source: "bing_shopping", screenshot, products, query };

  } finally {
    await page.context().close().catch(() => {});
  }
}

// Mantém o nome original para a rota /api/shopping
async function scrapeGoogleShopping(query) {
  return scrapeBingShopping(query, query);
}

app.get("/api/shopping", async (req, res) => {
  const q   = (req.query.q || req.query.sku || "").trim();
  const sku = req.query.sku?.trim() || null;
  if (!q) return res.status(400).json({ error: "Parâmetro 'q' ou 'sku' obrigatório." });

  try {
    const data = await scrapeBingShopping(q, sku || q);
    res.json(data);
  } catch (err) {
    console.error("[shopping]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/peca-completa?num=12616850
// Consolida Bing Shopping + RockAuto + ACDelco num único resultado
// ---------------------------------------------------------------------------
app.get("/api/peca-completa", async (req, res) => {
  const num = req.query.num?.trim() ?? "";
  if (!num) return res.status(400).json({ error: 'Parâmetro "num" é obrigatório.' });

  console.log(`[COMPLETA] Iniciando busca consolidada para: ${num}`);

  const [shoppingResult, rockAutoResult, acdelcoResult] = await Promise.allSettled([
    scrapeBingShopping(`${num} OEM GM part`, num),
    scrapeRockAuto(num),
    scrapeACDelco(num),
  ]);

  const shopping = shoppingResult.status === "fulfilled" ? shoppingResult.value : { error: shoppingResult.reason?.message };
  const rockauto = rockAutoResult.status === "fulfilled" ? rockAutoResult.value : { error: rockAutoResult.reason?.message };
  const acdelco  = acdelcoResult.status  === "fulfilled" ? acdelcoResult.value  : { error: acdelcoResult.reason?.message };

  // Consolida preços
  const pricePoints = [];

  (shopping.products || []).forEach((p) => {
    if (p.price) pricePoints.push({ price: p.price, store: p.store || "Bing Shopping", url: p.productUrl });
  });

  const raItems = Array.isArray(rockauto) ? rockauto : (rockauto ? [rockauto] : []);
  raItems.forEach((p) => {
    if (p.price) pricePoints.push({ price: p.price, store: `RockAuto (${p.brand || ""})`.trim(), url: p.productUrl });
  });

  pricePoints.sort((a, b) => a.price - b.price);

  // Nome/descrição: prioriza ACDelco > RockAuto > Bing
  const partName = acdelco?.name || raItems[0]?.name || shopping.products?.[0]?.name || null;
  const category = acdelco?.category || null;
  const specs    = acdelco?.specifications || null;
  const image    = acdelco?.image || raItems[0]?.image || shopping.products?.[0]?.image || null;

  return res.json({
    partNumber    : num,
    name          : partName,
    category,
    image,
    specifications: specs,
    bestPrice     : pricePoints[0] || null,
    allPrices     : pricePoints,
    sources       : { shopping, rockauto, acdelco },
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status   : "ok",
    service  : "Search Proxy (Playwright)",
    headless : !!browserHeadless,
    visible  : !!browserVisible,
    ts       : new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown() {
  console.log("\n[SHUTDOWN] Fechando browsers...");
  if (browserHeadless) await browserHeadless.close();
  if (browserVisible)  await browserVisible.close();
  process.exit(0);
}
// ---------------------------------------------------------------------------
// OCR — extrai número de peça de imagem (base64)
// ---------------------------------------------------------------------------
app.post("/api/ocr", async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: "Campo 'image' (base64 data URL) obrigatório." });

  let worker;
  try {
    worker = await createWorker("eng");
    const { data: { text } } = await worker.recognize(image);

    // Candidatos a número de peça GM: 7-8 dígitos consecutivos
    const candidates = [...new Set((text.match(/\b\d{7,8}\b/g) || []))];
    const partNumber  = candidates[0] || null;

    res.json({ text: text.trim(), partNumber, candidates });
  } catch (err) {
    console.error("[OCR]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (worker) await worker.terminate();
  }
});

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅  Search Proxy (Playwright) → http://localhost:${PORT}`);
  console.log(`   GET  : http://localhost:${PORT}/api/search?q=peças+onix`);
  console.log(`   POST : http://localhost:${PORT}/api/search  { "query": "peças onix" }`);
  console.log(`   GET  : http://localhost:${PORT}/api/preco?sku=12616850`);
});
