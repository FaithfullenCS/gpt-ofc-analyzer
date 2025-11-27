const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const net = require('net');

const PORT = process.env.PORT || 3000;
const CHECKO_API_KEY = process.env.CHECKO_API_KEY;
const CHECKO_BASE_URL = process.env.CHECKO_API_BASE || 'https://api.checko.ru/v3/companies';
const MOCK_MODE = process.env.CHECKO_MOCK_MODE === 'true';
const DAILY_LIMIT = Number(process.env.CHECKO_DAILY_LIMIT || 100);

const sampleDataPath = path.join(__dirname, 'data', 'sample-financials.json');
let sampleReports = [];
try {
  const sampleContent = fs.readFileSync(sampleDataPath, 'utf8');
  sampleReports = JSON.parse(sampleContent);
} catch (error) {
  sampleReports = [];
}

let usedRequests = 0;

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
        const preview = data ? data.slice(0, 200) : '';

        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (error) {
            reject(new Error(`Не удалось разобрать ответ API (${preview || 'пустой ответ'})`));
          }
          return;
        }

        reject(new Error(`API вернул код ${res.statusCode || 500}: ${preview || 'без тела ответа'}`));
      });
    });

    request.on('error', err => reject(new Error(`Ошибка сети при обращении к API: ${err.message}`)));
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

function requiredSections(selections = []) {
  const set = new Set(selections);
  set.add('balance_sheet');
  set.add('income_statement');
  set.add('extended');
  return Array.from(set);
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

function increaseUsage(count) {
  usedRequests += count;
  if (usedRequests < 0) usedRequests = 0;
}

function remainingRequests() {
  const remaining = DAILY_LIMIT - usedRequests;
  return remaining > 0 ? remaining : 0;
}

function estimatedRequests(innCount, periodCount) {
  return innCount * Math.max(periodCount, 0);
}

async function fetchCheckoFinancials(inn, year, options = {}) {
  const { forceMock = false, sections = [], quarter } = options;
  if (forceMock || MOCK_MODE) {
    return pickReport(year);
  }

  if (!CHECKO_API_KEY) {
    throw new Error('CHECKO_API_KEY не задан. Укажите ключ или включите демо-режим.');
  }

  const params = new url.URLSearchParams({
    year,
    key: CHECKO_API_KEY,
    extended: '1',
  });

  if (quarter) {
    params.append('period', 'quarter');
    params.append('quarter', quarter);
  }

  const normalizedSections = requiredSections(sections);
  params.append('sections', normalizedSections.join(','));

  const queryUrl = `${CHECKO_BASE_URL}/${encodeURIComponent(inn)}/financials?${params.toString()}`;
  const data = await httpGetJson(queryUrl);
  increaseUsage(1);
  return data;
}

async function handleAnalyze(req, res) {
  try {
    const body = await parseBody(req);
    const { inns = [], inn, periods = [], year, previousYear, forceMock, sections = [] } = body;

    const innList = Array.isArray(inns) ? inns.filter(Boolean) : [];
    if (inn && !innList.includes(inn)) {
      innList.push(inn);
    }

    let periodList = Array.isArray(periods) ? periods.filter(p => p && p.year) : [];
    if (!periodList.length && year) {
      periodList.push({ year });
    }
    if (!periodList.length) {
      respondJson(res, 400, { error: 'Необходимо указать хотя бы один период (год или квартал).' });
      return;
    }
    if (previousYear && !periodList.find(p => Number(p.year) === Number(previousYear))) {
      periodList.push({ year: previousYear });
    }

    const sortedPeriods = periodList
      .map(p => ({ year: Number(p.year), quarter: p.quarter ? Number(p.quarter) : undefined }))
      .sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        const aq = a.quarter || 5;
        const bq = b.quarter || 5;
        return aq - bq;
      });

    if (!innList.length) {
      respondJson(res, 400, { error: 'Необходимо указать хотя бы один ИНН.' });
      return;
    }

    const mock = forceMock === true || forceMock === 'true';
    const neededRequests = mock ? 0 : estimatedRequests(innList.length, sortedPeriods.length);

    if (!mock && remainingRequests() < neededRequests) {
      respondJson(res, 429, {
        error: 'Недостаточно суточного лимита API для выполнения запроса.',
        required: neededRequests,
        remaining: remainingRequests(),
      });
      return;
    }

    const normalizedSections = requiredSections(sections);

    const computations = await Promise.all(
      innList.map(async candidateInn => {
        const perPeriod = [];
        let previousReport = null;

        for (const period of sortedPeriods) {
          const currentReport = await fetchCheckoFinancials(candidateInn, period.year, {
            forceMock: mock,
            sections: normalizedSections,
            quarter: period.quarter,
          });

          const metrics = calculateMetrics(currentReport, previousReport);
          perPeriod.push({
            inn: candidateInn,
            period,
            previousPeriod: previousReport ? previousReport.__period : null,
            source: mock || MOCK_MODE ? 'Демонстрационные данные' : 'Checko API',
            metrics,
            statements: {
              current: metrics.normalized.current,
              previous: metrics.normalized.previous,
            },
          });

          previousReport = { ...currentReport, __period: period };
        }

        return {
          inn: candidateInn,
          periods: perPeriod,
        };
      })
    );

    respondJson(res, 200, {
      meta: {
        mockMode: mock || MOCK_MODE,
        sections: normalizedSections,
        used: usedRequests,
        limit: DAILY_LIMIT,
      },
      results: computations,
    });
  } catch (error) {
    console.error('Ошибка при анализе ОФЦ', error);
    respondJson(res, 502, { error: 'Не удалось выполнить анализ', details: error.message });
  }
}

function requestListener(req, res) {
  const parsedUrl = url.parse(req.url, true);

  if (req.method === 'GET' && parsedUrl.pathname === '/api/health') {
    respondJson(res, 200, { status: 'ok', mockMode: MOCK_MODE, limit: DAILY_LIMIT, used: usedRequests });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/quota') {
    respondJson(res, 200, { limit: DAILY_LIMIT, used: usedRequests, remaining: remainingRequests() });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/estimate') {
    parseBody(req)
      .then(body => {
        const { inns = [], periods = [] } = body;
        const innCount = Array.isArray(inns) ? inns.filter(Boolean).length : 0;
        const periodCount = Array.isArray(periods) ? periods.filter(p => p && p.year).length : 0;
        const required = estimatedRequests(innCount, periodCount);
        respondJson(res, 200, { required, remaining: remainingRequests(), limit: DAILY_LIMIT });
      })
      .catch(() => respondJson(res, 400, { error: 'Некорректное тело запроса' }));
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/check-connection') {
    const socket = net.connect(443, 'api.checko.ru');
    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.destroy();
      respondJson(res, 200, { ok: true });
    });
    socket.on('error', (err) => {
      respondJson(res, 503, { ok: false, error: err.message });
    });
    socket.on('timeout', () => {
      socket.destroy();
      respondJson(res, 504, { ok: false, error: 'Таймаут соединения' });
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/analyze') {
    handleAnalyze(req, res);
    return;
  }

  if (parsedUrl.pathname.startsWith('/api/')) {
    respondJson(res, 404, { error: 'Неизвестный API-маршрут', path: parsedUrl.pathname });
    return;
  }

  serveStatic(req, res, parsedUrl);
}

if (require.main === module) {
  const server = http.createServer(requestListener);
  server.listen(PORT, () => {
    console.log(`OFC analyzer server listening on port ${PORT}`);
  });
}

module.exports = requestListener;
