import "dotenv/config";
import fs from "fs";
import path from "path";              // ✅ не хватало
import crypto from "crypto";
import { chromium } from "playwright";

const BASE_URL = process.env.URL;
const STUD_ID = process.env.STUDENT_ID;

const INTERVAL_MS = 30_000;
const WAIT_UNTIL = "domcontentloaded";

if (!BASE_URL || !STUD_ID) {
  throw new Error("URL или STUDENT_ID не заданы в .env");
}

const FINAL_URL = `${BASE_URL}${STUD_ID}`;
//const FINAL_URL = 'https://httpbin.org/delay/5';

const LOGIN_INPUT = 'input.el-input__inner[type="text"][placeholder="Введите логин"]';
const PASS_INPUT  = 'input.el-input__inner[type="password"][placeholder="Введите пароль"]';
const SUBMIT_BTN  = 'button.el-button--primary:has-text("Вход")';

// Лучше мониторить не весь body, а конкретный кусок.
// Пока оставим body, как у тебя:
const SELECTOR = "body";

const STUDENT_ID_API = "36646"; // можно тоже из .env
const SAVE_JOBS = [
  { scheduleId: "94601", items: [232314, 232315, 232329] },
  { scheduleId: "94600", items: [232526, 232527, 232545, 232546] },
  { scheduleId: "96803", items: [234428, 234430, 234436] },
  { scheduleId: "95160", items: [233009, 233012, 233011] },
  { scheduleId: "94602", items: [234816] },
  { scheduleId: "95165", items: [233407, 233410, 233409] },
];


function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runAllSaves(page) {
  const results = [];

  for (const { scheduleId, items } of SAVE_JOBS) {
    let ok = false;
    let dataOrError = null;

    // 2 попытки на каждый запрос (можешь сделать 3)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[SAVE TRY] schedule=${scheduleId} attempt=${attempt} items=${items.length}`);
        const data = await saveScheduleInPage(page, STUDENT_ID_API, scheduleId, items);
        console.log(`[SAVE OK] schedule=${scheduleId}`, data);

        ok = true;
        dataOrError = data;
        break;
      } catch (e) {
        dataOrError = e?.message || String(e);
        console.log(`[SAVE ERR] schedule=${scheduleId} attempt=${attempt} -> ${dataOrError}`);

        // небольшая пауза перед ретраем
        await sleep(400 + Math.floor(Math.random() * 600));
      }
    }

    results.push({ scheduleId, ok, result: dataOrError });

    // пауза между разными schedule (чтобы не долбить сервер)
    await sleep(300 + Math.floor(Math.random() * 400));
  }

  return results;
}


async function runLoop(task, intervalMs) {
  while (true) {
    const startedAt = Date.now();

    await task();

    const elapsed = Date.now() - startedAt;
    const sleep = Math.max(0, intervalMs - elapsed);

    if (sleep > 0) {
      await new Promise(resolve => setTimeout(resolve, sleep));
    }
  }
}


/** ✅ Ждём, пока страница реально станет “готовой”: без лоадеров и со стабильным текстом */
async function waitPageFullyReady(page, {
  selector = "body",
  stableChecks = 3,
  delayMs = 700,
  timeoutMs = 120_000,
} = {}) {
  const start = Date.now();

  // 1) базовая загрузка
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

  // 2) ждём исчезновения возможных лоадеров
  const loaders = [
    ".el-loading-mask",
    ".el-loading-spinner",
    ".el-icon-loading",
    "[class*='loading']",
  ];

  for (const sel of loaders) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {});
    }
  }

  // 3) ждём стабильности текста
  let prev = null;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    const text = await page.locator(selector).innerText().catch(() => "");
    const norm = text.replace(/\s+/g, " ").trim();

    if (prev !== null && norm === prev) {
      stableCount++;
      if (stableCount >= stableChecks) {
        return norm;
      }
    } else {
      stableCount = 0;
    }

    prev = norm;
    await page.waitForTimeout(delayMs);
  }

  throw new Error("Страница не стала стабильной за отведённое время");
}

/** ✅ Если нас редиректнуло на логин — логинимся */
async function ensureLoggedIn(page) {
  const isLoginPage = await page.locator(PASS_INPUT).count().then(c => c > 0).catch(() => false);
  if (!isLoginPage) return false;

  const login = process.env.LOGIN;
  const password = process.env.PASSWORD;
  if (!login || !password) throw new Error("LOGIN/PASSWORD не заданы в .env");

  await page.locator(LOGIN_INPUT).waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(PASS_INPUT).waitFor({ state: "visible", timeout: 30_000 });

  await page.locator(LOGIN_INPUT).fill(login);
  await page.locator(PASS_INPUT).fill(password);

  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
    page.locator(SUBMIT_BTN).click(),
  ]);

  const stillLogin = await page.locator(PASS_INPUT).count().catch(() => 0);
  if (stillLogin > 0) {
    throw new Error("Логин не прошёл: форма пароля всё ещё видна (или нужен доп.шаг)");
  }

  return true;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function tsSafe() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function saveScheduleInPage(page, studentId, scheduleId, items) {
  const url = `https://wsp2.kbtu.kz/bachelor/api/registration/student/${studentId}/schedule/${scheduleId}/save`;

  return await page.evaluate(async ({ url, items }) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(items),
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }, { url, items });
}


async function saveArtifacts(page, prefix) {
  const ts = tsSafe();

  const baseDir = path.resolve("artifacts");
  const screenshotDir = path.join(baseDir, "screenshots");
  const htmlDir = path.join(baseDir, "html");

  ensureDir(screenshotDir);
  ensureDir(htmlDir);

  const pngPath = path.join(screenshotDir, `${prefix}_${ts}.png`);
  const htmlPath = path.join(htmlDir, `${prefix}_${ts}.html`);

  await page.screenshot({ path: pngPath, fullPage: true });
  const html = await page.content();
  fs.writeFileSync(htmlPath, html, "utf8");

  return { png: pngPath, html: htmlPath };
}

async function main() {
  let lastHash = null;
  let actionsDone = false;


  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: null });

  const tick = async () => {
    const now = new Date().toISOString();

    try {
      await page.goto(FINAL_URL, { waitUntil: WAIT_UNTIL, timeout: 60_000 });

      const didLogin = await ensureLoggedIn(page);

      if (didLogin && page.url() !== FINAL_URL) {
        await page.goto(FINAL_URL, { waitUntil: "networkidle", timeout: 60_000 });
      }

      const stableText = await waitPageFullyReady(page, {
        selector: SELECTOR,
        stableChecks: 3,
        delayMs: 800,
        timeoutMs: 120_000,
      });

      const h = sha256(stableText);

      if (lastHash === null) {
        lastHash = h;
        console.log(`[INIT] ${now} hash=${h}`);
        return;
      }

      if (h !== lastHash) {
        console.log(`[CHANGE] ${now} Контент изменился!`);
        if (!actionsDone) {
          actionsDone = true;

          try {
            console.log(`[ACTIONS] ${now} запускаю сохранение расписаний...`);

            const results = await runAllSaves(page);

            console.log("=== SAVE RESULTS ===");
            console.log(results);

            // если хочешь — остановить скрипт после попытки:
            // process.exit(0);

          } catch (e) {
            console.log("[ACTIONS FATAL]", e?.message || String(e));
          }
        } else {
          console.log("[ACTIONS] уже выполнялись ранее — пропускаю");
        }
        const files = await saveArtifacts(page, "change");
        console.log(`[SAVE] screenshot=${files.png} html=${files.html}`);
        lastHash = h;
      } else {
        console.log(`[OK] ${now} Без изменений`);
      }

    } catch (e) {
      console.log(`[ERR] ${now} ${e.name}: ${e.message}`);
    }
  };

  // 🔥 ЗАПУСКАЕМ УМНЫЙ ЦИКЛ
  await runLoop(tick, INTERVAL_MS);
}


main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
