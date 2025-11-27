const form = document.getElementById('analysis-form');
const statusBox = document.getElementById('status');
const resultsBlock = document.getElementById('results');
const quotaStats = document.getElementById('quota-stats');
const estimateButton = document.getElementById('estimate');
const connectionButton = document.getElementById('check-connection');

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(number);
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

function renderCompany(result) {
  const wrapper = document.createElement('section');
  wrapper.className = 'card company-block';

  const header = document.createElement('div');
  header.className = 'company-header';
  header.innerHTML = `<div><p class="badge">${result.source}</p><h3>ИНН ${result.inn}</h3><p class="muted">Год ${result.year}, предыдущий ${result.previousYear}</p></div>`;
  wrapper.appendChild(header);

  const metricsGrid = document.createElement('div');
  metricsGrid.className = 'grid two-columns';

  const ofcCard = document.createElement('div');
  ofcCard.className = 'card nested';
  ofcCard.innerHTML = '<h4>Операционный финансовый цикл</h4>';
  const ofcMetrics = document.createElement('div');
  ofcMetrics.className = 'metrics';
  renderMetrics(ofcMetrics, [
    { label: 'POI (оборот запасов)', value: result.metrics.ofc.poi, suffix: ' дн.' },
    { label: 'PPD (оплата дебиторов)', value: result.metrics.ofc.ppd, suffix: ' дн.' },
    { label: 'PPA (оплата кредиторов)', value: result.metrics.ofc.ppa, suffix: ' дн.' },
    { label: 'OFC', value: result.metrics.ofc.ofc, suffix: ' дн.', note: 'POI + PPD - PPA' },
  ]);
  ofcCard.appendChild(ofcMetrics);

  const liquidityCard = document.createElement('div');
  liquidityCard.className = 'card nested';
  liquidityCard.innerHTML = '<h4>Ликвидность</h4>';
  const liquidityMetrics = document.createElement('div');
  liquidityMetrics.className = 'metrics';
  renderMetrics(liquidityMetrics, [
    { label: 'Current Ratio', value: result.metrics.liquidity.current_ratio },
    { label: 'Quick Ratio', value: result.metrics.liquidity.quick_ratio },
    { label: 'Absolute Ratio', value: result.metrics.liquidity.absolute_ratio },
  ]);
  liquidityCard.appendChild(liquidityMetrics);

  const profitabilityCard = document.createElement('div');
  profitabilityCard.className = 'card nested';
  profitabilityCard.innerHTML = '<h4>Рентабельность</h4>';
  const profitabilityMetrics = document.createElement('div');
  profitabilityMetrics.className = 'metrics';
  renderMetrics(profitabilityMetrics, [
    { label: 'ROA', value: result.metrics.profitability.roa, suffix: ' %' },
    { label: 'ROE', value: result.metrics.profitability.roe, suffix: ' %' },
    { label: 'Gross Margin', value: result.metrics.profitability.gross_margin, suffix: ' %' },
    { label: 'Net Margin', value: result.metrics.profitability.net_margin, suffix: ' %' },
  ]);
  profitabilityCard.appendChild(profitabilityMetrics);

  const stabilityCard = document.createElement('div');
  stabilityCard.className = 'card nested';
  stabilityCard.innerHTML = '<h4>Финансовая устойчивость</h4>';
  const stabilityMetrics = document.createElement('div');
  stabilityMetrics.className = 'metrics';
  renderMetrics(stabilityMetrics, [
    { label: 'Autonomy', value: result.metrics.stability.autonomy, suffix: ' %' },
    { label: 'Financial Leverage', value: result.metrics.stability.financial_leverage },
    { label: 'Debt Ratio', value: result.metrics.stability.debt_ratio, suffix: ' %' },
    { label: 'D/E Ratio', value: result.metrics.stability.debt_to_equity },
  ]);
  stabilityCard.appendChild(stabilityMetrics);

  metricsGrid.appendChild(ofcCard);
  metricsGrid.appendChild(liquidityCard);
  metricsGrid.appendChild(profitabilityCard);
  metricsGrid.appendChild(stabilityCard);
  wrapper.appendChild(metricsGrid);

  const statements = document.createElement('div');
  statements.className = 'statements-grid';
  const currentCol = document.createElement('div');
  currentCol.innerHTML = `<h4>Текущий год (${result.year})</h4>`;
  const currentStatement = document.createElement('div');
  currentStatement.className = 'statement';
  renderStatement(currentStatement, result.statements.current);
  currentCol.appendChild(currentStatement);

  const prevCol = document.createElement('div');
  prevCol.innerHTML = `<h4>Предыдущий год (${result.previousYear})</h4>`;
  const prevStatement = document.createElement('div');
  prevStatement.className = 'statement';
  renderStatement(prevStatement, result.statements.previous);
  prevCol.appendChild(prevStatement);

  statements.appendChild(currentCol);
  statements.appendChild(prevCol);
  wrapper.appendChild(statements);

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

async function refreshQuota() {
  try {
    const response = await fetch('/api/quota');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка обновления лимита');
    quotaStats.innerHTML = `<div class="row"><span>Использовано</span><strong>${data.used} из ${data.limit}</strong></div><div class="row"><span>Остаток</span><strong>${data.remaining}</strong></div>`;
  } catch (error) {
    quotaStats.innerHTML = `<p class="help">${error.message}</p>`;
  }
}

async function estimateRequests() {
  clearStatus();
  const formData = new FormData(form);
  const inns = parseInns(formData.get('inns') || '');
  const payload = { inns, includePreviousYear: true };

  try {
    const response = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось оценить запросы');
    showStatus('info', `Потребуется ~${data.required} запросов. Остаток лимита: ${data.remaining}/${data.limit}.`);
  } catch (error) {
    showStatus('error', error.message);
  }
}

async function checkConnection() {
  clearStatus();
  try {
    const response = await fetch('/api/check-connection');
    const data = await response.json();
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
  const sections = formData.getAll('sections');
  const payload = {
    inns,
    year: formData.get('year'),
    previousYear: formData.get('previousYear') || undefined,
    sections,
  };

  if (formData.get('mockMode') === 'true') {
    payload.forceMock = true;
  }

  showStatus('info', 'Выполняем расчёты...');

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Неизвестная ошибка');
    }

    renderResults(data.results);
    showStatus('success', `Запрос выполнен. Секции: ${data.meta.sections.join(', ')}. Использовано ${data.meta.used}/${data.meta.limit}.`);
    refreshQuota();
  } catch (error) {
    console.error(error);
    showStatus('error', error.message || 'Не удалось выполнить запрос');
  }
}

form.addEventListener('submit', analyze);
estimateButton.addEventListener('click', estimateRequests);
connectionButton.addEventListener('click', checkConnection);
refreshQuota();
