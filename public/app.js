const form = document.getElementById('analysis-form');
const statusBox = document.getElementById('status');
const resultsBlock = document.getElementById('results');
const statementsBlock = document.getElementById('statements');
const ofcContainer = document.getElementById('ofc-metrics');
const liquidityContainer = document.getElementById('liquidity-metrics');
const profitabilityContainer = document.getElementById('profitability-metrics');
const stabilityContainer = document.getElementById('stability-metrics');
const currentStatement = document.getElementById('current-statement');
const previousStatement = document.getElementById('previous-statement');
const currentTitle = document.getElementById('current-year-title');
const previousTitle = document.getElementById('previous-year-title');

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

async function analyze(event) {
  event.preventDefault();
  clearStatus();
  resultsBlock.classList.add('hidden');
  statementsBlock.classList.add('hidden');

  const formData = new FormData(form);
  const payload = {
    inn: formData.get('inn'),
    year: formData.get('year'),
    previousYear: formData.get('previousYear') || undefined,
  };

  const mockMode = formData.get('mockMode');
  if (mockMode === 'true') {
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

    const { metrics, meta, statements } = data;
    showStatus('success', `Источник: ${meta.source}. ИНН ${meta.inn}, год ${meta.year} (пред. ${meta.previousYear}).`);

    renderMetrics(ofcContainer, [
      { label: 'POI (оборот запасов)', value: metrics.ofc.poi, suffix: ' дн.' },
      { label: 'PPD (оплата дебиторов)', value: metrics.ofc.ppd, suffix: ' дн.' },
      { label: 'PPA (оплата кредиторов)', value: metrics.ofc.ppa, suffix: ' дн.' },
      { label: 'OFC', value: metrics.ofc.ofc, suffix: ' дн.', note: 'POI + PPD - PPA' },
    ]);

    renderMetrics(liquidityContainer, [
      { label: 'Current Ratio', value: metrics.liquidity.current_ratio },
      { label: 'Quick Ratio', value: metrics.liquidity.quick_ratio },
      { label: 'Absolute Ratio', value: metrics.liquidity.absolute_ratio },
    ]);

    renderMetrics(profitabilityContainer, [
      { label: 'ROA', value: metrics.profitability.roa, suffix: ' %' },
      { label: 'ROE', value: metrics.profitability.roe, suffix: ' %' },
      { label: 'Gross Margin', value: metrics.profitability.gross_margin, suffix: ' %' },
      { label: 'Net Margin', value: metrics.profitability.net_margin, suffix: ' %' },
    ]);

    renderMetrics(stabilityContainer, [
      { label: 'Autonomy', value: metrics.stability.autonomy, suffix: ' %' },
      { label: 'Financial Leverage', value: metrics.stability.financial_leverage },
      { label: 'Debt Ratio', value: metrics.stability.debt_ratio, suffix: ' %' },
      { label: 'D/E Ratio', value: metrics.stability.debt_to_equity },
    ]);

    currentTitle.textContent = `Текущий год (${meta.year})`;
    previousTitle.textContent = `Предыдущий год (${meta.previousYear})`;
    renderStatement(currentStatement, statements.current);
    renderStatement(previousStatement, statements.previous);

    resultsBlock.classList.remove('hidden');
    statementsBlock.classList.remove('hidden');
  } catch (error) {
    console.error(error);
    showStatus('error', error.message || 'Не удалось выполнить запрос');
  }
}

form.addEventListener('submit', analyze);
