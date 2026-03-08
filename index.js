const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const EXCEL_FILE = path.join(__dirname, 'Senado2026_Analisis_1.xlsx');
const OUTPUT_DIR = path.join(__dirname, 'resultados');
const PROGRESS_FILE = path.join(__dirname, 'progreso.json');

const QUERY_TEMPLATE = 'Dame un resumen del candidato al senado de colombia {NombreCompleto} que incluya: trayectoria: breve descripción de su carrera política o pública.iniciativas y proyectos: principales propuestas, leyes o políticas que ha promovido. controversias o investigaciones: si ha sido relacionado(a) con actos de corrupción, describe el caso y el estado actual de la investigación o proceso judicial.';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ0-9\s_-]/g, '').trim().replace(/\s+/g, '_');
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    return new Set(data.completed || []);
  }
  return new Set();
}

function saveProgress(completed) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ completed: Array.from(completed) }, null, 2));
}

function readCandidates() {
  const workbook = XLSX.readFile(EXCEL_FILE);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);
  return rows;
}

async function typeHumanLike(page, selector, text) {
  await page.focus(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await randomDelay(30, 90);
  }
}

async function searchCandidate(page, nombreCompleto) {
  const query = QUERY_TEMPLATE.replace('{NombreCompleto}', nombreCompleto);

  await page.goto('https://www.google.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await randomDelay(1500, 3000);

  await page.waitForSelector('textarea', { timeout: 15000 });
  await randomDelay(800, 1500);

  await page.click('textarea');
  await randomDelay(300, 600);
  await typeHumanLike(page, 'textarea', query);
  await randomDelay(500, 1200);

  await page.waitForSelector('button[jsname="B6rgad"]', { timeout: 10000 });
  await randomDelay(400, 800);
  await page.click('button[jsname="B6rgad"]');

  await randomDelay(8000, 11000);

  let content = '';
  try {
    await page.waitForSelector('div[data-container-id="main-col"]', { timeout: 15000 });
    content = await page.$eval('div[data-container-id="main-col"]', el => el.textContent);
  } catch (e) {
    console.warn(`  Panel IA no encontrado para "${nombreCompleto}", capturando texto general...`);
    content = await page.evaluate(() => document.body.innerText);
  }

  return content;
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
  }

  const candidates = readCandidates();
  const completed = loadProgress();

  console.log(`Total candidatos: ${candidates.length}`);
  console.log(`Ya procesados: ${completed.size}`);

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    const nombreCompleto = row['NombreCompleto'] || row['nombre_completo'] || row['Nombre Completo'] || Object.values(row)[0];

    if (!nombreCompleto) {
      console.warn(`Fila ${i + 1}: sin NombreCompleto, omitiendo.`);
      continue;
    }

    if (completed.has(nombreCompleto)) {
      console.log(`[${i + 1}/${candidates.length}] Ya procesado: ${nombreCompleto}`);
      continue;
    }

    console.log(`[${i + 1}/${candidates.length}] Procesando: ${nombreCompleto}`);

    try {
      const content = await searchCandidate(page, nombreCompleto);

      const filename = sanitizeFilename(nombreCompleto) + '.txt';
      const filepath = path.join(OUTPUT_DIR, filename);
      const output = `=== ${nombreCompleto} ===\nFecha: ${new Date().toISOString()}\n\n${content}\n`;
      fs.writeFileSync(filepath, output, 'utf8');

      completed.add(nombreCompleto);
      saveProgress(completed);

      console.log(`  Guardado: ${filename}`);

      if (i < candidates.length - 1) {
        const pause = Math.floor(Math.random() * 8000) + 7000;
        console.log(`  Esperando ${(pause / 1000).toFixed(1)}s antes del siguiente...`);
        await sleep(pause);
      }
    } catch (err) {
      console.error(`  Error procesando "${nombreCompleto}": ${err.message}`);
      saveProgress(completed);
      await sleep(15000);
    }
  }

  await browser.close();
  console.log('\nProceso completado.');
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
