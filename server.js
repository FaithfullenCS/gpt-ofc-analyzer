const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const CHECKO_API_KEY = process.env.CHECKO_API_KEY;
const CHECKO_BASE_URL = process.env.CHECKO_API_BASE || 'https://api.checko.ru/v3/companies';
const MOCK_MODE = process.env.CHECKO_MOCK_MODE === 'true' || !CHECKO_API_KEY;

const sampleDataPath = path.join(__dirname, 'data', 'sample-financials.json');
let sampleReports = [];
try {
  const sampleContent = fs.readFileSync(sampleDataPath, 'utf8');
  sampleReports = JSON.parse(sampleContent);
} catch (error) {
  console.error('Не удалось загрузить демонстрационные данные', error);
}

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

function respondJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, parsedUrl) {
  const safePath = path.normalize(parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname);
  const filePath = path.join(__dirname, 'public', safePath);

  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    respondJson(res, 403, { error: 'Запрещено' });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Не найдено');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ошибка сервера');
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function httpGetJson(targetUrl) {
  return new Promise((resolve, reject) => {
    const handler = targetUrl.startsWith('https') ? https : http;
    const request = handler.get(targetUrl, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (error) {
            reject(new Error('Не удалось разобрать ответ API'));
          }
        } else {
          reject(new Error(`Запрос завершился с кодом ${res.statusCode || 500}`));
        }
      });
    });

    request.on('error', reject);
  });
}

function pickReport(year) {
  const match = sampleReports.find(report => String(report.year) === String(year));
  return match || sampleReports[0];
}

function normalizeField(value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    return 0;
  }
  return Number(value);
}

function average(current, previous) {
  if (previous === null || previous === undefined) {
    return normalizeField(current);
  }
  return (normalizeField(current) + normalizeField(previous)) / 2;
}

function safeDivide(numerator, denominator) {
  const num = normalizeField(numerator);
  const den = normalizeField(denominator);
  if (den === 0) {
    return null;
  }
  return num / den;
}

function extractValue(source, preferredKeys) {
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== null && source[key] !== undefined) {
      return source[key];
    }
  }
  return 0;
}

function normalizeReport(raw) {
  const balance = raw.balance_sheet || raw.balance || {};
  const income = raw.income_statement || raw.income || {};
  const assets = raw.assets || {};
  const liabilities = raw.liabilities || {};

  return {
    year: raw.year,
    balance_sheet: {
      inventories: extractValue(balance, ['inventories', 'stocks', 'zapasy']),
      accounts_receivable: extractValue(balance, ['accounts_receivable', 'debtors', 'debitors']),
      accounts_payable: extractValue(balance, ['accounts_payable', 'creditors']),
      current_assets: extractValue(balance, ['current_assets']),
      current_liabilities: extractValue(balance, ['current_liabilities']),
      cash_and_cash_equivalents: extractValue(balance, ['cash_and_cash_equivalents', 'cash']),
      total_assets: extractValue(balance, ['total_assets', 'assets_total', 'balance_total', 'balance']),
      total_liabilities: extractValue(balance, ['total_liabilities', 'liabilities_total']),
      equity: extractValue(balance, ['equity', 'capital']) || extractValue(assets, ['equity']) || extractValue(raw, ['equity']),
    },
    income_statement: {
      revenue: extractValue(income, ['revenue', 'sales']),
      cost_of_goods_sold: extractValue(income, ['cost_of_goods_sold', 'cogs', 'prime_cost']),
      gross_profit: extractValue(income, ['gross_profit']),
      net_income: extractValue(income, ['net_income', 'profit']),
    },
  };
}

function calculateMetrics(currentReport, previousReport) {
  const current = normalizeReport(currentReport);
  const previous = previousReport ? normalizeReport(previousReport) : null;

  const invAvg = average(current.balance_sheet.inventories, previous?.balance_sheet?.inventories);
  const arAvg = average(current.balance_sheet.accounts_receivable, previous?.balance_sheet?.accounts_receivable);
  const apAvg = average(current.balance_sheet.accounts_payable, previous?.balance_sheet?.accounts_payable);
  const cogs = normalizeField(current.income_statement.cost_of_goods_sold);
  const revenue = normalizeField(current.income_statement.revenue);

  const poi = cogs === 0 ? null : (365 * invAvg) / cogs;
  const ppd = revenue === 0 ? null : (365 * arAvg) / revenue;
  const ppa = cogs === 0 ? null : (365 * apAvg) / cogs;
  const ofc = poi === null || ppd === null || ppa === null ? null : poi + ppd - ppa;

  const currentAssets = normalizeField(current.balance_sheet.current_assets);
  const currentLiabilities = normalizeField(current.balance_sheet.current_liabilities);
  const cash = normalizeField(current.balance_sheet.cash_and_cash_equivalents);
  const inventories = normalizeField(current.balance_sheet.inventories);
  const totalAssets = normalizeField(current.balance_sheet.total_assets);
  const totalLiabilities = normalizeField(current.balance_sheet.total_liabilities);
  const equity = normalizeField(current.balance_sheet.equity);
  const prevAssets = previous ? normalizeField(previous.balance_sheet.total_assets) : null;
  const prevEquity = previous ? normalizeField(previous.balance_sheet.equity) : null;

  const liquidity = {
    current_ratio: safeDivide(currentAssets, currentLiabilities),
    quick_ratio: safeDivide(currentAssets - inventories, currentLiabilities),
    absolute_ratio: safeDivide(cash, currentLiabilities),
  };

  const profitability = {
    roa: safeDivide(current.income_statement.net_income * 100, average(totalAssets, prevAssets)),
    roe: safeDivide(current.income_statement.net_income * 100, average(equity, prevEquity)),
    gross_margin: revenue === 0 ? null : ((revenue - cogs) / revenue) * 100,
    net_margin: revenue === 0 ? null : (normalizeField(current.income_statement.net_income) / revenue) * 100,
  };

  const stability = {
    autonomy: safeDivide(equity * 100, totalAssets),
    financial_leverage: safeDivide(totalAssets, equity),
    debt_ratio: safeDivide(totalLiabilities * 100, totalAssets),
    debt_to_equity: safeDivide(totalLiabilities, equity),
  };

  return {
    ofc: { poi, ppd, ppa, ofc },
    liquidity,
    profitability,
    stability,
    normalized: { current, previous },
  };
}

async function fetchCheckoFinancials(inn, year, forceMock) {
  if (forceMock || MOCK_MODE) {
    return pickReport(year);
  }

  const queryUrl = `${CHECKO_BASE_URL}/${encodeURIComponent(inn)}/financials?year=${year}&key=${encodeURIComponent(CHECKO_API_KEY)}`;
  return httpGetJson(queryUrl);
}

async function handleAnalyze(req, res) {
  try {
    const body = await parseBody(req);
    const { inn, year, previousYear, forceMock } = body;

    if (!inn || !year) {
      respondJson(res, 400, { error: 'Необходимо указать ИНН и год для анализа.' });
      return;
    }

    const prevYear = previousYear || Number(year) - 1;
    const mock = forceMock === true || forceMock === 'true';

    const [currentReport, prevReport] = await Promise.all([
      fetchCheckoFinancials(inn, year, mock),
      fetchCheckoFinancials(inn, prevYear, mock),
    ]);

    const metrics = calculateMetrics(currentReport, prevReport);

    respondJson(res, 200, {
      meta: {
        inn,
        year,
        previousYear: prevYear,
        source: mock || MOCK_MODE ? 'Демонстрационные данные' : 'Checko API',
        mockMode: mock || MOCK_MODE,
      },
      metrics,
      statements: {
        current: metrics.normalized.current,
        previous: metrics.normalized.previous,
      },
    });
  } catch (error) {
    console.error('Ошибка при анализе ОФЦ', error);
    respondJson(res, 500, { error: 'Не удалось выполнить анализ', details: error.message });
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (req.method === 'GET' && parsedUrl.pathname === '/api/health') {
    respondJson(res, 200, { status: 'ok', mockMode: MOCK_MODE });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/analyze') {
    handleAnalyze(req, res);
    return;
  }

  serveStatic(req, res, parsedUrl);
});

server.listen(PORT, () => {
  console.log(`OFC analyzer server listening on port ${PORT}`);
});
