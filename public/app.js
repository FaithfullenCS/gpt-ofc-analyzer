const form = document.getElementById('analysis-form');
const statusBox = document.getElementById('status');
const resultsBlock = document.getElementById('results');
const quotaStats = document.getElementById('quota-stats');
const localEstimateBox = document.getElementById('local-estimate');
const estimateButton = document.getElementById('estimate');
const connectionButton = document.getElementById('check-connection');
const themeToggle = document.getElementById('theme-toggle');
const apiBaseInput = document.getElementById('api-base');
const innsInput = document.querySelector('textarea[name="inns"]');
const periodsInput = document.querySelector('textarea[name="periods"]');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  themeToggle.textContent = theme === 'light' ? 'Тёмная тема' : 'Светлая тема';
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  const preferred = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(preferred);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(number);
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    const preview = text ? text.slice(0, 160) : 'пустой ответ';
    throw new Error(`Некорректный ответ сервера: ${preview}`);
  }
}

function showStatus(type, message) {
  statusBox.textContent = message;
  statusBox.className = `notice ${type}`;
  statusBox.classList.remove('hidden');
}

function clearStatus() {
  statusBox.textContent = '';
  statusBox.className = 'notice hidden';
}

function renderMetrics(container, metrics) {
  container.innerHTML = '';
  metrics.forEach(item => {
    const card = document.createElement('div');
    card.className = 'metric';
    card.innerHTML = `<span>${item.label}</span><strong>${formatNumber(item.value, item.digits)}${item.suffix || ''}</strong>${item.note ? `<small>${item.note}</small>` : ''}`;
    container.appendChild(card);
  });
}

function sanitizeBase(value) {
  if (!value) return window.location.origin;
  try {
    const normalized = value.trim();
    const urlObj = new URL(normalized.includes('://') ? normalized : `https://${normalized}`);
    return urlObj.origin;
  } catch (error) {
    return window.location.origin;
  }
}

function getApiBase() {
  return sanitizeBase(apiBaseInput?.value || localStorage.getItem('apiBase'));
}

function initApiBase() {
  const saved = localStorage.getItem('apiBase');
  const base = sanitizeBase(saved || window.location.origin);
  if (apiBaseInput) {
    apiBaseInput.value = base;
  }
}

function persistApiBase() {
  if (!apiBaseInput) return;
  const base = sanitizeBase(apiBaseInput.value);
  apiBaseInput.value = base;
  localStorage.setItem('apiBase', base);
}

function apiFetch(path, options) {
  const base = getApiBase();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return fetch(`${base}${normalizedPath}`, options);
}

function renderStatement(target, data) {
  if (!data) {
    target.innerHTML = '<p class="help">Нет данных.</p>';
    return;
  }
  const { balance_sheet: b, income_statement: i } = data;
  const rows = [
    { label: 'Выручка', value: i?.revenue },
    { label: 'Себестоимость', value: i?.cost_of_goods_sold },
    { label: 'Чистая прибыль', value: i?.net_income },
    { label: 'Запасы', value: b?.inventories },
    { label: 'Дебиторская задолженность', value: b?.accounts_receivable },
    { label: 'Кредиторская задолженность', value: b?.accounts_payable },
    { label: 'Текущие активы', value: b?.current_assets },
    { label: 'Текущие обязательства', value: b?.current_liabilities },
    { label: 'Денежные средства', value: b?.cash_and_cash_equivalents },
    { label: 'Итого активы', value: b?.total_assets },
    { label: 'Итого обязательства', value: b?.total_liabilities },
    { label: 'Собственный капитал', value: b?.equity },
  ];

  target.innerHTML = rows.map(row => `<div class="row"><span class="label">${row.label}</span><span>${formatNumber(row.value, 0)}</span></div>`).join('');
}

function formatPeriod(period) {
  if (!period) return '—';
  return period.quarter ? `${period.year} Q${period.quarter}` : `${period.year}`;
}

function renderCompany(result) {
  const wrapper = document.createElement('section');
  wrapper.className = 'card company-block';

  const header = document.createElement('div');
  header.className = 'company-header';
  header.innerHTML = `<div><p class="badge">ИНН ${result.inn}</p><h3>Отчёты: ${result.periods.length} период(ов)</h3><p class="muted">Источник: ${result.periods[0]?.source || '—'}</p></div>`;
  wrapper.appendChild(header);

  result.periods.forEach(periodBlock => {
    const block = document.createElement('div');
    block.className = 'period-block';
    block.innerHTML = `<h3>${formatPeriod(periodBlock.period)}${periodBlock.previousPeriod ? ` (сравнение с ${formatPeriod(periodBlock.previousPeriod)})` : ''}</h3>`;

    const metricsGrid = document.createElement('div');
    metricsGrid.className = 'grid two-columns';

    const ofcCard = document.createElement('div');
    ofcCard.className = 'card nested';
    ofcCard.innerHTML = '<h4>Операционный финансовый цикл</h4>';
    const ofcMetrics = document.createElement('div');
    ofcMetrics.className = 'metrics';
    renderMetrics(ofcMetrics, [
      { label: 'POI (оборот запасов)', value: periodBlock.metrics.ofc.poi, suffix: ' дн.' },
      { label: 'PPD (оплата дебиторов)', value: periodBlock.metrics.ofc.ppd, suffix: ' дн.' },
      { label: 'PPA (оплата кредиторов)', value: periodBlock.metrics.ofc.ppa, suffix: ' дн.' },
      { label: 'OFC', value: periodBlock.metrics.ofc.ofc, suffix: ' дн.', note: 'POI + PPD - PPA' },
    ]);
    ofcCard.appendChild(ofcMetrics);

    const liquidityCard = document.createElement('div');
    liquidityCard.className = 'card nested';
    liquidityCard.innerHTML = '<h4>Ликвидность</h4>';
    const liquidityMetrics = document.createElement('div');
    liquidityMetrics.className = 'metrics';
    renderMetrics(liquidityMetrics, [
      { label: 'Current Ratio', value: periodBlock.metrics.liquidity.current_ratio },
      { label: 'Quick Ratio', value: periodBlock.metrics.liquidity.quick_ratio },
      { label: 'Absolute Ratio', value: periodBlock.metrics.liquidity.absolute_ratio },
    ]);
    liquidityCard.appendChild(liquidityMetrics);

    const profitabilityCard = document.createElement('div');
    profitabilityCard.className = 'card nested';
    profitabilityCard.innerHTML = '<h4>Рентабельность</h4>';
    const profitabilityMetrics = document.createElement('div');
    profitabilityMetrics.className = 'metrics';
    renderMetrics(profitabilityMetrics, [
      { label: 'ROA', value: periodBlock.metrics.profitability.roa, suffix: ' %' },
      { label: 'ROE', value: periodBlock.metrics.profitability.roe, suffix: ' %' },
      { label: 'Gross Margin', value: periodBlock.metrics.profitability.gross_margin, suffix: ' %' },
      { label: 'Net Margin', value: periodBlock.metrics.profitability.net_margin, suffix: ' %' },
    ]);
    profitabilityCard.appendChild(profitabilityMetrics);

    const stabilityCard = document.createElement('div');
    stabilityCard.className = 'card nested';
    stabilityCard.innerHTML = '<h4>Финансовая устойчивость</h4>';
    const stabilityMetrics = document.createElement('div');
    stabilityMetrics.className = 'metrics';
    renderMetrics(stabilityMetrics, [
      { label: 'Autonomy', value: periodBlock.metrics.stability.autonomy, suffix: ' %' },
      { label: 'Financial Leverage', value: periodBlock.metrics.stability.financial_leverage },
      { label: 'Debt Ratio', value: periodBlock.metrics.stability.debt_ratio, suffix: ' %' },
      { label: 'D/E Ratio', value: periodBlock.metrics.stability.debt_to_equity },
    ]);
    stabilityCard.appendChild(stabilityMetrics);

    metricsGrid.appendChild(ofcCard);
    metricsGrid.appendChild(liquidityCard);
    metricsGrid.appendChild(profitabilityCard);
    metricsGrid.appendChild(stabilityCard);
    block.appendChild(metricsGrid);

    const statements = document.createElement('div');
    statements.className = 'statements-grid';
    const currentCol = document.createElement('div');
    currentCol.innerHTML = `<h4>Текущий период (${formatPeriod(periodBlock.period)})</h4>`;
    const currentStatement = document.createElement('div');
    currentStatement.className = 'statement';
    renderStatement(currentStatement, periodBlock.statements.current);
    currentCol.appendChild(currentStatement);

    const prevCol = document.createElement('div');
    prevCol.innerHTML = `<h4>База сравнения (${formatPeriod(periodBlock.previousPeriod)})</h4>`;
    const prevStatement = document.createElement('div');
    prevStatement.className = 'statement';
    renderStatement(prevStatement, periodBlock.statements.previous);
    prevCol.appendChild(prevStatement);

    statements.appendChild(currentCol);
    statements.appendChild(prevCol);
    block.appendChild(statements);

    wrapper.appendChild(block);
  });

  return wrapper;
}

function renderResults(results) {
  resultsBlock.innerHTML = '';
  if (!Array.isArray(results) || !results.length) {
    resultsBlock.classList.add('hidden');
    return;
  }
  results.forEach(item => resultsBlock.appendChild(renderCompany(item)));
  resultsBlock.classList.remove('hidden');
}

function parseInns(value) {
  return value
    .split(/\n|,|;/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parsePeriods(value) {
  return value
    .split(/\n|,|;/)
    .map(item => item.trim())
    .filter(Boolean)
    .map(raw => {
      const match = raw.match(/^(\d{4})(?:[-/]?Q?(\d))?$/i);
      if (!match) return null;
      const year = Number(match[1]);
      const quarter = match[2] ? Number(match[2]) : undefined;
      return { year, quarter };
    })
    .filter(Boolean);
}

function renderLocalEstimate() {
  const inns = parseInns(innsInput?.value || '');
  const periods = parsePeriods(periodsInput?.value || '');
  const required = inns.length;

  localEstimateBox.innerHTML = `<div class="row"><span>Локальная оценка</span><strong>${required || '—'} запросов</strong></div><div class="row"><span>По одному запросу на ИНН</span><strong>${inns.length} ИНН, ${periods.length} период(ов)</strong></div>`;
}

async function refreshQuota() {
  try {
    const response = await apiFetch('/api/quota');
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || 'Ошибка обновления лимита');
    quotaStats.innerHTML = `<div class="row"><span>Использовано</span><strong>${data.used} из ${data.limit}</strong></div><div class="row"><span>Остаток</span><strong>${data.remaining}</strong></div>`;
  } catch (error) {
    quotaStats.innerHTML = `<p class="help">${error.message}</p>`;
  }
}

function describePeriods(periods) {
  if (!periods.length) return '—';
  return periods
    .map(p => (p.quarter ? `${p.year} Q${p.quarter}` : `${p.year}`))
    .join(', ');
}

async function estimateRequests() {
  clearStatus();
  const formData = new FormData(form);
  const inns = parseInns(formData.get('inns') || '');
  const periods = parsePeriods(formData.get('periods') || '');
  const payload = { inns, periods };

  try {
    const response = await apiFetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(data.error || 'Не удалось оценить запросы');
    showStatus(
      'info',
      `Потребуется ~${data.required} запросов (1 запрос на ИНН: ${inns.length} шт., периодов: ${periods.length}). Остаток лимита: ${data.remaining}/${data.limit}.`
    );
  } catch (error) {
    showStatus('error', error.message);
  }
}

async function checkConnection() {
  clearStatus();
  try {
    const response = await apiFetch('/api/check-connection');
    const data = await parseJsonResponse(response);
    if (!response.ok || !data.ok) throw new Error(data.error || 'Соединение недоступно');
    showStatus('success', 'Соединение с api.checko.ru установлено без расхода лимита.');
  } catch (error) {
    showStatus('error', error.message);
  }
}

async function analyze(event) {
  event.preventDefault();
  clearStatus();
  resultsBlock.classList.add('hidden');

  const formData = new FormData(form);
  const inns = parseInns(formData.get('inns') || '');
  const periods = parsePeriods(formData.get('periods') || '');
  const payload = {
    inns,
    periods,
  };

  if (formData.get('mockMode') === 'true') {
    payload.forceMock = true;
  }

  renderLocalEstimate();

  showStatus('info', 'Выполняем расчёты...');

  try {
    const response = await apiFetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await parseJsonResponse(response);
    if (!response.ok) {
      const details = data.details ? `: ${data.details}` : '';
      throw new Error((data.error || 'Неизвестная ошибка') + details);
    }

    renderResults(data.results);
    const paramsHint = data.meta?.params?.length ? ` Параметры API: ${data.meta.params.join(', ')}.` : '';
    const baseHint = data.meta?.baseUrl ? ` База: ${data.meta.baseUrl}.` : '';
    showStatus(
      'success',
      `Запрос выполнен. Периоды: ${describePeriods(periods)}.${paramsHint}${baseHint} Использовано ${data.meta.used}/${data.meta.limit}.`
    );
    refreshQuota();
  } catch (error) {
    console.error(error);
    showStatus('error', error.message || 'Не удалось выполнить запрос');
  }
}

form.addEventListener('submit', analyze);
estimateButton.addEventListener('click', estimateRequests);
connectionButton.addEventListener('click', checkConnection);
innsInput.addEventListener('input', renderLocalEstimate);
periodsInput.addEventListener('input', renderLocalEstimate);
apiBaseInput?.addEventListener('change', () => {
  persistApiBase();
  refreshQuota();
});
themeToggle.addEventListener('click', toggleTheme);
initApiBase();
initTheme();
refreshQuota();
renderLocalEstimate();
