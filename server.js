const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');
const net = require('net');

const PORT = process.env.PORT || 3000;
const CHECKO_API_KEY = process.env.CHECKO_API_KEY;
const CHECKO_BASE_URL = process.env.CHECKO_API_BASE || 'https://api.checko.ru/v2/finances';
const MOCK_MODE = process.env.CHECKO_MOCK_MODE === 'true';
const DAILY_LIMIT = Number(process.env.CHECKO_DAILY_LIMIT || 100);

const parsedCheckoBase = (() => {
  try {
    return new URL(CHECKO_BASE_URL);
  } catch (error) {
    return null;
  }
})();
const CHECKO_HOST = parsedCheckoBase?.hostname || 'api.checko.ru';
const CHECKO_PORT = parsedCheckoBase?.port || (parsedCheckoBase?.protocol === 'http:' ? 80 : 443);

const sampleDataPath = path.join(__dirname, 'data', 'sample-financials.json');
let sampleReports = [];
try {
  const sampleContent = fs.readFileSync(sampleDataPath, 'utf8');
  sampleReports = JSON.parse(sampleContent);
} catch (error) {
  sampleReports = [];
}

let usedRequests = 0;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

function respondJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
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

function normalizeLookup(source) {
  if (Array.isArray(source)) {
    return source.reduce((acc, item) => {
      if (!item) return acc;
      if (item.code) {
        acc[item.code] = item.value ?? item.amount ?? item.sum ?? item.total;
      }
      if (item.name) {
        acc[item.name] = item.value ?? item.amount ?? item.sum ?? item.total;
      }
      return acc;
    }, {});
  }
  return source || {};
}

function extractValue(source, preferredKeys) {
  const lookup = normalizeLookup(source);
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(lookup, key) && lookup[key] !== null && lookup[key] !== undefined) {
      return lookup[key];
    }
  }
  return 0;
}

function detectPeriod(report = {}) {
  const period = report.period || report.report_period || {};
  const year = report.year ?? period.year ?? report.report_year ?? report.fiscal_year ?? report.fy;
  const quarter = report.quarter ?? period.quarter ?? report.report_quarter ?? report.fiscal_quarter;
  return {
    year: year !== undefined && year !== null ? Number(year) : undefined,
    quarter: quarter !== undefined && quarter !== null ? Number(quarter) : undefined,
  };
}

function normalizeReport(raw) {
  const period = detectPeriod(raw);
  const finances = raw.finances || raw.financials || {};
  const balance = raw.balance_sheet || raw.balance || finances.balance_sheet || finances.balance || raw.balance_form || {};
  const income =
    raw.income_statement || raw.income || finances.income_statement || finances.income || raw.financial_results || raw.opu || {};
  const assets = raw.assets || {};

  return {
    year: period.year,
    quarter: period.quarter,
    balance_sheet: {
      inventories: extractValue(balance, ['inventories', 'stocks', 'zapasy', '1210']),
      accounts_receivable: extractValue(balance, ['accounts_receivable', 'debtors', 'debitors', '1230']),
      accounts_payable: extractValue(balance, ['accounts_payable', 'creditors', '1520']),
      current_assets: extractValue(balance, ['current_assets', '1200']),
      current_liabilities: extractValue(balance, ['current_liabilities', '1500']),
      cash_and_cash_equivalents: extractValue(balance, ['cash_and_cash_equivalents', 'cash', '1250']),
      total_assets: extractValue(balance, ['total_assets', 'assets_total', 'balance_total', 'balance', '1600', '1700']),
      total_liabilities: extractValue(balance, ['total_liabilities', 'liabilities_total', '1400', '1500', '1800']),
      equity:
        extractValue(balance, ['equity', 'capital', '1300']) || extractValue(assets, ['equity']) || extractValue(raw, ['equity']),
    },
    income_statement: {
      revenue: extractValue(income, ['revenue', 'sales', '2110']),
      cost_of_goods_sold: extractValue(income, ['cost_of_goods_sold', 'cogs', 'prime_cost', '2120']),
      gross_profit: extractValue(income, ['gross_profit', '2100']),
      net_income: extractValue(income, ['net_income', 'profit', '2400', '2500']),
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

function estimatedRequests(innCount) {
  return Math.max(innCount, 0);
}

async function fetchCheckoFinancials(params, options = {}) {
  const { inn, ogrn, kpp } = params;
  const { forceMock = false } = options;
  if (forceMock || MOCK_MODE) {
    return sampleReports;
  }

  if (!CHECKO_API_KEY) {
    throw new Error('CHECKO_API_KEY не задан. Укажите ключ или включите демо-режим.');
  }

  const query = new URLSearchParams({
    key: CHECKO_API_KEY,
    extended: 'true',
    inn,
  });

  if (ogrn) {
    query.set('ogrn', ogrn);
  }

  if (kpp) {
    query.set('kpp', kpp);
  }

  const queryUrl = `${CHECKO_BASE_URL}?${query.toString()}`;
  const data = await httpGetJson(queryUrl).catch(err => {
    throw new Error(`Ошибка запроса к Checko (${queryUrl}): ${err.message}`);
  });
  increaseUsage(1);
  return data;
}

function selectReport(finances = [], targetPeriod) {
  const matches = finances
    .map(item => ({
      report: item,
      period: detectPeriod(item),
    }))
    .filter(item => Number(item.period.year) === Number(targetPeriod.year))
    .filter(item => {
      if (targetPeriod.quarter === undefined) return true;
      return Number(item.period.quarter || 0) === Number(targetPeriod.quarter);
    });

  if (!matches.length) return null;

  if (targetPeriod.quarter === undefined) {
    const withoutQuarter = matches.find(item => !item.period.quarter);
    if (withoutQuarter) return withoutQuarter.report;
    return matches.sort((a, b) => (b.period.quarter || 0) - (a.period.quarter || 0))[0].report;
  }

  return matches[0].report;
}

function extractFinancesPayload(response) {
  const visited = new Set();
  const queue = [response];
  const prioritizedKeys = ['finances', 'data', 'items', 'reports', 'results', 'entries', 'values'];

  while (queue.length) {
    const current = queue.shift();
    if (current === null || current === undefined) continue;

    if (typeof current === 'object' && visited.has(current)) {
      continue;
    }

    if (Array.isArray(current)) {
      const looksLikeFinances = current.some(entry => {
        return (
          entry &&
          typeof entry === 'object' &&
          ('year' in entry || 'period' in entry || 'balance_sheet' in entry || 'balance' in entry || 'income_statement' in entry)
        );
      });
      if (looksLikeFinances) {
        return current;
      }
      continue;
    }

    if (typeof current === 'object') {
      visited.add(current);

      for (const key of prioritizedKeys) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          queue.push(current[key]);
        }
      }

      for (const value of Object.values(current)) {
        queue.push(value);
      }
    }
  }

  return [];
}

async function handleAnalyze(req, res) {
  try {
    const body = await parseBody(req);
    const { inns = [], inn, periods = [], year, previousYear, forceMock, ogrn, kpp } = body;

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
    const neededRequests = mock ? 0 : estimatedRequests(innList.length);

    if (!mock && remainingRequests() < neededRequests) {
      respondJson(res, 429, {
        error: 'Недостаточно суточного лимита API для выполнения запроса.',
        required: neededRequests,
        remaining: remainingRequests(),
      });
      return;
    }

    const requestParams = ['inn', 'key', 'extended=true'];
    if (ogrn) requestParams.push('ogrn');
    if (kpp) requestParams.push('kpp');

    const computations = await Promise.all(
      innList.map(async candidateInn => {
        const perPeriod = [];
        let previousReport = null;

        const response = await fetchCheckoFinancials(
          { inn: candidateInn, ogrn, kpp },
          {
            forceMock: mock,
          }
        );

        const finances = extractFinancesPayload(response);

        if (!finances.length) {
          const responseKeys = response && typeof response === 'object' ? Object.keys(response) : [];
          const hint = responseKeys.length ? ` (ключи ответа: ${responseKeys.slice(0, 5).join(', ')})` : '';
          throw new Error(`Не найдены финансовые данные для ИНН ${candidateInn}${hint}`);
        }

        for (const period of sortedPeriods) {
          const currentReport = selectReport(finances, period);

          if (!currentReport) {
            throw new Error(`Нет данных для ${candidateInn} за период ${period.year}${period.quarter ? `-Q${period.quarter}` : ''}`);
          }

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
        used: usedRequests,
        limit: DAILY_LIMIT,
        params: requestParams,
        baseUrl: CHECKO_BASE_URL,
      },
      results: computations,
    });
  } catch (error) {
    console.error('Ошибка при анализе ОФЦ', error);
    respondJson(res, 502, { error: 'Не удалось выполнить анализ', details: error.message });
  }
}

function requestListener(req, res) {
  const parsedUrl = new URL(req.url, `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS' && parsedUrl.pathname.startsWith('/api/')) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

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
        const required = estimatedRequests(innCount);
        respondJson(res, 200, { required, remaining: remainingRequests(), limit: DAILY_LIMIT });
      })
      .catch(() => respondJson(res, 400, { error: 'Некорректное тело запроса' }));
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/check-connection') {
    const socket = net.connect(CHECKO_PORT, CHECKO_HOST);
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
