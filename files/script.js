let currentUser = null;
let selectedQuarter = 'Q1';
let currentEditablePrograms = []; // Stores editable programs for the current session
let isAnnualSubmitted = false;
let currentYear = parseInt(localStorage.getItem('ppaYear')) || new Date().getFullYear();
let activeReportType = null;
let isAipMode = false;
let currentAipSourceData = null;

function tryLoadAipRows(officeId) {
    return fetch(`/api/aip/${officeId}?year=${currentYear}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (data && data.rows && data.rows.length > 0) {
                currentAipSourceData = data.rows;
                const office = officeMap.get(officeId);
                return data.rows.map(row => {
                    const existing = office?.programs?.find(p => p.code === row.refCode);
                    return {
                        code: row.refCode || '',
                        name: row.program || '',
                        aipAmount: { ps: row.ps || 0, mooe: row.mooe || 0, co: row.co || 0 },
                        annualBudget: existing?.annualBudget || { ps: 0, mooe: 0, co: 0, total: 0 },
                        mfo: '',
                        performanceIndicator: ''
                    };
                });
            }
            return null;
        });
}

function isCurrentOrPastYear() {
    return currentYear <= new Date().getFullYear();
}

function setYear(year) {
    currentYear = year;
    localStorage.setItem('ppaYear', year);
    const globalSel = document.getElementById('global-year');
    if (globalSel) globalSel.value = year;
    const subtitle = document.getElementById('dashboard-subtitle');
    if (subtitle) subtitle.textContent = `Overview of all office submissions for FY ${year}`;
    if (document.getElementById('employee-view').style.display !== 'none') {
        loadEmployeeDeadline();
        syncOfficePrograms(currentUser.office).then(() => {
            switch (activeReportType) {
                case 'office-dashboard': loadOfficeDashboard(); break;
                case 'quarterly': loadReport(); break;
                case 'physical': loadPhysicalPerformance(); break;
                case 'annual': loadAnnualFinancialPerformance(); break;
                case 'aip': loadAip(); break;
            }
        });
    } else {
        refreshOfficeList().then(() => {
            const editorCard = document.getElementById('office-editor-card');
            if (editorCard && editorCard.style.display === 'block' && editingOfficeId) {
                const office = officeMap.get(editingOfficeId);
                if (office) {
                    const type = editingOfficeTab === 'quarterly' ? 'quarterly' : editingOfficeTab === 'physical' ? 'physical' : editingOfficeTab === 'annual' ? 'annual_financial' : 'aip';
                    const quarter = editingOfficeTab === 'quarterly' ? editingOfficeQuarter : '';
                    loadOfficeEditorReportTab(
                        document.getElementById('office-editor-head'),
                        document.getElementById('office-editor-body'),
                        type, quarter, office
                    );
                }
            } else {
                loadDashboardData();
            }
        });
    }
}

function populateYearSelector() {
    const thisYear = new Date().getFullYear();
    const years = [];
    for (let y = thisYear; y <= thisYear + 4; y++) years.push(y);
    const opts = years.map(y => `<option value="${y}"${y === currentYear ? ' selected' : ''}>${y}</option>`).join('');
    const globalSel = document.getElementById('global-year');
    if (globalSel) globalSel.innerHTML = opts;
}

// ──────────────────────────────────────────────
// Toast notification system
// ──────────────────────────────────────────────
function showToast(message, type, duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type || 'info'}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span><button class="toast-close" onclick="this.parentElement.remove()">&times;</button>`;

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.style.animation = 'toast-out 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return toast;
}

// ──────────────────────────────────────────────
// Loading spinner utilities
// ──────────────────────────────────────────────
function showLoading(container, message) {
  if (typeof container === 'string') container = document.getElementById(container);
  if (!container) return;
  container.innerHTML = `<div class="loading-wrap"><div class="spinner-md"></div><span>${escapeHtml(message || 'Loading...')}</span></div>`;
}

function setLoading(el, isLoading) {
  if (!el) return;
  if (isLoading) {
    el._origHtml = el.innerHTML;
    el.disabled = true;
    el.innerHTML = `<span class="loading-inline"><span class="spinner-sm"></span> ${el._origHtml || 'Saving...'}</span>`;
  } else {
    el.disabled = false;
    if (el._origHtml) el.innerHTML = el._origHtml;
  }
}

function showConfirmDialog(options) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-dialog">
                <div class="confirm-icon">${options.icon || '&#9888;'}</div>
                <h3>${options.title || 'Confirm'}</h3>
                <p>${options.message || 'Are you sure?'}</p>
                <div class="confirm-actions">
                    <button class="btn-cancel">${options.cancelText || 'Cancel'}</button>
                    <button class="${options.confirmClass || 'btn-confirm-delete'}">${options.confirmText || 'Delete'}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = (result) => { overlay.remove(); resolve(result); };
        overlay.querySelector('.btn-cancel').onclick = () => close(false);
        overlay.querySelector('.confirm-actions button:last-child').onclick = () => close(true);
        overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    });
}

// ──────────────────────────────────────────────
// Fetch with timeout
// ──────────────────────────────────────────────
function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout))
    .catch(err => {
      if (err.name === 'AbortError') {
        showToast('Server is not responding. Please try again.', 'error', 6000);
      } else {
        showToast('Connection lost. Please check your network.', 'error', 5000);
      }
      throw err;
    });
}

// Global input validation - catches invalid entries on number inputs
document.addEventListener('input', function(e) {
    if (e.target.type === 'number') {
        validateNumericInput(e.target);
    }
});

const offices = Array.isArray(window.OFFICE_DATA) ? window.OFFICE_DATA : OFFICE_DATA;
const officeMap = new Map(offices.map((office) => [office.id, office]));

// Function to create a new empty program row
function createEmptyProgram() {
    return {
        code: '',
        name: '',
        aipAmount: { ps: 0, mooe: 0, co: 0 },
        annualBudget: { ps: 0, mooe: 0, co: 0, total: 0 },
        mfo: '',
        performanceIndicator: ''
    };
}

// Function to add a new row
function addRow() {
    currentEditablePrograms.push(createEmptyProgram());
    renderCurrentReport();
}

// Function to delete a row
function deleteRow(index) {
    showConfirmDialog({
        title: 'Delete Row',
        message: 'This cannot be undone.',
        confirmText: 'Delete',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (confirmed) {
            const deletedCode = currentEditablePrograms[index]?.code;
            currentEditablePrograms.splice(index, 1);
            renderCurrentReport();
            if (isAipMode && currentAipSourceData && deletedCode) {
                const aipIdx = currentAipSourceData.findIndex(r => r.refCode === deletedCode);
                if (aipIdx !== -1) {
                    currentAipSourceData.splice(aipIdx, 1);
                    saveAipToServer(currentAipSourceData);
                }
                const office = officeMap.get(currentUser.office);
                if (office) {
                    office.programs = office.programs.filter(p => p.code !== deletedCode);
                    saveProgramsToServer(office.programs);
                }
            } else {
                saveProgramData(currentEditablePrograms);
                saveProgramsToServer(currentEditablePrograms);
            }
        }
    });
}

// Function to get the current report type and re-render
function renderCurrentReport() {
    const container = document.getElementById('report-container');
    const quarterSelect = document.getElementById('quarter-select');

    if (quarterSelect) {
        loadReport(true);
    } else if (container.querySelector('table.wide-report-table')) {
        loadPhysicalPerformance(true);
    } else if (container.querySelector('table.annual-report-table')) {
        loadAnnualFinancialPerformance(true);
    } else if (container.querySelector('table.aip-table')) {
        loadAip(true);
    }
}

// Function to save edited code/name back to programs
function saveProgramData(programs) {
    // Update the office data with edited values
    const office = officeMap.get(currentUser.office);
    if (office) {
        office.programs = programs;
    }
    return programs;
}

function validateNumericInput(input) {
    if (input.value === '' || input.value === '-') return;
    const val = parseFloat(input.value);
    if (isNaN(val) || val < 0) {
        input.classList.add('is-invalid');
        input.value = input.dataset.lastValid || '0';
        setTimeout(() => input.classList.remove('is-invalid'), 1500);
    } else {
        input.classList.remove('is-invalid');
        input.dataset.lastValid = input.value;
    }
}

function formatCurrency(value) {
    return Number(value || 0).toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatDateTime(value) {
    if (!value) {
        return '-';
    }

    return new Date(value).toLocaleString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function toTitleCase(str) {
    return str
        .toLowerCase()
        .replace(/(?:^|\s|-|&)(\w)/g, (m) => m.toUpperCase())
        .replace(/\b(Of|And|The|To|For|A|An|In|On|At|By|With)\b/gi, (m) => m.toLowerCase())
        .replace(/^./, (m) => m.toUpperCase());
}

function formatOfficeName(office) {
    const name = office.name;
    // Strip just the generic "OFFICE OF THE " prefix for readability
    const shortName = name.replace(/^OFFICE OF THE /, '');
    return office.id + ' - ' + toTitleCase(shortName);
}

function populateOfficeSelect() {
    const officeSelect = document.getElementById('office-select');
    officeSelect.innerHTML = '<option value="">-- Select your office --</option>';

    offices.forEach((office) => {
        const option = document.createElement('option');
        option.value = office.id;
        option.textContent = formatOfficeName(office);
        officeSelect.appendChild(option);
    });
}

function refreshOfficeList() {
    return fetch(`/api/offices?year=${currentYear}`)
        .then(response => response.json())
        .then(serverOffices => {
            offices.length = 0;
            serverOffices.forEach(o => offices.push(o));
            officeMap.clear();
            offices.forEach(o => officeMap.set(o.id, o));
        });
}

// Fetch offices from server to populate login dropdown
refreshOfficeList().then(() => populateOfficeSelect()).catch(() => populateOfficeSelect());

function renderQuarterOptions(activeQuarter) {
    const quarters = [
        ['Q1', 'Q1 (January - March)'],
        ['Q2', 'Q2 (April - June)'],
        ['Q3', 'Q3 (July - September)'],
        ['Q4', 'Q4 (October - December)']
    ];

    return quarters.map(([value, label]) => `
        <option value="${value}"${value === activeQuarter ? ' selected' : ''}>${label}</option>
    `).join('');
}

function loadReport(skipInit) {
    activeReportType = 'quarterly';
    if (!currentUser) {
        showToast('Please login first.', 'warning');
        return;
    }

    const quarterSelect = document.getElementById('quarter-select');
    const quarter = quarterSelect ? quarterSelect.value : selectedQuarter;
    const office = officeMap.get(currentUser.office);
    selectedQuarter = quarter;

    if (!office) {
        showToast('Office not found!', 'error');
        return;
    }

    // Initialize editable programs from office data (only on full load)
    if (!skipInit) {
        if (isCurrentOrPastYear()) {
            if (office && office.programs && office.programs.length > 0) {
                currentEditablePrograms = office.programs.map(p => ({
                    code: p.code || '',
                    name: p.name || '',
                    aipAmount: p.aipAmount || { ps: 0, mooe: 0, co: 0 },
                    annualBudget: p.annualBudget || { ps: 0, mooe: 0, co: 0, total: 0 },
                }));
            } else {
                currentEditablePrograms = [createEmptyProgram()];
            }
        } else {
            currentEditablePrograms = [createEmptyProgram()];
        }
        isAipMode = false;
        tryLoadAipRows(office.id).then(aipRows => {
            if (aipRows) {
                isAipMode = true;
                currentEditablePrograms = aipRows;
                loadReport(true);
                prefillFromSubmittedReport('quarterly', quarter).then(() => {
                    currentEditablePrograms.forEach((_, idx) => calculate(idx));
                });
            }
        });
    }

    currentEditablePrograms = currentEditablePrograms.filter(p => p.name !== 'TOTAL APPROPRIATION' && p.name !== 'TOTAL APPROPRIATIONS');

    const qTot = currentEditablePrograms.reduce((t, p) => {
        const aip = p.aipAmount || {}; const ab = p.annualBudget || {};
        const ps = ab.ps || 0, mooe = ab.mooe || 0, co = ab.co || 0;
        t.aipPs += aip.ps || 0; t.aipMooe += aip.mooe || 0; t.aipCo += aip.co || 0;
        t.abPs += ps; t.abMooe += mooe; t.abCo += co; t.abTotal += ab.total || 0;
        t.allot += (ps + mooe + co) / 4;
        return t;
    }, { aipPs: 0, aipMooe: 0, aipCo: 0, abPs: 0, abMooe: 0, abCo: 0, abTotal: 0, allot: 0 });

    const rows = currentEditablePrograms.map((program, index) => `
        <tr>
            <td>${isAipMode ? `<span id="code_${index}" style="font-weight:600;">${escapeHtml(program.code)}</span>` : `<input type="text" id="code_${index}" maxlength="20" value="${escapeHtml(program.code)}" aria-label="AIP Code" class="editable-code" oninput="saveBudget(${index})">`}</td>
            <td>${isAipMode ? `<span id="name_${index}">${escapeHtml(program.name)}</span>` : `<input type="text" id="name_${index}" maxlength="100" value="${escapeHtml(program.name)}" placeholder="Enter Program/Project" aria-label="Program/Project" class="editable-name" oninput="saveBudget(${index})">`}</td>
            <td><input type="number" id="aip_ps_${index}" min="0" step="0.01" value="${program.aipAmount?.ps || 0}" aria-label="AIP PS" class="input-number" readonly></td>
            <td><input type="number" id="aip_mooe_${index}" min="0" step="0.01" value="${program.aipAmount?.mooe || 0}" aria-label="AIP MOOE" class="input-number" readonly></td>
            <td><input type="number" id="aip_co_${index}" min="0" step="0.01" value="${program.aipAmount?.co || 0}" aria-label="AIP CO" class="input-number" readonly></td>
            <td><input type="number" id="ab_ps_${index}" min="0" step="0.01" value="${program.annualBudget?.ps || 0}" aria-label="Annual Budget PS" class="input-number" readonly></td>
            <td><input type="number" id="ab_mooe_${index}" min="0" step="0.01" value="${program.annualBudget?.mooe || 0}" aria-label="Annual Budget MOOE" class="input-number" readonly></td>
            <td><input type="number" id="ab_co_${index}" min="0" step="0.01" value="${program.annualBudget?.co || 0}" aria-label="Annual Budget CO" class="input-number" readonly></td>
            <td><input type="number" id="ab_total_${index}" min="0" step="0.01" value="${program.annualBudget?.total || 0}" aria-label="Annual Budget Total" class="input-number" readonly></td>
            <td><span id="allotment_${index}">0.00</span></td>
            <td><input type="number" id="obligations_${index}" min="0" step="0.01" oninput="calculate(${index})" aria-label="Actual obligations" class="input-number"></td>
            <td><span id="variance_${index}">0.00</span></td>
            <td><span id="absorptive_${index}">0.00%</span></td>
            <td><input type="text" id="remarks_${index}" aria-label="Remarks" class="input-text"></td>
        </tr>
    `).join('');
    const qTotalRow = `<tr class="total-row">
        <td colspan="2"><strong>TOTAL APPROPRIATION</strong></td>
        <td><strong>${qTot.aipPs.toFixed(2)}</strong></td>
        <td><strong>${qTot.aipMooe.toFixed(2)}</strong></td>
        <td><strong>${qTot.aipCo.toFixed(2)}</strong></td>
        <td><strong>${qTot.abPs.toFixed(2)}</strong></td>
        <td><strong>${qTot.abMooe.toFixed(2)}</strong></td>
        <td><strong>${qTot.abCo.toFixed(2)}</strong></td>
        <td><strong>${qTot.abTotal.toFixed(2)}</strong></td>
        <td><strong>${qTot.allot.toFixed(2)}</strong></td>
        <td><strong>0.00</strong></td>
        <td><strong>0.00</strong></td>
            <td><strong>0.00%</strong></td>
            <td></td>
        </tr>`;

    document.getElementById('report-container').innerHTML = `
        <div class="report-toolbar">
            <div>
                <h3>${office.name} — ${quarter} Report</h3>
                <select id="quarter-select" onchange="loadReport()">
                    ${renderQuarterOptions(quarter)}
                </select>
            </div>
            <div>
                <button onclick="submitReport(this)" class="btn btn-primary btn-sm">Submit</button>
            </div>
        </div>
        <div class="table-container">
        <table id="quarterly-report-table">
            <thead>
                <tr>
                    <th rowspan="2">AIP Code</th>
                    <th rowspan="2">Program / Project</th>
                    <th colspan="3">AIP Amount FY ${currentYear}</th>
                    <th colspan="4">Annual Budget Amount FY ${currentYear}</th>
                    <th rowspan="2">Allotment Released</th>
                    <th rowspan="2">Actual Obligations</th>
                    <th rowspan="2">Variance</th>
                    <th rowspan="2">Absorptive Capacity</th>
                    <th rowspan="2">Remarks</th>
                </tr>
                <tr>
                    <th>PS</th>
                    <th>MOOE</th>
                    <th>CO</th>
                    <th>PS</th>
                    <th>MOOE</th>
                    <th>CO</th>
                    <th>Total</th>
                </tr>
            </thead>
            <tbody>${rows}${qTotalRow}</tbody>
        </table>
        </div>
    `;

    if (!skipInit) {
        prefillFromSubmittedReport('quarterly', quarter);
    }

    currentEditablePrograms.forEach((_, idx) => calculate(idx));
}

function prefillFromSubmittedReport(type, quarter) {
    if (!currentUser) return Promise.resolve(false);
    const officeId = currentUser.office;
    const url = quarter
        ? `/api/reports/${officeId}?quarter=${quarter}&type=${type}&year=${currentYear}`
        : `/api/reports/${officeId}?type=${type}&year=${currentYear}`;

    return fetch(url)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
        if (!data || !data.programs) return false;
        const submitted = data.programs;

        if (type === 'quarterly') {
            submitted.forEach((prog, idx) => {
                const obligEl = document.getElementById(`obligations_${idx}`);
                const remarksEl = document.getElementById(`remarks_${idx}`);
                if (obligEl) obligEl.value = prog.obligations || 0;
                if (remarksEl) remarksEl.value = prog.remarks || '';
                calculate(idx);
            });
        } else if (type === 'physical') {
            submitted.forEach((prog, idx) => {
                const mfoEl = document.getElementById(`mfo_${idx}`);
                const piEl = document.getElementById(`pi_${idx}`);
                const remarksEl = document.getElementById(`physical_remarks_${idx}`);
                if (mfoEl) mfoEl.value = prog.mfo || '';
                if (piEl) piEl.value = prog.performanceIndicator || '';
                if (remarksEl) remarksEl.value = prog.remarks || '';
                if (prog.target) {
                    [1, 2, 3, 4].forEach(q => {
                        const el = document.getElementById(`target_${q}_${idx}`);
                        const v = prog.target[q - 1];
                        if (el) el.value = (v !== undefined && v !== null) ? v : '';
                    });
                }
                if (prog.actual) {
                    [1, 2, 3, 4].forEach(q => {
                        const el = document.getElementById(`actual_${q}_${idx}`);
                        const v = prog.actual[q - 1];
                        if (el) el.value = (v !== undefined && v !== null) ? v : '';
                    });
                }
                if (prog.targetTotal !== undefined) {
                    const totalEl = document.getElementById(`target_total_${idx}`);
                    if (totalEl) totalEl.value = prog.targetTotal;
                }
                if (prog.actualTotal !== undefined) {
                    const totalEl = document.getElementById(`actual_total_${idx}`);
                    if (totalEl) totalEl.value = prog.actualTotal;
                }
                calculatePhysical(idx);
            });
        } else if (type === 'annual_financial') {
            submitted.forEach((prog, idx) => {
                const obligEl = document.getElementById(`annual_obligations_${idx}`);
                const remarksEl = document.getElementById(`annual_remarks_${idx}`);
                const proofEl = document.getElementById(`proof_payment_${idx}`);
                if (obligEl) obligEl.textContent = formatCurrency(prog.obligations || 0);
                if (remarksEl) remarksEl.value = prog.remarks || '';
                if (proofEl) proofEl.value = prog.proofOfPayment || '';
                if (prog.annualBudget) {
                    const psEl = document.getElementById(`ab_ps_${idx}`);
                    const mooeEl = document.getElementById(`ab_mooe_${idx}`);
                    const coEl = document.getElementById(`ab_co_${idx}`);
                    const totalEl = document.getElementById(`ab_total_${idx}`);
                    if (psEl) psEl.value = prog.annualBudget.ps || 0;
                    if (mooeEl) mooeEl.value = prog.annualBudget.mooe || 0;
                    if (coEl) coEl.value = prog.annualBudget.co || 0;
                    if (totalEl) totalEl.value = prog.annualBudget.total || 0;
                }
                calculateAnnualFinancial(idx);
            });
        }
        return true;
    })
    .catch(() => false)
    .finally(() => {
        // Recalculate allotment/variance for all rows even without submitted data
        if (type === 'quarterly') {
            currentEditablePrograms.forEach((_, idx) => calculate(idx));
        } else if (type === 'physical') {
            currentEditablePrograms.forEach((_, idx) => calculatePhysical(idx));
        } else if (type === 'annual_financial') {
            currentEditablePrograms.forEach((_, idx) => calculateAnnualFinancial(idx));
        }
    });
}

function parseNumericValue(str) {
    if (!str || str.trim() === '') return NaN;
    const cleaned = str.trim().replace(/%$/, '').replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? NaN : num;
}

function autoSumPhysicalTotals(index) {
    const targetEl = document.getElementById(`target_total_${index}`);
    const actualEl = document.getElementById(`actual_total_${index}`);
    if (!targetEl || !actualEl) return;
    const targetQuarters = [1, 2, 3, 4].map(q => {
        const el = document.getElementById(`target_${q}_${index}`);
        return el ? parseNumericValue(el.value) : NaN;
    });
    const actualQuarters = [1, 2, 3, 4].map(q => {
        const el = document.getElementById(`actual_${q}_${index}`);
        return el ? parseNumericValue(el.value) : NaN;
    });
    if (targetQuarters.every(v => !isNaN(v))) {
        const sum = targetQuarters.reduce((s, v) => s + v, 0);
        targetEl.value = sum % 1 === 0 ? sum.toString() : sum.toFixed(2);
    }
    if (actualQuarters.every(v => !isNaN(v))) {
        const sum = actualQuarters.reduce((s, v) => s + v, 0);
        actualEl.value = sum % 1 === 0 ? sum.toString() : sum.toFixed(2);
    }
}

function onPhysicalQuarterInput(index) {
    autoSumPhysicalTotals(index);
    calculatePhysical(index);
}

function calculatePhysical(index) {
    const targetVal = document.getElementById(`target_total_${index}`).value.trim();
    const actualVal = document.getElementById(`actual_total_${index}`).value.trim();
    const targetNum = parseFloat(targetVal);
    const actualNum = parseFloat(actualVal);

    if (isNaN(targetNum) || isNaN(actualNum) || targetVal === '' || actualVal === '') {
        document.getElementById(`physical_variance_${index}`).value = 'N/A';
        document.getElementById(`physical_accomplishment_${index}`).value = 'N/A';
    } else {
        const variance = targetNum - actualNum;
        const accomplishment = targetNum > 0 ? (actualNum / targetNum) * 100 : 0;
        document.getElementById(`physical_variance_${index}`).value = formatCurrency(variance);
        document.getElementById(`physical_accomplishment_${index}`).value = `${accomplishment.toFixed(2)}%`;
    }
}

function autoComputePhysicalAdmin(el) {
    const row = el.closest('tr');
    if (!row) return;
    const targetTotal = parseFloat(row.querySelector('[data-field="target_total"]')?.value) || 0;
    const actualTotal = parseFloat(row.querySelector('[data-field="actual_total"]')?.value) || 0;
    const targetTotalEl = row.querySelector('[data-field="target_total"]');
    const actualTotalEl = row.querySelector('[data-field="actual_total"]');
    const hasTarget = targetTotalEl && targetTotalEl.value.trim() !== '';
    const hasActual = actualTotalEl && actualTotalEl.value.trim() !== '';
    const varianceEl = row.querySelector('[data-field="variance"]');
    const accomplishmentEl = row.querySelector('[data-field="accomplishment"]');
    if (!varianceEl || !accomplishmentEl) return;
    if (hasTarget && hasActual) {
        const variance = targetTotal - actualTotal;
        const accomplishment = targetTotal > 0 ? (actualTotal / targetTotal) * 100 : 0;
        varianceEl.value = formatCurrency(variance);
        accomplishmentEl.value = `${accomplishment.toFixed(2)}%`;
    } else {
        varianceEl.value = 'N/A';
        accomplishmentEl.value = 'N/A';
    }
}

function loadPhysicalPerformance(skipInit) {
    activeReportType = 'physical';
    if (!currentUser) {
        showToast('Please login first.', 'warning');
        return;
    }

    const office = officeMap.get(currentUser.office);

    if (!office) {
        showToast('Office not found!', 'error');
        return;
    }

    if (!skipInit) {
        if (isCurrentOrPastYear()) {
            if (office && office.programs && office.programs.length > 0) {
                currentEditablePrograms = office.programs.map(p => ({
                    code: p.code || '',
                    name: p.name || '',
                    aipAmount: p.aipAmount || { ps: 0, mooe: 0, co: 0 },
                    annualBudget: p.annualBudget || { ps: 0, mooe: 0, co: 0, total: 0 },
                    mfo: p.mfo || '',
                    performanceIndicator: p.performanceIndicator || ''
                }));
            } else {
                currentEditablePrograms = [createEmptyProgram()];
            }
        } else {
            currentEditablePrograms = [createEmptyProgram()];
        }
        isAipMode = false;
        tryLoadAipRows(office.id).then(aipRows => {
            if (aipRows) {
                isAipMode = true;
                currentEditablePrograms = aipRows.map(r => ({
                    ...r,
                    mfo: '',
                    performanceIndicator: ''
                }));
                loadPhysicalPerformance(true);
                prefillFromSubmittedReport('physical', '').then(() => {
                    currentEditablePrograms.forEach((_, idx) => calculatePhysical(idx));
                });
            }
        });
    }

    currentEditablePrograms = currentEditablePrograms.filter(p => p.name !== 'TOTAL APPROPRIATION' && p.name !== 'TOTAL APPROPRIATIONS');

    const pTot = currentEditablePrograms.reduce((t, p) => {
        const aip = p.aipAmount || {}; const ab = p.annualBudget || {};
        t.aipPs += aip.ps || 0; t.aipMooe += aip.mooe || 0; t.aipCo += aip.co || 0;
        t.abPs += ab.ps || 0; t.abMooe += ab.mooe || 0; t.abCo += ab.co || 0; t.abTotal += ab.total || 0;
        return t;
    }, { aipPs: 0, aipMooe: 0, aipCo: 0, abPs: 0, abMooe: 0, abCo: 0, abTotal: 0 });

    const rows = currentEditablePrograms.map((program, index) => `
        <tr>
            <td>${isAipMode ? `<span id="code_${index}" style="font-weight:600;">${escapeHtml(program.code)}</span>` : `<input type="text" id="code_${index}" maxlength="20" value="${escapeHtml(program.code)}" aria-label="AIP Code" class="editable-code" oninput="saveBudget(${index})">`}</td>
            <td>${isAipMode ? `<span id="name_${index}">${escapeHtml(program.name)}</span>` : `<input type="text" id="name_${index}" maxlength="100" value="${escapeHtml(program.name)}" placeholder="Enter Program/Project" aria-label="Program/Project" class="editable-name" oninput="saveBudget(${index})">`}</td>
            <td><input type="number" id="aip_ps_${index}" min="0" step="0.01" value="${program.aipAmount?.ps || 0}" aria-label="AIP PS" class="input-number" readonly></td>
            <td><input type="number" id="aip_mooe_${index}" min="0" step="0.01" value="${program.aipAmount?.mooe || 0}" aria-label="AIP MOOE" class="input-number" readonly></td>
            <td><input type="number" id="aip_co_${index}" min="0" step="0.01" value="${program.aipAmount?.co || 0}" aria-label="AIP CO" class="input-number" readonly></td>
            <td><input type="number" id="ab_ps_${index}" min="0" step="0.01" value="${program.annualBudget?.ps || 0}" aria-label="Annual Budget PS" class="input-number" readonly></td>
            <td><input type="number" id="ab_mooe_${index}" min="0" step="0.01" value="${program.annualBudget?.mooe || 0}" aria-label="Annual Budget MOOE" class="input-number" readonly></td>
            <td><input type="number" id="ab_co_${index}" min="0" step="0.01" value="${program.annualBudget?.co || 0}" aria-label="Annual Budget CO" class="input-number" readonly></td>
            <td><input type="number" id="ab_total_${index}" min="0" step="0.01" value="${program.annualBudget?.total || 0}" aria-label="Annual Budget Total" class="input-number" readonly></td>
            <td><input type="text" id="mfo_${index}" value="${escapeHtml(program.mfo)}" aria-label="MFO" class="input-text" oninput="saveBudget(${index})"></td>
            <td><input type="text" id="pi_${index}" value="${escapeHtml(program.performanceIndicator)}" aria-label="Performance indicator" class="input-text" oninput="saveBudget(${index})"></td>
            <td><input type="text" id="target_1_${index}" oninput="onPhysicalQuarterInput(${index})" class="input-number"></td>
            <td><input type="text" id="target_2_${index}" oninput="onPhysicalQuarterInput(${index})" class="input-number"></td>
            <td><input type="text" id="target_3_${index}" oninput="onPhysicalQuarterInput(${index})" class="input-number"></td>
            <td><input type="text" id="target_4_${index}" oninput="onPhysicalQuarterInput(${index})" class="input-number"></td>
            <td><input type="text" id="target_total_${index}" oninput="calculatePhysical(${index})" aria-label="Target total" class="input-number"></td>
            <td><input type="text" id="actual_1_${index}" oninput="onPhysicalQuarterInput(${index})" class="input-number"></td>
            <td><input type="text" id="actual_2_${index}" oninput="onPhysicalQuarterInput(${index})" class="input-number"></td>
            <td><input type="text" id="actual_3_${index}" oninput="onPhysicalQuarterInput(${index})" class="input-number"></td>
            <td><input type="text" id="actual_4_${index}" oninput="onPhysicalQuarterInput(${index})" class="input-number"></td>
            <td><input type="text" id="actual_total_${index}" oninput="calculatePhysical(${index})" aria-label="Actual total" class="input-number"></td>
            <td><input type="text" id="physical_variance_${index}" aria-label="Variance / Difference" class="input-number"></td>
            <td><input type="text" id="physical_accomplishment_${index}" aria-label="% of Accomplishment" class="input-number"></td>
            <td><input type="text" id="physical_remarks_${index}" aria-label="Physical remarks" class="input-text"></td>
        </tr>
    `).join('');
    const pTotalRow = `<tr class="total-row">
        <td colspan="2"><strong>TOTAL APPROPRIATION</strong></td>
        <td><strong>${pTot.aipPs.toFixed(2)}</strong></td>
        <td><strong>${pTot.aipMooe.toFixed(2)}</strong></td>
        <td><strong>${pTot.aipCo.toFixed(2)}</strong></td>
        <td><strong>${pTot.abPs.toFixed(2)}</strong></td>
        <td><strong>${pTot.abMooe.toFixed(2)}</strong></td>
        <td><strong>${pTot.abCo.toFixed(2)}</strong></td>
        <td><strong>${pTot.abTotal.toFixed(2)}</strong></td>
        <td colspan="15"></td>
    </tr>`;

    document.getElementById('report-container').innerHTML = `
        <div class="report-toolbar">
            <h3>${office.name} - Physical Performance</h3>
            <div>
                <button onclick="submitPhysicalPerformance(this)" class="btn btn-primary btn-sm">Submit</button>
            </div>
        </div>
        <div class="table-container">
        <table class="wide-report-table">
            <thead>
                <tr>
                    <th rowspan="3">AIP Code</th>
                    <th rowspan="3">Program / Project</th>
                    <th colspan="3">AIP Amount FY ${currentYear}</th>
                    <th colspan="4">Annual Budget Amount FY ${currentYear}</th>
                    <th rowspan="3">Major Final Output (MFO)</th>
                    <th rowspan="3">Performance Indicators (PIs)</th>
                    <th colspan="13">Physical Performance</th>
                </tr>
                <tr>
                    <th rowspan="2">PS</th>
                    <th rowspan="2">MOOE</th>
                    <th rowspan="2">CO</th>
                    <th rowspan="2">PS</th>
                    <th rowspan="2">MOOE</th>
                    <th rowspan="2">CO</th>
                    <th rowspan="2">Total</th>
                    <th colspan="5">Target Output</th>
                    <th colspan="5">Actual Output / Performance</th>
                    <th rowspan="2">Variance / Difference</th>
                    <th rowspan="2">% of Accomplishment</th>
                    <th rowspan="2">Remarks</th>
                </tr>
                <tr>
                    <th>Q1</th>
                    <th>Q2</th>
                    <th>Q3</th>
                    <th>Q4</th>
                    <th>Total</th>
                    <th>Q1</th>
                    <th>Q2</th>
                    <th>Q3</th>
                    <th>Q4</th>
                    <th>Total</th>
                </tr>
            </thead>
            <tbody>${rows}${pTotalRow}</tbody>
        </table>
        </div>
    `;

    if (!skipInit) {
        prefillFromSubmittedReport('physical', '');
    }

    currentEditablePrograms.forEach((_, idx) => calculatePhysical(idx));
}

function updateEmployeeTotalRow() {
    const type = activeReportType;
    const tbody = document.querySelector('#report-container tbody');
    if (!tbody) return;
    const totalRow = tbody.querySelector('.total-row');
    if (!totalRow) return;
    const dataRows = tbody.querySelectorAll('tr:not(.total-row)');
    if (dataRows.length === 0) return;

    if (type === 'physical') {
        let aipPs=0, aipMooe=0, aipCo=0, abPs=0, abMooe=0, abCo=0, abTotal=0;
        dataRows.forEach(row => {
            const g = (prefix) => parseFloat(row.querySelector(`input[id^="${prefix}"]`)?.value) || 0;
            aipPs += g('aip_ps_'); aipMooe += g('aip_mooe_'); aipCo += g('aip_co_');
            abPs += g('ab_ps_'); abMooe += g('ab_mooe_'); abCo += g('ab_co_'); abTotal += g('ab_total_');
        });
        const cells = totalRow.querySelectorAll('td, th');
        const set = (idx, val) => { if (cells[idx]) cells[idx].innerHTML = `<strong>${val}</strong>`; };
        set(1, aipPs.toFixed(2)); set(2, aipMooe.toFixed(2)); set(3, aipCo.toFixed(2));
        set(4, abPs.toFixed(2)); set(5, abMooe.toFixed(2)); set(6, abCo.toFixed(2)); set(7, abTotal.toFixed(2));
        return;
    }

    let aipPs=0, aipMooe=0, aipCo=0, abPs=0, abMooe=0, abCo=0, abTotal=0, allot=0, oblig=0;
    const isAnnual = type === 'annual';
    dataRows.forEach((row, i) => {
        const g = (prefix) => parseFloat(row.querySelector(`input[id^="${prefix}"]`)?.value) || 0;
        aipPs += g('aip_ps_'); aipMooe += g('aip_mooe_'); aipCo += g('aip_co_');
        abPs += g('ab_ps_'); abMooe += g('ab_mooe_'); abCo += g('ab_co_'); abTotal += g('ab_total_');
        if (isAnnual) {
            allot += parseFloat(row.querySelector('span[id^="annual_allotment_"]')?.textContent.replace(/[^0-9.-]/g, '')) || 0;
            oblig += parseFloat(row.querySelector('span[id^="annual_obligations_"]')?.textContent.replace(/[^0-9.-]/g, '')) || 0;
        } else {
            allot += parseFloat(row.querySelector('span[id^="allotment_"]')?.textContent.replace(/[^0-9.-]/g, '')) || 0;
            oblig += g('obligations_');
        }
    });
    const variance = allot - oblig;
    const absorptive = allot > 0 ? (oblig / allot) * 100 : 0;
    const cells = totalRow.querySelectorAll('td, th');
    const set = (idx, val) => { if (cells[idx]) cells[idx].innerHTML = `<strong>${val}</strong>`; };
    set(1, aipPs.toFixed(2)); set(2, aipMooe.toFixed(2)); set(3, aipCo.toFixed(2));
    set(4, abPs.toFixed(2)); set(5, abMooe.toFixed(2)); set(6, abCo.toFixed(2)); set(7, abTotal.toFixed(2));
    set(8, allot.toFixed(2)); set(9, oblig.toFixed(2)); set(10, variance.toFixed(2)); set(11, absorptive.toFixed(2) + '%');
}

function calculateAnnualFinancial(index) {
    const allotment = getAnnualAllotment(index);
    const obligations = parseFloat(document.getElementById(`annual_obligations_${index}`).textContent.replace(/,/g, '')) || 0;
    const variance = allotment - obligations;
    const absorptive = allotment > 0 ? (obligations / allotment) * 100 : 0;

    document.getElementById(`annual_allotment_${index}`).textContent = formatCurrency(allotment);
    document.getElementById(`annual_variance_${index}`).textContent = formatCurrency(variance);
    document.getElementById(`annual_absorptive_${index}`).textContent = `${absorptive.toFixed(2)}%`;
    updateEmployeeTotalRow();
}

function fetchAndApplyQuarterlyObligations() {
    if (!currentUser) return;
    const officeId = currentUser.office;
    const promises = ['Q1', 'Q2', 'Q3', 'Q4'].map(q =>
        fetch(`/api/reports/${officeId}?quarter=${q}&type=quarterly&year=${currentYear}`)
            .then(r => r.ok ? r.json() : null)
    );

    Promise.all(promises).then(results => {
        const totalsByCode = {};
        results.forEach(data => {
            if (!data || !data.programs) return;
            data.programs.forEach(prog => {
                if (prog.code && prog.obligations !== undefined && prog.obligations !== null && prog.obligations !== '') {
                    totalsByCode[prog.code] = (totalsByCode[prog.code] || 0) + parseFloat(prog.obligations);
                }
            });
        });

        currentEditablePrograms.forEach((program, index) => {
            const el = document.getElementById(`annual_obligations_${index}`);
            if (el && totalsByCode[program.code] !== undefined) {
                el.textContent = formatCurrency(totalsByCode[program.code]);
                calculateAnnualFinancial(index);
            }
        });
        }).catch(() => showToast('Failed to load obligation data.', 'error'));
}

function applyAnnualFinancialLock() {
    currentEditablePrograms.forEach((_, index) => {
        ['ab_ps_', 'ab_mooe_', 'ab_co_', 'ab_total_'].forEach(prefix => {
            const el = document.getElementById(`${prefix}${index}`);
            if (el) el.readOnly = true;
        });
    });
}

function loadAnnualFinancialPerformance(skipInit) {
    activeReportType = 'annual';
    if (!currentUser) {
        showToast('Please login first.', 'warning');
        return;
    }

    const office = officeMap.get(currentUser.office);

    if (!office) {
        showToast('Office not found!', 'error');
        return;
    }

    if (!skipInit) {
        if (isCurrentOrPastYear()) {
            if (office && office.programs && office.programs.length > 0) {
                currentEditablePrograms = office.programs.map(p => ({
                    code: p.code || '',
                    name: p.name || '',
                    aipAmount: p.aipAmount || { ps: 0, mooe: 0, co: 0 },
                    annualBudget: p.annualBudget || { ps: 0, mooe: 0, co: 0, total: 0 },
                }));
            } else {
                currentEditablePrograms = [createEmptyProgram()];
            }
        } else {
            currentEditablePrograms = [createEmptyProgram()];
        }
        isAipMode = false;
        tryLoadAipRows(office.id).then(aipRows => {
            if (aipRows) {
                isAipMode = true;
                currentEditablePrograms = aipRows;
                loadAnnualFinancialPerformance(true);
                prefillFromSubmittedReport('annual_financial', '').then((submitted) => {
                    isAnnualSubmitted = submitted;
                    fetchAndApplyQuarterlyObligations();
                    currentEditablePrograms.forEach((_, idx) => calculateAnnualFinancial(idx));
                    if (submitted && currentUser.role === 'office') applyAnnualFinancialLock();
                });
            }
        });
    }

    currentEditablePrograms = currentEditablePrograms.filter(p => p.name !== 'TOTAL APPROPRIATION' && p.name !== 'TOTAL APPROPRIATIONS');

    const aTot = currentEditablePrograms.reduce((t, p) => {
        const aip = p.aipAmount || {}; const ab = p.annualBudget || {};
        const ps = ab.ps || 0, mooe = ab.mooe || 0, co = ab.co || 0;
        t.aipPs += aip.ps || 0; t.aipMooe += aip.mooe || 0; t.aipCo += aip.co || 0;
        t.abPs += ps; t.abMooe += mooe; t.abCo += co; t.abTotal += ab.total || 0;
        t.allot += ps + mooe + co;
        return t;
    }, { aipPs: 0, aipMooe: 0, aipCo: 0, abPs: 0, abMooe: 0, abCo: 0, abTotal: 0, allot: 0 });

    const rows = currentEditablePrograms.map((program, index) => `
        <tr>
            <td>${isAipMode ? `<span id="code_${index}" style="font-weight:600;">${escapeHtml(program.code)}</span>` : `<input type="text" id="code_${index}" maxlength="20" value="${escapeHtml(program.code)}" aria-label="AIP Code" class="editable-code" oninput="saveBudget(${index})">`}</td>
            <td>${isAipMode ? `<span id="name_${index}">${escapeHtml(program.name)}</span>` : `<input type="text" id="name_${index}" maxlength="100" value="${escapeHtml(program.name)}" placeholder="Enter Program/Project" aria-label="Program/Project" class="editable-name" oninput="saveBudget(${index})">`}</td>
            <td><input type="number" id="aip_ps_${index}" min="0" step="0.01" value="${program.aipAmount?.ps || 0}" aria-label="AIP PS" class="input-number" readonly></td>
            <td><input type="number" id="aip_mooe_${index}" min="0" step="0.01" value="${program.aipAmount?.mooe || 0}" aria-label="AIP MOOE" class="input-number" readonly></td>
            <td><input type="number" id="aip_co_${index}" min="0" step="0.01" value="${program.aipAmount?.co || 0}" aria-label="AIP CO" class="input-number" readonly></td>
            <td><input type="number" id="ab_ps_${index}" min="0" step="0.01" value="${program.annualBudget?.ps || 0}" aria-label="Annual Budget PS" class="input-number" readonly></td>
            <td><input type="number" id="ab_mooe_${index}" min="0" step="0.01" value="${program.annualBudget?.mooe || 0}" aria-label="Annual Budget MOOE" class="input-number" readonly></td>
            <td><input type="number" id="ab_co_${index}" min="0" step="0.01" value="${program.annualBudget?.co || 0}" aria-label="Annual Budget CO" class="input-number" readonly></td>
            <td><input type="number" id="ab_total_${index}" min="0" step="0.01" value="${program.annualBudget?.total || 0}" aria-label="Annual Budget Total" class="input-number" readonly></td>
            <td><span id="annual_allotment_${index}">0.00</span></td>
            <td class="amount-cell"><span id="annual_obligations_${index}">0.00</span></td>
            <td class="amount-cell"><span id="annual_variance_${index}">0.00</span></td>
            <td class="amount-cell"><span id="annual_absorptive_${index}">0.00%</span></td>
            <td><input type="text" id="annual_remarks_${index}" aria-label="Annual remarks" class="input-text"></td>
            <td><input type="text" id="proof_payment_${index}" aria-label="Proof of payment" class="input-text"></td>
        </tr>
    `).join('');
    const aTotalRow = `<tr class="total-row">
        <td colspan="2"><strong>TOTAL APPROPRIATION</strong></td>
        <td><strong>${aTot.aipPs.toFixed(2)}</strong></td>
        <td><strong>${aTot.aipMooe.toFixed(2)}</strong></td>
        <td><strong>${aTot.aipCo.toFixed(2)}</strong></td>
        <td><strong>${aTot.abPs.toFixed(2)}</strong></td>
        <td><strong>${aTot.abMooe.toFixed(2)}</strong></td>
        <td><strong>${aTot.abCo.toFixed(2)}</strong></td>
        <td><strong>${aTot.abTotal.toFixed(2)}</strong></td>
        <td><strong>${aTot.allot.toFixed(2)}</strong></td>
        <td><strong>0.00</strong></td>
        <td><strong>0.00</strong></td>
            <td><strong>0.00%</strong></td>
            <td></td>
            <td></td>
        </tr>`;

    document.getElementById('report-container').innerHTML = `
        <div class="report-toolbar">
            <h3>${office.name} - Annual Financial Performance</h3>
            <div>
                <button onclick="submitAnnualFinancialPerformance(this)" class="btn btn-primary btn-sm">Submit</button>
            </div>
        </div>
        <div class="table-container">
        <table class="annual-report-table">
            <thead>
                <tr>
                    <th rowspan="3">AIP Code</th>
                    <th rowspan="3">Program / Project</th>
                    <th colspan="3">AIP Amount FY ${currentYear}</th>
                    <th colspan="4">Annual Budget Amount FY ${currentYear}</th>
                    <th colspan="5">Annual Financial Performance</th>
                    <th rowspan="3">Proof of Payment<br><span class="header-note">(Check No.) Only for Programs / Projects (Non-Office), 20% DF / LDRRM Fund and GAD Fund</span></th>
                </tr>
                <tr>
                    <th>PS</th>
                    <th>MOOE</th>
                    <th>CO</th>
                    <th>PS</th>
                    <th>MOOE</th>
                    <th>CO</th>
                    <th>Total</th>
                    <th>Allotment</th>
                    <th>Obligations</th>
                    <th>Variance</th>
                    <th>Absorptive Capacity</th>
                    <th>Remarks</th>
                </tr>
            </thead>
            <tbody>${rows}${aTotalRow}</tbody>
        </table>
        </div>
    `;

    if (!skipInit) {
        prefillFromSubmittedReport('annual_financial', '').then((submitted) => {
            isAnnualSubmitted = submitted;
            fetchAndApplyQuarterlyObligations();
            if (submitted && currentUser.role === 'office') {
                applyAnnualFinancialLock();
            }
        });
    }

    currentEditablePrograms.forEach((_, idx) => calculateAnnualFinancial(idx));

    if (isAnnualSubmitted && currentUser.role === 'office') {
        applyAnnualFinancialLock();
    }
}

function getAllotment(index) {
    const ps = parseFloat(document.getElementById(`ab_ps_${index}`).value) || 0;
    const mooe = parseFloat(document.getElementById(`ab_mooe_${index}`).value) || 0;
    const co = parseFloat(document.getElementById(`ab_co_${index}`).value) || 0;
    return (ps + mooe + co) / 4;
}

let saveBudgetTimer = null;
function saveBudgetToServer() {
    if (saveBudgetTimer) clearTimeout(saveBudgetTimer);
    saveBudgetTimer = setTimeout(() => {
        if (!currentUser || !currentEditablePrograms) return;
        const programs = currentEditablePrograms.map((p, i) => ({
            code: document.getElementById(`code_${i}`).value.trim(),
            name: document.getElementById(`name_${i}`).value.trim(),
            aipAmount: {
                ps: parseFloat(document.getElementById(`aip_ps_${i}`).value) || 0,
                mooe: parseFloat(document.getElementById(`aip_mooe_${i}`).value) || 0,
                co: parseFloat(document.getElementById(`aip_co_${i}`).value) || 0,
            },
            annualBudget: {
                ps: parseFloat(document.getElementById(`ab_ps_${i}`).value) || 0,
                mooe: parseFloat(document.getElementById(`ab_mooe_${i}`).value) || 0,
                co: parseFloat(document.getElementById(`ab_co_${i}`).value) || 0,
                total: parseFloat(document.getElementById(`ab_total_${i}`).value) || 0,
            },
            mfo: (document.getElementById(`mfo_${i}`) || {}).value || '',
            performanceIndicator: (document.getElementById(`pi_${i}`) || {}).value || '',
        }));
        fetch(`/api/offices/${currentUser.office}/programs`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ year: currentYear, programs })
        }).catch(() => showToast('Failed to auto-save programs.', 'error'));
    }, 300);
}

function saveProgramsToServer(programs) {
    if (!currentUser) return;
    return fetch(`/api/offices/${currentUser.office}/programs`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ year: currentYear, programs })
    }).then(r => r.json()).then(data => {
        if (data.success) return refreshOfficeList();
        showToast('Failed to save programs — server rejected the request.', 'error');
    }).catch(() => {
        showToast('Failed to save programs — connection error.', 'error');
    });
}

function saveBudget(index) {
    if (!currentEditablePrograms[index]) return;
    const ps = parseFloat(document.getElementById(`ab_ps_${index}`).value) || 0;
    const mooe = parseFloat(document.getElementById(`ab_mooe_${index}`).value) || 0;
    const co = parseFloat(document.getElementById(`ab_co_${index}`).value) || 0;
    const total = ps + mooe + co;
    const totalEl = document.getElementById(`ab_total_${index}`);
    if (totalEl) totalEl.value = total.toFixed(2);
    currentEditablePrograms[index].annualBudget = { ps, mooe, co, total };
    saveProgramData(currentEditablePrograms);
    saveBudgetToServer();
}

function getAnnualAllotment(index) {
    const ps = parseFloat(document.getElementById(`ab_ps_${index}`).value) || 0;
    const mooe = parseFloat(document.getElementById(`ab_mooe_${index}`).value) || 0;
    const co = parseFloat(document.getElementById(`ab_co_${index}`).value) || 0;
    return ps + mooe + co;
}

function calculate(index) {
    const allotment = getAllotment(index);
    const obligations = parseFloat(document.getElementById(`obligations_${index}`).value) || 0;
    const variance = allotment - obligations;
    const absorptive = allotment > 0 ? (obligations / allotment) * 100 : 0;

    document.getElementById(`allotment_${index}`).textContent = formatCurrency(allotment);
    document.getElementById(`variance_${index}`).textContent = formatCurrency(variance);
    document.getElementById(`absorptive_${index}`).textContent = `${absorptive.toFixed(2)}%`;
    updateEmployeeTotalRow();
}

function submitAnnualFinancialPerformance(btn) {
    const office = officeMap.get(currentUser.office);

    const updatedPrograms = currentEditablePrograms.map((program, index) => ({
        ...program,
        code: isAipMode ? currentEditablePrograms[index].code : document.getElementById(`code_${index}`).value.trim(),
        name: isAipMode ? currentEditablePrograms[index].name : document.getElementById(`name_${index}`).value.trim(),
        aipAmount: {
            ps: parseFloat(document.getElementById(`aip_ps_${index}`).value) || 0,
            mooe: parseFloat(document.getElementById(`aip_mooe_${index}`).value) || 0,
            co: parseFloat(document.getElementById(`aip_co_${index}`).value) || 0,
        },
        annualBudget: {
            ps: parseFloat(document.getElementById(`ab_ps_${index}`).value) || 0,
            mooe: parseFloat(document.getElementById(`ab_mooe_${index}`).value) || 0,
            co: parseFloat(document.getElementById(`ab_co_${index}`).value) || 0,
            total: parseFloat(document.getElementById(`ab_total_${index}`).value) || 0,
        }
    }));

    if (!isAipMode) {
        saveProgramData(updatedPrograms);
        saveProgramsToServer(updatedPrograms);
    }

    const results = updatedPrograms.map((program, index) => {
        const allotment = getAnnualAllotment(index);
        const obligations = parseFloat(document.getElementById(`annual_obligations_${index}`).textContent.replace(/,/g, '')) || 0;
        const variance = allotment - obligations;
        const absorptive = allotment > 0 ? (obligations / allotment) * 100 : 0;

        return {
            code: program.code,
            name: program.name,
            aipAmount: program.aipAmount,
            annualBudget: program.annualBudget,
            allotment,
            obligations,
            variance,
            absorptive: Number(absorptive.toFixed(2)),
            remarks: document.getElementById(`annual_remarks_${index}`).value.trim(),
            proofOfPayment: document.getElementById(`proof_payment_${index}`).value.trim()
        };
    });

    const hasAnyEntry = results.some((row) =>
        row.code || row.name || row.obligations > 0 || row.remarks || row.proofOfPayment
    );

    if (!hasAnyEntry) {
        showToast('Please enter at least one annual financial detail before submitting.', 'warning');
        return;
    }

    showConfirmDialog({
        title: 'Submit Annual Report',
        message: 'Once submitted, you cannot edit this report. Continue?',
        confirmText: 'Submit',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        if (btn) setLoading(btn, true);

        fetchWithTimeout('/api/submit', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                office: office.id,
                officeName: office.name,
                year: currentYear,
                report_type: 'annual_financial',
                status: 'submitted',
                submittedAt: new Date().toISOString(),
                programs: results
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Annual financial performance submitted successfully!', 'success');
            } else if (data.error === 'locked') {
                showToast(data.message || 'Submission deadline has passed.', 'error');
                if (btn) { btn.disabled = false; btn.textContent = 'Request Access'; btn.onclick = function(){ showRequestAccessModal('annual_financial', ''); }; setLoading(btn, false); }
            }
            if (btn) setLoading(btn, false);
        })
        .catch(error => {
            showToast('Error connecting to server. Please try again.', 'error');
            if (btn) setLoading(btn, false);
            console.error(error);
        });
    });
}

function submitPhysicalPerformance(btn) {
    const office = officeMap.get(currentUser.office);

    const updatedPrograms = currentEditablePrograms.map((program, index) => ({
        ...program,
        code: isAipMode ? currentEditablePrograms[index].code : document.getElementById(`code_${index}`).value.trim(),
        name: isAipMode ? currentEditablePrograms[index].name : document.getElementById(`name_${index}`).value.trim(),
        annualBudget: {
            ps: parseFloat(document.getElementById(`ab_ps_${index}`).value) || 0,
            mooe: parseFloat(document.getElementById(`ab_mooe_${index}`).value) || 0,
            co: parseFloat(document.getElementById(`ab_co_${index}`).value) || 0,
            total: parseFloat(document.getElementById(`ab_total_${index}`).value) || 0,
        }
    }));

    saveProgramData(updatedPrograms);
    saveProgramsToServer(updatedPrograms);

    const results = updatedPrograms.map((program, index) => {
        const target = [1, 2, 3, 4].map((quarter) => document.getElementById(`target_${quarter}_${index}`).value.trim());
        const actual = [1, 2, 3, 4].map((quarter) => document.getElementById(`actual_${quarter}_${index}`).value.trim());
        const targetTotal = document.getElementById(`target_total_${index}`).value.trim();
        const actualTotal = document.getElementById(`actual_total_${index}`).value.trim();
        const targetNum = parseFloat(targetTotal);
        const actualNum = parseFloat(actualTotal);
        const isNumeric = !isNaN(targetNum) && !isNaN(actualNum) && targetTotal !== '' && actualTotal !== '';

        return {
            code: program.code,
            name: program.name,
            annualBudget: program.annualBudget,
            mfo: document.getElementById(`mfo_${index}`).value.trim(),
            performanceIndicator: document.getElementById(`pi_${index}`).value.trim(),
            target,
            targetTotal,
            actual,
            actualTotal,
            variance: isNumeric ? targetNum - actualNum : 'N/A',
            accomplishment: isNumeric && targetNum > 0 ? Number(((actualNum / targetNum) * 100).toFixed(2)) : 'N/A',
            remarks: document.getElementById(`physical_remarks_${index}`).value.trim()
        };
    });

    const hasAnyEntry = results.some((row) =>
        row.mfo || row.performanceIndicator || row.target.some(Boolean) || row.actual.some(Boolean) || row.remarks
    );

    if (!hasAnyEntry) {
        showToast('Please enter at least one physical performance detail before submitting.', 'warning');
        return;
    }

    showConfirmDialog({
        title: 'Submit Physical Report',
        message: 'Once submitted, you cannot edit this report. Continue?',
        confirmText: 'Submit',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        if (btn) setLoading(btn, true);

        fetchWithTimeout('/api/submit', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                office: office.id,
                officeName: office.name,
                year: currentYear,
                report_type: 'physical',
                status: 'submitted',
                submittedAt: new Date().toISOString(),
                programs: results
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Physical performance submitted successfully!', 'success');
            } else if (data.error === 'locked') {
                showToast(data.message || 'Submission deadline has passed.', 'error');
                if (btn) { btn.disabled = false; btn.textContent = 'Request Access'; btn.onclick = function(){ showRequestAccessModal('physical', ''); }; setLoading(btn, false); }
            }
            if (btn) setLoading(btn, false);
        })
        .catch(error => {
            showToast('Error connecting to server. Please try again.', 'error');
            if (btn) setLoading(btn, false);
            console.error(error);
        });
    });
}

function submitReport(btn) {
    const quarter = document.getElementById('quarter-select').value;
    const office = officeMap.get(currentUser.office);

    const updatedPrograms = currentEditablePrograms.map((program, index) => ({
        ...program,
        code: isAipMode ? currentEditablePrograms[index].code : document.getElementById(`code_${index}`).value.trim(),
        name: isAipMode ? currentEditablePrograms[index].name : document.getElementById(`name_${index}`).value.trim(),
        aipAmount: {
            ps: parseFloat(document.getElementById(`aip_ps_${index}`).value) || 0,
            mooe: parseFloat(document.getElementById(`aip_mooe_${index}`).value) || 0,
            co: parseFloat(document.getElementById(`aip_co_${index}`).value) || 0,
        },
        annualBudget: {
            ps: parseFloat(document.getElementById(`ab_ps_${index}`).value) || 0,
            mooe: parseFloat(document.getElementById(`ab_mooe_${index}`).value) || 0,
            co: parseFloat(document.getElementById(`ab_co_${index}`).value) || 0,
            total: parseFloat(document.getElementById(`ab_total_${index}`).value) || 0,
        }
    }));

    saveProgramData(updatedPrograms);
    saveProgramsToServer(updatedPrograms);

    const results = updatedPrograms.map((program, index) => {
        const allotment = getAllotment(index);
        const obligations = parseFloat(document.getElementById(`obligations_${index}`).value) || 0;
        const variance = allotment - obligations;
        const absorptive = allotment > 0 ? (obligations / allotment) * 100 : 0;

        return {
            code: program.code,
            name: program.name,
            aipAmount: program.aipAmount,
            annualBudget: program.annualBudget,
            allotment,
            obligations,
            variance,
            absorptive: Number(absorptive.toFixed(2)),
            remarks: document.getElementById(`remarks_${index}`).value.trim()
        };
    });

    const hasAnyEntry = results.some((row) =>
        row.code || row.name || row.obligations > 0 || row.remarks
    );

    if (!hasAnyEntry) {
        showToast('Please enter at least one report detail before submitting.', 'warning');
        return;
    }

    showConfirmDialog({
        title: 'Submit Quarterly Report',
        message: `Submit report for ${quarter}? Once submitted, you cannot edit. Continue?`,
        confirmText: 'Submit',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        if (btn) setLoading(btn, true);

        fetchWithTimeout('/api/submit', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                office: office.id,
                officeName: office.name,
                quarter,
                year: currentYear,
                report_type: 'quarterly',
                status: 'submitted',
                submittedAt: new Date().toISOString(),
                programs: results
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Report submitted successfully!', 'success');
                switchReport('quarterly', document.querySelector('#employee-view .nav-item[data-report="quarterly"]'));
            } else if (data.error === 'locked') {
                showToast(data.message || 'Submission deadline has passed.', 'error');
                const q = document.getElementById('quarter-select') ? document.getElementById('quarter-select').value : '';
                if (btn) { btn.disabled = false; btn.textContent = 'Request Access'; btn.onclick = function(){ showRequestAccessModal('quarterly', q); }; setLoading(btn, false); }
            }
            if (btn) setLoading(btn, false);
        })
        .catch(error => {
            showToast('Error connecting to server. Please try again.', 'error');
            if (btn) setLoading(btn, false);
            console.error(error);
        });
    });
}

// ──────────────────────────────────────────────
// AIP (Annual Investment Program)
// ──────────────────────────────────────────────
let currentAipRows = [];

function createEmptyAipRow() {
    return {
        refCode: '',
        program: '',
        implementingOffice: '',
        startDate: '',
        completionDate: '',
        expectedOutputs: '',
        fundingSource: '',
        ps: 0,
        mooe: 0,
        fe: 0,
        co: 0,
        total: 0,
        ccExpenditure: 0,
        ccAdaptation: '',
        ccTypology: ''
    };
}

function saveAipRowsFromDom() {
    currentAipRows.forEach((_, index) => {
        const ps = parseFloat(document.getElementById(`aip_ps_${index}`).value) || 0;
        const mooe = parseFloat(document.getElementById(`aip_mooe_${index}`).value) || 0;
        const fe = parseFloat(document.getElementById(`aip_fe_${index}`).value) || 0;
        const co = parseFloat(document.getElementById(`aip_co_${index}`).value) || 0;
        currentAipRows[index] = {
            refCode: document.getElementById(`aip_ref_${index}`).value.trim(),
            program: document.getElementById(`aip_program_${index}`).value.trim(),
            implementingOffice: document.getElementById(`aip_office_${index}`).value.trim(),
            startDate: document.getElementById(`aip_start_${index}`).value,
            completionDate: document.getElementById(`aip_end_${index}`).value,
            expectedOutputs: document.getElementById(`aip_outputs_${index}`).value.trim(),
            fundingSource: document.getElementById(`aip_funding_${index}`).value.trim(),
            ps, mooe, fe, co, total: ps + mooe + fe + co,
            ccExpenditure: parseFloat(document.getElementById(`aip_cc_${index}`).value) || 0,
            ccAdaptation: document.getElementById(`aip_cc_type_${index}`).value.trim(),
            ccTypology: document.getElementById(`aip_cc_code_${index}`).value.trim()
        };
    });
}

function addAipRow() {
    saveAipRowsFromDom();
    currentAipRows.push(createEmptyAipRow());
    renderAipTable();
}

function deleteAipRow(index) {
    showConfirmDialog({
        title: 'Delete Row',
        message: 'This cannot be undone.',
        confirmText: 'Delete',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (confirmed) {
            saveAipRowsFromDom();
            currentAipRows.splice(index, 1);
            renderAipTable();
        }
    });
}

function recalcAipTotal(index) {
    const ps = parseFloat(document.getElementById(`aip_ps_${index}`).value) || 0;
    const mooe = parseFloat(document.getElementById(`aip_mooe_${index}`).value) || 0;
    const fe = parseFloat(document.getElementById(`aip_fe_${index}`).value) || 0;
    const co = parseFloat(document.getElementById(`aip_co_${index}`).value) || 0;
    const total = ps + mooe + fe + co;
    document.getElementById(`aip_total_${index}`).textContent = total.toFixed(2);
}

function loadAip(skipInit) {
    activeReportType = 'aip';
    if (!currentUser) {
        showToast('Please login first.', 'warning');
        return;
    }

    const office = officeMap.get(currentUser.office);
    if (!office) {
        showToast('Office not found!', 'error');
        return;
    }

    if (!skipInit) {
        currentAipRows = Array.from({ length: 5 }, () => createEmptyAipRow());
    }

    const rows = currentAipRows.map((row, index) => `
        <tr>
            <td><input type="text" id="aip_ref_${index}" value="${escapeHtml(row.refCode)}" placeholder="e.g. AIP-2026-001" class="input-text"></td>
            <td><input type="text" id="aip_program_${index}" value="${escapeHtml(row.program)}" placeholder="Enter program/project" class="input-text"></td>
            <td><input type="text" id="aip_office_${index}" value="${escapeHtml(row.implementingOffice)}" placeholder="Implementing office" class="input-text"></td>
            <td><input type="month" id="aip_start_${index}" value="${escapeHtml(row.startDate)}" class="input-text"></td>
            <td><input type="month" id="aip_end_${index}" value="${escapeHtml(row.completionDate)}" class="input-text"></td>
            <td><input type="text" id="aip_outputs_${index}" value="${escapeHtml(row.expectedOutputs)}" placeholder="Expected outputs" class="input-text"></td>
            <td><input type="text" id="aip_funding_${index}" value="${escapeHtml(row.fundingSource)}" placeholder="e.g. GAA, LGU" class="input-text"></td>
            <td><input type="number" id="aip_ps_${index}" min="0" step="0.01" value="${row.ps}" class="input-number" oninput="recalcAipTotal(${index})"></td>
            <td><input type="number" id="aip_mooe_${index}" min="0" step="0.01" value="${row.mooe}" class="input-number" oninput="recalcAipTotal(${index})"></td>
            <td><input type="number" id="aip_fe_${index}" min="0" step="0.01" value="${row.fe}" class="input-number" oninput="recalcAipTotal(${index})"></td>
            <td><input type="number" id="aip_co_${index}" min="0" step="0.01" value="${row.co}" class="input-number" oninput="recalcAipTotal(${index})"></td>
            <td><span id="aip_total_${index}">${row.total.toFixed(2)}</span></td>
            <td><input type="number" id="aip_cc_${index}" min="0" step="0.01" value="${row.ccExpenditure}" class="input-number"></td>
            <td><input type="text" id="aip_cc_type_${index}" value="${escapeHtml(row.ccAdaptation)}" placeholder="Adaptation / Mitigation" class="input-text"></td>
            <td><input type="text" id="aip_cc_code_${index}" value="${escapeHtml(row.ccTypology)}" placeholder="CC typology code" class="input-text"></td>
            <td><button onclick="deleteAipRow(${index})" class="delete-btn" title="Delete this row">✕</button></td>
        </tr>
    `).join('');

    document.getElementById('report-container').innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
            <h3 style="margin:0;flex:1;">${office.name} - Annual Investment Program</h3>
        </div>
        <div class="table-container">
        <table class="aip-table" id="aip-table">
            <thead>
                <tr>
                    <th rowspan="2">AIP Ref. Code</th>
                    <th rowspan="2">Programs, Projects and Activities</th>
                    <th rowspan="2">Implementing Office / Department</th>
                    <th rowspan="2">Start Date</th>
                    <th rowspan="2">Completion Date</th>
                    <th rowspan="2">Expected Outputs</th>
                    <th rowspan="2">Funding Source</th>
                    <th colspan="5">Amount</th>
                    <th rowspan="2">Amount of CC Expenditure</th>
                    <th rowspan="2">CC Adaptation / Mitigation</th>
                    <th rowspan="2">CC Typology Code</th>
                    <th rowspan="2">Action</th>
                </tr>
                <tr>
                    <th>PS</th>
                    <th>MOOE</th>
                    <th>FE</th>
                    <th>CO</th>
                    <th>Total</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        </div>
        <br>
        <div class="action-buttons">
            <button onclick="addAipRow()" class="add-btn">+ Add Row</button>
            <button onclick="submitAip(this)">Submit AIP</button>
        </div>
    `;

    if (!skipInit) {
        prefillAip();
    }

    currentAipRows.forEach((_, idx) => recalcAipTotal(idx));
}

function prefillAip() {
    if (!currentUser) return;
    const officeId = currentUser.office;
    fetch(`/api/aip/${officeId}?year=${currentYear}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
        if (!data || !data.rows) return;
        currentAipRows = data.rows;
        renderAipTable();
    })
    .catch(() => showToast('Failed to load AIP data.', 'error'));
}

function renderAipTable() {
    const tbody = document.querySelector('#aip-table tbody');
    if (!tbody) return;
    tbody.innerHTML = currentAipRows.map((row, index) => `
        <tr>
            <td><input type="text" id="aip_ref_${index}" value="${escapeHtml(row.refCode)}" class="input-text"></td>
            <td><input type="text" id="aip_program_${index}" value="${escapeHtml(row.program)}" class="input-text"></td>
            <td><input type="text" id="aip_office_${index}" value="${escapeHtml(row.implementingOffice)}" class="input-text"></td>
            <td><input type="month" id="aip_start_${index}" value="${escapeHtml(row.startDate)}" class="input-text"></td>
            <td><input type="month" id="aip_end_${index}" value="${escapeHtml(row.completionDate)}" class="input-text"></td>
            <td><input type="text" id="aip_outputs_${index}" value="${escapeHtml(row.expectedOutputs)}" class="input-text"></td>
            <td><input type="text" id="aip_funding_${index}" value="${escapeHtml(row.fundingSource)}" class="input-text"></td>
            <td><input type="number" id="aip_ps_${index}" min="0" step="0.01" value="${row.ps}" class="input-number" oninput="recalcAipTotal(${index})"></td>
            <td><input type="number" id="aip_mooe_${index}" min="0" step="0.01" value="${row.mooe}" class="input-number" oninput="recalcAipTotal(${index})"></td>
            <td><input type="number" id="aip_fe_${index}" min="0" step="0.01" value="${row.fe}" class="input-number" oninput="recalcAipTotal(${index})"></td>
            <td><input type="number" id="aip_co_${index}" min="0" step="0.01" value="${row.co}" class="input-number" oninput="recalcAipTotal(${index})"></td>
            <td><span id="aip_total_${index}">${row.total.toFixed(2)}</span></td>
            <td><input type="number" id="aip_cc_${index}" min="0" step="0.01" value="${row.ccExpenditure}" class="input-number"></td>
            <td><input type="text" id="aip_cc_type_${index}" value="${escapeHtml(row.ccAdaptation)}" class="input-text"></td>
            <td><input type="text" id="aip_cc_code_${index}" value="${escapeHtml(row.ccTypology)}" class="input-text"></td>
            <td><button onclick="deleteAipRow(${index})" class="delete-btn" title="Delete this row">✕</button></td>
        </tr>
    `).join('');
}

function saveAipToServer(rows) {
    const office = officeMap.get(currentUser.office);
    if (!office) return;
    return fetchWithTimeout('/api/aip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            office: office.id,
            officeName: office.name,
            year: currentYear,
            status: 'submitted',
            submittedAt: new Date().toISOString(),
            rows
        })
    }).then(r => r.json()).then(data => {
        if (!data.success && data.error === 'locked') {
            showToast('Cannot delete AIP row — submission deadline has passed.', 'error');
        }
    }).catch(() => {
        showToast('Failed to save AIP data.', 'error');
    });
}

function isAipRowEmpty(row) {
    return !row.refCode && !row.program && !row.ps && !row.mooe && !row.fe && !row.co;
}

function submitAip(btn) {
    const office = officeMap.get(currentUser.office);
    if (!office) return;

    const rows = currentAipRows.map((_, index) => {
        const ps = parseFloat(document.getElementById(`aip_ps_${index}`).value) || 0;
        const mooe = parseFloat(document.getElementById(`aip_mooe_${index}`).value) || 0;
        const fe = parseFloat(document.getElementById(`aip_fe_${index}`).value) || 0;
        const co = parseFloat(document.getElementById(`aip_co_${index}`).value) || 0;
        const total = ps + mooe + fe + co;
        return {
            refCode: document.getElementById(`aip_ref_${index}`).value.trim(),
            program: document.getElementById(`aip_program_${index}`).value.trim(),
            implementingOffice: document.getElementById(`aip_office_${index}`).value.trim(),
            startDate: document.getElementById(`aip_start_${index}`).value,
            completionDate: document.getElementById(`aip_end_${index}`).value,
            expectedOutputs: document.getElementById(`aip_outputs_${index}`).value.trim(),
            fundingSource: document.getElementById(`aip_funding_${index}`).value.trim(),
            ps, mooe, fe, co, total,
            ccExpenditure: parseFloat(document.getElementById(`aip_cc_${index}`).value) || 0,
            ccAdaptation: document.getElementById(`aip_cc_type_${index}`).value.trim(),
            ccTypology: document.getElementById(`aip_cc_code_${index}`).value.trim()
        };
    });

    const nonEmptyRows = rows.filter(r => !isAipRowEmpty(r));
    if (nonEmptyRows.length === 0) {
        showToast('Please enter at least one AIP item before submitting.', 'warning');
        return;
    }

    showConfirmDialog({
        title: 'Submit AIP',
        message: 'Once submitted, you cannot edit the AIP. Continue?',
        confirmText: 'Submit',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        if (btn) setLoading(btn, true);

        fetchWithTimeout('/api/aip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    office: office.id,
                    officeName: office.name,
                    year: currentYear,
                    status: 'submitted',
                    submittedAt: new Date().toISOString(),
                    rows: nonEmptyRows
                })
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    showToast('AIP submitted successfully!', 'success');
                    const updatedPrograms = nonEmptyRows.map(r => {
                    const existing = office.programs?.find(p => p.code === r.refCode);
                    return {
                        code: r.refCode,
                        name: r.program,
                        aipAmount: { ps: r.ps || 0, mooe: r.mooe || 0, co: r.co || 0 },
                        annualBudget: existing?.annualBudget || { ps: 0, mooe: 0, co: 0, total: 0 },
                        mfo: existing?.mfo || '',
                        performanceIndicator: existing?.performanceIndicator || ''
                    };
                });
                if (office.programs) {
                    office.programs.forEach(p => {
                        if (!updatedPrograms.some(up => up.code === p.code)) {
                            updatedPrograms.push({
                                code: p.code,
                                name: p.name,
                                aipAmount: p.aipAmount || { ps: 0, mooe: 0, co: 0 },
                                annualBudget: p.annualBudget || { ps: 0, mooe: 0, co: 0, total: 0 },
                                mfo: p.mfo || '',
                                performanceIndicator: p.performanceIndicator || ''
                            });
                        }
                    });
                }
                fetch(`/api/offices/${office.id}/programs`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ year: currentYear, programs: updatedPrograms })
                }).catch(() => showToast('Failed to sync programs after AIP submit.', 'error'));
            } else if (data.error === 'locked') {
                showToast(data.message || 'Submission deadline has passed.', 'error');
                if (btn) { btn.disabled = false; btn.textContent = 'Request Access'; btn.onclick = function(){ showRequestAccessModal('aip', ''); }; setLoading(btn, false); }
            }
            if (btn) setLoading(btn, false);
        })
        .catch(() => {
            showToast('Error submitting AIP.', 'error');
            if (btn) setLoading(btn, false);
        });
    });
}

// Sidebar navigation for employee reports
function switchReport(reportType, element) {
    // Update active nav item
    document.querySelectorAll('#employee-view .nav-item').forEach(item => {
        item.classList.remove('active');
    });
    element.classList.add('active');

    activeReportType = reportType;
    // Update title and load appropriate report
    const titleElement = document.getElementById('report-title');
    const dashboardContainer = document.getElementById('office-dashboard-container');
    const reportContainer = document.getElementById('report-container');

    switch(reportType) {
        case 'office-dashboard':
            titleElement.textContent = 'Office Dashboard';
            dashboardContainer.style.display = 'block';
            reportContainer.style.display = 'none';
            loadOfficeDashboard();
            break;
        case 'quarterly':
            titleElement.textContent = 'Quarterly Financial Report';
            dashboardContainer.style.display = 'none';
            reportContainer.style.display = 'block';
            loadReport();
            break;
        case 'physical':
            titleElement.textContent = 'Physical Performance Report';
            dashboardContainer.style.display = 'none';
            reportContainer.style.display = 'block';
            loadPhysicalPerformance();
            break;
        case 'annual':
            titleElement.textContent = 'Annual Financial Report';
            dashboardContainer.style.display = 'none';
            reportContainer.style.display = 'block';
            loadAnnualFinancialPerformance();
            break;
        case 'aip':
            titleElement.textContent = 'Annual Investment Program';
            dashboardContainer.style.display = 'none';
            reportContainer.style.display = 'block';
            loadAip();
            break;
    }
}

// Sidebar navigation for admin dashboard
function switchDashboardPage(page, element) {
    // Update active nav item
    document.querySelectorAll('#manager-dashboard .nav-item').forEach(item => {
        item.classList.remove('active');
    });
    element.classList.add('active');

    // Hide all pages
    document.querySelectorAll('.dashboard-page').forEach(p => {
        p.style.display = 'none';
    });

    // Show selected page
    const pageTitle = document.getElementById('dashboard-page-title');
    switch(page) {
        case 'dashboard':
            document.getElementById('dashboard-page-dashboard').style.display = 'block';
            pageTitle.textContent = 'Dashboard Overview';
            loadDashboardData();
            break;
        case 'offices':
            document.getElementById('dashboard-page-offices').style.display = 'block';
            pageTitle.textContent = 'Office Management';
            renderOfficesTable();
            loadDeadlineSettings();
            loadAccessRequests();
            break;
    }
}

// Render offices table for the offices page
function renderOfficesTable() {
    const tbody = document.getElementById('offices-table-body');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;"><div class="loading-wrap row" style="padding:0"><div class="spinner-md"></div><span>Loading...</span></div></td></tr>';

    const officesPromise = fetch(`/api/offices?year=${currentYear}`).then(r => r.json());
    const deadlinesPromise = fetch(`/api/deadlines?year=${currentYear}`).then(r => r.json()).catch(() => ({ global: null }));
    const submissionsPromise = fetch(`/api/offices/submissions?year=${currentYear}`).then(r => r.json()).catch(() => ({}));

    Promise.all([officesPromise, deadlinesPromise, submissionsPromise])
    .then(([serverOffices, deadlineData, submissionsData]) => {
        tbody.innerHTML = '';

        const deadlineStr = deadlineData.global;
        let deadlineInfo = null;
        if (deadlineStr) {
            const deadlineDate = new Date(deadlineStr);
            const tr = getTimeRemaining(deadlineDate);
            deadlineInfo = { date: deadlineDate, isOverdue: tr.isOverdue, days: tr.days, hours: tr.hours, minutes: tr.minutes };
        }

        const banner = document.getElementById('deadline-banner');
        if (deadlineInfo) {
            banner.style.display = 'flex';
            if (deadlineInfo.isOverdue) {
                banner.style.background = '#f8d7da';
                banner.style.color = '#721c24';
                banner.innerHTML = `Deadline was ${formatDateTime(deadlineStr)} — Overdue by ${deadlineInfo.days}d ${deadlineInfo.hours}h ${deadlineInfo.minutes}m`;
            } else if (deadlineInfo.days <= 7) {
                banner.style.background = '#fff3cd';
                banner.style.color = '#856404';
                banner.innerHTML = `Deadline: ${formatDateTime(deadlineStr)} — ${deadlineInfo.days}d ${deadlineInfo.hours}h ${deadlineInfo.minutes}m remaining`;
            } else {
                banner.style.background = '#d4edda';
                banner.style.color = '#155724';
                banner.innerHTML = `Deadline: ${formatDateTime(deadlineStr)} — ${deadlineInfo.days}d ${deadlineInfo.hours}h ${deadlineInfo.minutes}m remaining`;
            }
        } else {
            banner.style.display = 'none';
        }

        serverOffices.forEach(office => {
            const progCount = office.programs?.length || 0;
            const sub = submissionsData[office.id];
            const hasSubmitted = sub && sub.has_submitted;

            let statusClass, statusText;
            if (hasSubmitted) {
                statusClass = 'status-badge status-submitted';
                statusText = 'Submitted';
            } else if (deadlineInfo && deadlineInfo.isOverdue) {
                statusClass = 'status-badge status-late';
                statusText = 'Late';
            } else {
                statusClass = 'status-badge status-pending';
                statusText = 'Pending';
            }

            const submittedAt = hasSubmitted ? formatDateTime(sub.last_submitted_at) : '-';

            let deadlineHtml;
            if (deadlineInfo) {
                let badgeClass, badgeText;
                if (deadlineInfo.isOverdue) {
                    badgeClass = 'deadline-overdue';
                    badgeText = 'Overdue';
                } else if (deadlineInfo.days === 0 && deadlineInfo.hours < 24) {
                    badgeClass = 'deadline-soon';
                    badgeText = `Due in ${deadlineInfo.hours}h ${deadlineInfo.minutes}m`;
                } else if (deadlineInfo.days <= 7) {
                    badgeClass = 'deadline-soon';
                    badgeText = `${deadlineInfo.days}d ${deadlineInfo.hours}h left`;
                } else {
                    badgeClass = 'deadline-far';
                    badgeText = `${deadlineInfo.days}d left`;
                }
                deadlineHtml = `<span style="font-size:12px;color:var(--muted);">Global: ${formatDateTime(deadlineStr)}</span> <span class="${badgeClass}">${badgeText}</span>`;
            } else {
                deadlineHtml = '<span style="font-size:12px;color:var(--muted);">-</span>';
            }

            const row = document.createElement('tr');
            row.innerHTML = `
                <td><strong>${escapeHtml(office.name)}</strong></td>
                <td>${progCount}</td>
                <td><span class="${statusClass}">${statusText}</span></td>
                <td style="font-size:12px;color:var(--muted);">${submittedAt}</td>
                <td>${deadlineHtml}</td>
                <td><button class="btn btn-outline btn-sm" onclick="editOffice('${office.id}')">Edit</button></td>
                <td><button class="btn btn-outline btn-sm" onclick="viewOfficeReports('${office.id}')">Reports</button></td>
                <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;" onclick="deleteOffice('${office.id}')">Delete</button></td>
            `;
            tbody.appendChild(row);
        });
    })
    .catch(() => {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted);">Failed to load offices.</td></tr>';
    });
}

// ============================================
// Admin Office Reports Viewer
// ============================================

let viewingReportOfficeId = null;
let viewingReportQuarter = null;
let viewingReportType = null;

function viewOfficeReports(officeId) {
    const office = officeMap.get(officeId);
    if (!office) { showToast('Office not found.', 'error'); return; }

    viewingReportOfficeId = officeId;
    document.getElementById('offices-table-card').style.display = 'none';
    document.getElementById('office-reports-card').style.display = 'block';
    document.getElementById('office-reports-title').textContent = 'Reports: ' + office.name;

    const container = document.getElementById('office-reports-list');
    container.innerHTML = '<div class="loading-wrap"><div class="spinner-md"></div><span>Loading reports...</span></div>';

    const reportTypes = [
        { type: 'quarterly', quarter: 'Q1', label: 'Quarterly Q1' },
        { type: 'quarterly', quarter: 'Q2', label: 'Quarterly Q2' },
        { type: 'quarterly', quarter: 'Q3', label: 'Quarterly Q3' },
        { type: 'quarterly', quarter: 'Q4', label: 'Quarterly Q4' },
        { type: 'physical', quarter: '', label: 'Physical Performance' },
        { type: 'annual_financial', quarter: '', label: 'Annual Financial' },
        { type: 'aip', quarter: '', label: 'Annual Investment Program' },
    ];

    const reportFetches = reportTypes.map(rt => {
        const url = rt.type === 'aip'
            ? `/api/aip/${officeId}?year=${currentYear}`
            : rt.quarter
                ? `/api/reports/${officeId}?quarter=${rt.quarter}&type=${rt.type}&year=${currentYear}`
                : `/api/reports/${officeId}?type=${rt.type}&year=${currentYear}`;
        return fetch(url).then(r => {
            if (r.ok) return r.json();
            return null;
        }).catch(() => null);
    });

    Promise.all(reportFetches).then(results => {
        container.innerHTML = '';
        const table = document.createElement('table');
        table.className = 'modern-table';
        table.innerHTML = `
            <thead><tr>
                <th>Report Type</th>
                <th>Status</th>
                <th>Submitted At</th>
                <th>Action</th>
            </tr></thead>
            <tbody id="reports-list-body"></tbody>
        `;
        container.appendChild(table);

        const tbody = table.querySelector('tbody');
        reportTypes.forEach((rt, idx) => {
            const data = results[idx];
            const isSubmitted = data !== null && data !== undefined;
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><strong>${rt.label}</strong></td>
                <td><span class="status-badge ${isSubmitted ? 'status-submitted' : 'status-pending'}">${isSubmitted ? 'Submitted' : 'Not Submitted'}</span></td>
                <td>${isSubmitted && data.submittedAt ? formatDateTime(data.submittedAt) : '-'}</td>
                <td>${isSubmitted ? `<button class="btn btn-outline btn-sm" onclick="loadReportDetail('${officeId}', '${rt.type}', '${rt.quarter}')">View</button>` : '-'}</td>
            `;
            tbody.appendChild(row);
        });
    });
}

// ============================================
// Employee Deadline Countdown
// ============================================

function getTimeRemaining(deadlineDate) {
    const now = new Date();
    const diffMs = deadlineDate - now;
    const isOverdue = diffMs < 0;
    const absMs = Math.abs(diffMs);
    const days = Math.floor(absMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((absMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((absMs % (1000 * 60 * 60)) / (1000 * 60));
    return { isOverdue, days, hours, minutes, diffMs };
}

function loadEmployeeDeadline() {
    fetch(`/api/deadlines?year=${currentYear}`)
    .then(r => r.json())
    .then(data => {
        const el = document.getElementById('employee-deadline-countdown');
        if (!data.global) { el.style.display = 'none'; return; }
        const deadlineDate = new Date(data.global);
        const tr = getTimeRemaining(deadlineDate);
        el.style.display = 'block';
        if (tr.isOverdue) {
            el.style.background = '#f8d7da'; el.style.color = '#721c24';
            el.textContent = `Deadline was ${formatDateTime(data.global)} — Overdue by ${tr.days}d ${tr.hours}h ${tr.minutes}m`;
        } else if (tr.days <= 7) {
            el.style.background = '#fff3cd'; el.style.color = '#856404';
            el.textContent = `Deadline: ${formatDateTime(data.global)} — ${tr.days}d ${tr.hours}h ${tr.minutes}m remaining`;
        } else {
            el.style.background = '#d4edda'; el.style.color = '#155724';
            el.textContent = `Deadline: ${formatDateTime(data.global)} — ${tr.days}d ${tr.hours}h ${tr.minutes}m remaining`;
        }
    })
    .catch(() => showToast('Failed to load deadline.', 'error'));
}

// ============================================
// Admin Deadline Management
// ============================================

let deadlineSectionVisible = false;

function toggleDeadlineSection() {
    deadlineSectionVisible = !deadlineSectionVisible;
    const body = document.getElementById('deadline-settings-body');
    const btn = document.getElementById('deadline-toggle-btn');
    body.style.display = deadlineSectionVisible ? 'block' : 'none';
    btn.textContent = deadlineSectionVisible ? 'Hide' : 'Show';
    if (deadlineSectionVisible) loadDeadlineSettings();
}

function loadDeadlineSettings() {
    fetch(`/api/deadlines?year=${currentYear}`)
    .then(r => r.json())
    .then(data => {
        const statusEl = document.getElementById('deadline-status');
        if (data.global) {
            statusEl.textContent = 'Global: ' + formatDateTime(data.global);
        } else {
            statusEl.textContent = 'No global deadline set';
        }

        if (data.global) {
            document.getElementById('deadline-global-input').value = data.global.slice(0, 16);
        } else {
            document.getElementById('deadline-global-input').value = '';
        }
    })
    .catch(() => showToast('Failed to load deadline settings.', 'error'));
}

function saveGlobalDeadline() {
    const input = document.getElementById('deadline-global-input');
    const val = input.value;
    if (!val) { showToast('Please select a date and time.', 'warning'); return; }
    const deadlineAt = new Date(val).toISOString();

    fetchWithTimeout('/api/deadline/global', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'include',
        body: JSON.stringify({ year: currentYear, deadline_at: deadlineAt })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            showToast('Global deadline saved!', 'success');
            loadDeadlineSettings();
        } else {
            showToast('Failed to save global deadline.', 'error');
        }
    })
    .catch(() => showToast('Error saving deadline.', 'error'));
}

function clearDeadline() {
    showConfirmDialog({
        title: 'Clear Deadline',
        message: 'Clear the global deadline for this year?',
        confirmText: 'Clear',
        confirmClass: 'btn-confirm-delete',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        fetchWithTimeout('/api/deadline/global', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            credentials: 'include',
            body: JSON.stringify({ year: currentYear, deadline_at: null })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('Global deadline cleared.', 'success');
                loadDeadlineSettings();
            }
        })
        .catch(() => showToast('Error clearing deadline.', 'error'));
    });
}

// ============================================
// Access Requests (Admin)
// ============================================

let accessRequestsVisible = false;

function toggleAccessRequests() {
    accessRequestsVisible = !accessRequestsVisible;
    const body = document.getElementById('access-requests-body');
    const btn = document.getElementById('access-requests-toggle-btn');
    body.style.display = accessRequestsVisible ? 'block' : 'none';
    btn.textContent = accessRequestsVisible ? 'Hide' : 'Show';
    if (accessRequestsVisible) loadAccessRequests();
}

function loadAccessRequests() {
    const tbody = document.getElementById('access-requests-table-body');
    if (!tbody) return;
    const statusEl = document.getElementById('access-requests-status');
    const badge = document.getElementById('access-requests-badge');
    const body = document.getElementById('access-requests-body');
    statusEl.textContent = 'Loading...';

    fetch(`/api/access-requests?year=${currentYear}`)
    .then(r => r.json())
    .then(requests => {
        const pending = requests.filter(r => r.status === 'pending');
        statusEl.textContent = pending.length + ' pending';

        if (badge) {
            if (pending.length > 0) {
                badge.style.display = 'inline';
                badge.textContent = pending.length + ' pending';
            } else {
                badge.style.display = 'none';
            }
        }

        if (pending.length > 0 && body && body.style.display !== 'block') {
            body.style.display = 'block';
            const btn = document.getElementById('access-requests-toggle-btn');
            if (btn) btn.textContent = 'Hide';
        }

        if (!requests.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted);">No access requests.</td></tr>';
            return;
        }

        tbody.innerHTML = requests.map(req => {
            const statusLabel = req.status === 'pending' ? 'Pending' : req.status === 'approved' ? 'Approved' : 'Denied';
            const statusClass = req.status === 'approved' ? 'status-submitted' : req.status === 'denied' ? 'status-rejected' : 'status-pending';
            const actions = req.status === 'pending' ? `
                <button class="btn btn-success btn-sm" onclick="approveAccessRequest(${req.id})" style="margin-right:4px;">Approve</button>
                <button class="btn btn-danger btn-sm" onclick="denyAccessRequest(${req.id})">Deny</button>
            ` : '<span style="font-size:12px;color:var(--muted);">-</span>';

            const reportLabel = req.report_type === 'quarterly' ? 'Q-Financial' : req.report_type === 'physical' ? 'Physical' : req.report_type === 'annual_financial' ? 'Annual-Fin' : req.report_type === 'aip' ? 'AIP' : req.report_type;

            return `<tr>
                <td><strong>${escapeHtml(req.office_name)}</strong></td>
                <td>${reportLabel}</td>
                <td>${req.quarter || '-'}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(req.reason)}">${escapeHtml(req.reason)}</td>
                <td style="font-size:12px;">${formatDateTime(req.requested_at)}</td>
                <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                <td>${actions}</td>
            </tr>`;
        }).join('');
    })
    .catch(() => {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted);">Failed to load requests.</td></tr>';
    });
}

function approveAccessRequest(requestId) {
    showConfirmDialog({
        title: 'Approve Access Request',
        message: 'Allow this office to submit reports past the deadline?',
        confirmText: 'Approve',
        confirmClass: 'btn-confirm-delete',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        fetchWithTimeout(`/api/access-requests/${requestId}/approve`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            credentials: 'include',
            body: JSON.stringify({ notes: '' })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('Access request approved.', 'success');
                loadAccessRequests();
            } else {
                showToast('Failed to approve request.', 'error');
            }
        })
        .catch(() => showToast('Error approving request.', 'error'));
    });
}

function denyAccessRequest(requestId) {
    showConfirmDialog({
        title: 'Deny Access Request',
        message: 'Deny this office from submitting past the deadline?',
        confirmText: 'Deny',
        confirmClass: 'btn-confirm-delete',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        fetchWithTimeout(`/api/access-requests/${requestId}/deny`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            credentials: 'include',
            body: JSON.stringify({ notes: '' })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('Access request denied.', 'success');
                loadAccessRequests();
            } else {
                showToast('Failed to deny request.', 'error');
            }
        })
        .catch(() => showToast('Error denying request.', 'error'));
    });
}

// ============================================
// Request Access Modal (Employee)
// ============================================

function showRequestAccessModal(reportType, quarter) {
    const office = officeMap.get(currentUser.office);
    if (!office) { showToast('Office not found.', 'error'); return; }

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.id = 'request-access-overlay';
    const typeLabel = reportType === 'quarterly' ? 'Quarterly Financial (' + quarter + ')' : reportType === 'physical' ? 'Physical Performance' : reportType === 'annual_financial' ? 'Annual Financial' : reportType === 'aip' ? 'Annual Investment Program' : reportType;

    overlay.innerHTML = `
        <div class="confirm-dialog" style="max-width:500px;">
            <div class="confirm-icon">&#128197;</div>
            <h3>Request Late Submission Access</h3>
            <p style="color:#666;font-size:13px;margin-bottom:12px;">The submission deadline has passed for <strong>${escapeHtml(office.name)}</strong> (<strong>${typeLabel}</strong>). Please provide a reason for the late submission.</p>
            <textarea id="request-access-reason" placeholder="Explain why you missed the deadline..." style="width:100%;min-height:80px;padding:10px;border:1px solid #D0DCF0;border-radius:6px;font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit;"></textarea>
            <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn-cancel" onclick="document.getElementById('request-access-overlay').remove()">Cancel</button>
                <button id="submit-request-btn" class="btn-confirm-delete" onclick="submitAccessRequest('${reportType}', '${quarter}')" style="background:#0B2545;color:#fff;">Submit Request</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    setTimeout(() => document.getElementById('request-access-reason').focus(), 100);
}

function submitAccessRequest(reportType, quarter) {
    const office = officeMap.get(currentUser.office);
    if (!office) return;

    const reason = document.getElementById('request-access-reason').value.trim();
    if (!reason) {
        showToast('Please provide a reason for the late submission.', 'warning');
        return;
    }

    showConfirmDialog({
        title: 'Submit Access Request',
        message: 'Request late submission access? Make sure your reason is accurate.',
        confirmText: 'Submit',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;

        const btn = document.getElementById('submit-request-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

        fetchWithTimeout('/api/request-access', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                office_id: office.id,
                office_name: office.name,
                year: currentYear,
                report_type: reportType,
                quarter: quarter,
                reason: reason
            })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast(data.message || 'Access request submitted!', 'success');
                const overlay = document.getElementById('request-access-overlay');
                if (overlay) overlay.remove();
            } else {
                showToast(data.error || 'Failed to submit request.', 'error');
            }
        })
        .catch(() => {
            showToast('Error submitting request. Please try again.', 'error');
        })
        .finally(() => {
            if (btn) { btn.disabled = false; btn.textContent = 'Submit Request'; }
        });
    });
}

function closeOfficeReports() {
    viewingReportOfficeId = null;
    document.getElementById('office-reports-card').style.display = 'none';
    document.getElementById('offices-table-card').style.display = 'block';
    renderOfficesTable();
}

function loadReportDetail(officeId, type, quarter) {
    const office = officeMap.get(officeId);
    if (!office) return;

    viewingReportOfficeId = officeId;
    viewingReportQuarter = type === 'quarterly' ? (quarter || 'Q1') : '';
    viewingReportType = type;

    document.getElementById('office-reports-card').style.display = 'none';
    document.getElementById('report-detail-card').style.display = 'block';

    renderCurrentTab();
}

function renderCurrentTab() {
    if (!viewingReportOfficeId) return;
    const office = officeMap.get(viewingReportOfficeId);
    if (!office) return;

    const type = viewingReportType;
    const quarter = type === 'quarterly' ? viewingReportQuarter : '';
    const label = type === 'quarterly' ? 'Quarterly ' + quarter : (type === 'physical' ? 'Physical Performance' : (type === 'aip' ? 'Annual Investment Program' : 'Annual Financial'));

    document.getElementById('report-detail-title').textContent = office.name + ' - ' + label;

    const bodyEl = document.getElementById('report-detail-body');
    const headEl = document.getElementById('report-detail-head');
    bodyEl.innerHTML = '<tr><td colspan="20" style="text-align:center;padding:32px;"><div class="loading-wrap row" style="padding:0"><div class="spinner-md"></div><span>Loading...</span></div></td></tr>';

    let fetchPromise;
    if (type === 'aip') {
        fetchPromise = fetch(`/api/aip/${viewingReportOfficeId}?year=${currentYear}`).then(r => r.ok ? r.json() : null);
    } else {
        const url = quarter
            ? `/api/reports/${viewingReportOfficeId}?quarter=${quarter}&type=${type}&year=${currentYear}`
            : `/api/reports/${viewingReportOfficeId}?type=${type}&year=${currentYear}`;
        fetchPromise = fetch(url).then(r => r.ok ? r.json() : null);
    }

    fetchPromise
    .then(data => {
        if (type === 'aip') {
            renderAipReportDetail(data && data.data ? data.data : []);
        } else {
            const programs = data && data.programs ? data.programs : [];
            const readOnly = !isCurrentOrPastYear();
            if (type === 'physical') {
                renderPhysicalDetail(programs, office, undefined, undefined, readOnly);
            } else if (type === 'quarterly') {
                renderQuarterlyDetail(programs, office, undefined, undefined, readOnly);
            } else {
                renderAnnualDetail(programs, office, undefined, undefined, readOnly);
            }
        }
    })
    .catch(() => {
        bodyEl.innerHTML = '<tr><td colspan="20" style="text-align:center;padding:24px;color:var(--muted);">Error loading report.</td></tr>';
    });
}

function renderQuarterlyDetail(programs, office, headEl, bodyEl, readOnly) {
    if (!headEl) headEl = document.getElementById('report-detail-head');
    if (!bodyEl) bodyEl = document.getElementById('report-detail-body');
    const progData = office ? office.programs : [];

    headEl.innerHTML = `<tr>
        <th rowspan="2">AIP Code</th>
        <th rowspan="2">Program / Project</th>
        <th colspan="3">AIP Amount FY ${currentYear}</th>
        <th colspan="4">Annual Budget Amount FY ${currentYear}</th>
        <th rowspan="2">Allotment Released</th>
        <th rowspan="2">Actual Obligations</th>
        <th rowspan="2">Variance</th>
        <th rowspan="2">Absorptive Capacity</th>
        <th rowspan="2">Remarks</th>
        ${readOnly ? '' : '<th rowspan="2">Action</th>'}
    </tr>
    <tr>
        <th>PS</th><th>MOOE</th><th>CO</th>
        <th>PS</th><th>MOOE</th><th>CO</th><th>Total</th>
    </tr>`;

    if (programs.length === 0) {
        const noDataColspan = readOnly ? 14 : 15;
        bodyEl.innerHTML = `<tr><td colspan="${noDataColspan}" style="text-align:center;padding:24px;color:var(--muted);">${readOnly ? 'No submitted data.' : 'No submitted data yet. Click "+ Add Row" to begin.'}</td></tr>`;
        return;
    }

    programs = programs.filter(p => p.name !== 'TOTAL APPROPRIATION' && p.name !== 'TOTAL APPROPRIATIONS');
    const inOfficeEditor = document.getElementById('office-editor-card')?.style.display === 'block';
    const bodyRows = programs.map((p, i) => {
        const master = progData.find(m => m.code === p.code) || {};
        const aip = p.aipAmount || master.aipAmount || {};
        const ab = inOfficeEditor && master.annualBudget ? master.annualBudget : (p.annualBudget || master.annualBudget || {});
        const fmt = v => (v || 0).toFixed(2);
        if (readOnly) {
            return `
            <tr>
                <td><span>${escapeHtml(p.code)}</span></td>
                <td><span>${escapeHtml(p.name)}</span></td>
                <td><span>${fmt(aip.ps)}</span></td>
                <td><span>${fmt(aip.mooe)}</span></td>
                <td><span>${fmt(aip.co)}</span></td>
                <td><span>${fmt(ab.ps)}</span></td>
                <td><span>${fmt(ab.mooe)}</span></td>
                <td><span>${fmt(ab.co)}</span></td>
                <td><span>${fmt(ab.total)}</span></td>
                <td><span>${fmt(p.allotment || ((ab.ps||0)+(ab.mooe||0)+(ab.co||0))/4)}</span></td>
                <td><span>${fmt(p.obligations)}</span></td>
                <td><span id="v_${i}">${fmt(p.variance)}</span></td>
                <td><span id="abs_${i}">${fmt(p.absorptive)}%</span></td>
                <td><span>${escapeHtml(p.remarks || '')}</span></td>
            </tr>`;
        }
        const computedAllotment = ((ab.ps || 0) + (ab.mooe || 0) + (ab.co || 0)) / 4;
        return `
        <tr>
            <td><input type="text" value="${escapeHtml(p.code)}" data-idx="${i}" data-field="code" style="width:120px"></td>
            <td><input type="text" value="${escapeHtml(p.name)}" data-idx="${i}" data-field="name" style="width:220px"></td>
            <td><input type="number" step="0.01" value="${aip.ps || 0}" data-idx="${i}" data-field="aip_ps" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${aip.mooe || 0}" data-idx="${i}" data-field="aip_mooe" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${aip.co || 0}" data-idx="${i}" data-field="aip_co" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${ab.ps || 0}" data-idx="${i}" data-field="ab_ps" style="width:110px" oninput="autoComputeRow(this)"></td>
            <td><input type="number" step="0.01" value="${ab.mooe || 0}" data-idx="${i}" data-field="ab_mooe" style="width:110px" oninput="autoComputeRow(this)"></td>
            <td><input type="number" step="0.01" value="${ab.co || 0}" data-idx="${i}" data-field="ab_co" style="width:110px" oninput="autoComputeRow(this)"></td>
            <td><input type="number" step="0.01" value="${ab.total || 0}" data-idx="${i}" data-field="ab_total" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${computedAllotment.toFixed(2)}" data-idx="${i}" data-field="allotment" readonly style="width:130px"></td>
            <td><input type="number" step="0.01" value="${p.obligations || 0}" data-idx="${i}" data-field="obligations" style="width:130px" oninput="autoComputeRow(this)"></td>
            <td><span id="v_${i}" data-display="variance">${(p.variance || 0).toFixed(2)}</span></td>
            <td><span id="abs_${i}" data-display="absorptive">${(p.absorptive || 0).toFixed(2)}%</span></td>
            <td><input type="text" value="${escapeHtml(p.remarks || '')}" data-idx="${i}" data-field="remarks" style="width:150px"></td>
            <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="deleteAdminRow(this)">×</button></td>
        </tr>`;
    }).join('');

    const tot = { aipPs: 0, aipMooe: 0, aipCo: 0, abPs: 0, abMooe: 0, abCo: 0, abTotal: 0, allot: 0, oblig: 0 };
    programs.forEach(p => {
        const master = progData.find(m => m.code === p.code) || {};
        const aip = p.aipAmount || master.aipAmount || {};
        const ab = master.annualBudget || p.annualBudget || {};
        tot.aipPs += aip.ps || 0; tot.aipMooe += aip.mooe || 0; tot.aipCo += aip.co || 0;
        tot.abPs += ab.ps || 0; tot.abMooe += ab.mooe || 0; tot.abCo += ab.co || 0; tot.abTotal += ab.total || 0;
        tot.allot += ((ab.ps || 0) + (ab.mooe || 0) + (ab.co || 0)) / 4;
        tot.oblig += p.obligations || 0;
    });
    const variance = tot.allot - tot.oblig;
    const absorptive = tot.allot > 0 ? ((tot.oblig / tot.allot) * 100).toFixed(2) : '0.00';
    bodyEl.innerHTML = bodyRows + `
        <tr class="total-row">
            <td colspan="2"><strong>TOTAL APPROPRIATION</strong></td>
            <td><strong>${tot.aipPs.toFixed(2)}</strong></td>
            <td><strong>${tot.aipMooe.toFixed(2)}</strong></td>
            <td><strong>${tot.aipCo.toFixed(2)}</strong></td>
            <td><strong>${tot.abPs.toFixed(2)}</strong></td>
            <td><strong>${tot.abMooe.toFixed(2)}</strong></td>
            <td><strong>${tot.abCo.toFixed(2)}</strong></td>
            <td><strong>${tot.abTotal.toFixed(2)}</strong></td>
            <td><strong>${tot.allot.toFixed(2)}</strong></td>
            <td><strong>${tot.oblig.toFixed(2)}</strong></td>
            <td><strong>${variance.toFixed(2)}</strong></td>
            <td><strong>${absorptive}%</strong></td>
            <td></td>
            ${readOnly ? '' : '<td></td>'}
        </tr>`;
}

function renderPhysicalDetail(programs, office, headEl, bodyEl, readOnly) {
    if (!headEl) headEl = document.getElementById('report-detail-head');
    if (!bodyEl) bodyEl = document.getElementById('report-detail-body');

    headEl.innerHTML = `<tr>
        <th rowspan="3">AIP Code</th>
        <th rowspan="3">Program / Project</th>
        <th colspan="3">AIP Amount FY ${currentYear}</th>
        <th colspan="4">Annual Budget Amount FY ${currentYear}</th>
        <th rowspan="3">Major Final Output (MFO)</th>
        <th rowspan="3">Performance Indicators (PIs)</th>
        <th colspan="13">Physical Performance</th>
        <th rowspan="3">Action</th>
    </tr>
    <tr>
        <th rowspan="2">PS</th><th rowspan="2">MOOE</th><th rowspan="2">CO</th>
        <th rowspan="2">PS</th><th rowspan="2">MOOE</th><th rowspan="2">CO</th><th rowspan="2">Total</th>
        <th colspan="5">Target Output</th>
        <th colspan="5">Actual Output / Performance</th>
        <th rowspan="2">Variance / Difference</th>
        <th rowspan="2">% of Accomplishment</th>
        <th rowspan="2">Remarks</th>
    </tr>
    <tr>
        <th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>Total</th>
        <th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>Total</th>
    </tr>`;

    if (programs.length === 0) {
        const colspan = readOnly ? 24 : 25;
        bodyEl.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;padding:24px;color:var(--muted);">${readOnly ? 'No submitted data.' : 'No submitted data yet. Click "+ Add Row" to begin.'}</td></tr>`;
        return;
    }

    programs = programs.filter(p => p.name !== 'TOTAL APPROPRIATION' && p.name !== 'TOTAL APPROPRIATIONS');
    const bodyRows = programs.map((p, i) => {
        if (readOnly) {
            const fmtV = (v) => v !== undefined && v !== 'N/A' ? formatCurrency(v) : (v || 'N/A');
            const fmtA = (v) => v !== undefined && v !== 'N/A' ? v + '%' : (v || 'N/A');
            return `
            <tr>
                <td><span>${escapeHtml(p.code)}</span></td>
                <td><span>${escapeHtml(p.name)}</span></td>
                <td><span>${(p.aipAmount && p.aipAmount.ps) || 0}</span></td>
                <td><span>${(p.aipAmount && p.aipAmount.mooe) || 0}</span></td>
                <td><span>${(p.aipAmount && p.aipAmount.co) || 0}</span></td>
                <td><span>${(p.annualBudget && p.annualBudget.ps) || 0}</span></td>
                <td><span>${(p.annualBudget && p.annualBudget.mooe) || 0}</span></td>
                <td><span>${(p.annualBudget && p.annualBudget.co) || 0}</span></td>
                <td><span>${(p.annualBudget && p.annualBudget.total) || 0}</span></td>
                <td><span>${escapeHtml(p.mfo || '')}</span></td>
                <td><span>${escapeHtml(p.performanceIndicator || '')}</span></td>
                <td><span>${(p.target && p.target[0]) || ''}</span></td>
                <td><span>${(p.target && p.target[1]) || ''}</span></td>
                <td><span>${(p.target && p.target[2]) || ''}</span></td>
                <td><span>${(p.target && p.target[3]) || ''}</span></td>
                <td><span>${p.targetTotal || ''}</span></td>
                <td><span>${(p.actual && p.actual[0]) || ''}</span></td>
                <td><span>${(p.actual && p.actual[1]) || ''}</span></td>
                <td><span>${(p.actual && p.actual[2]) || ''}</span></td>
                <td><span>${(p.actual && p.actual[3]) || ''}</span></td>
                <td><span>${p.actualTotal || ''}</span></td>
                <td><input type="text" value="${fmtV(p.variance)}" class="input-number" style="width:100px;" data-field="variance"></td>
                <td><input type="text" value="${fmtA(p.accomplishment)}" class="input-number" style="width:100px;" data-field="accomplishment"></td>
                <td><span>${escapeHtml(p.remarks || '')}</span></td>
            </tr>`;
        }
        return `
        <tr>
            <td><input type="text" value="${escapeHtml(p.code)}" data-idx="${i}" data-field="code" style="width:120px"></td>
            <td><input type="text" value="${escapeHtml(p.name)}" data-idx="${i}" data-field="name" style="width:220px"></td>
            <td><input type="number" step="0.01" value="${(p.aipAmount && p.aipAmount.ps) || 0}" data-idx="${i}" data-field="aip_ps" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${(p.aipAmount && p.aipAmount.mooe) || 0}" data-idx="${i}" data-field="aip_mooe" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${(p.aipAmount && p.aipAmount.co) || 0}" data-idx="${i}" data-field="aip_co" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${(p.annualBudget && p.annualBudget.ps) || 0}" data-idx="${i}" data-field="ab_ps" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${(p.annualBudget && p.annualBudget.mooe) || 0}" data-idx="${i}" data-field="ab_mooe" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${(p.annualBudget && p.annualBudget.co) || 0}" data-idx="${i}" data-field="ab_co" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${(p.annualBudget && p.annualBudget.total) || 0}" data-idx="${i}" data-field="ab_total" style="width:110px"></td>
            <td><input type="text" value="${escapeHtml(p.mfo || '')}" data-idx="${i}" data-field="mfo" style="width:160px"></td>
            <td><input type="text" value="${escapeHtml(p.performanceIndicator || '')}" data-idx="${i}" data-field="pi" style="width:160px"></td>
            <td><input type="text" value="${(p.target && p.target[0]) || ''}" data-idx="${i}" data-field="t1" style="width:100px"></td>
            <td><input type="text" value="${(p.target && p.target[1]) || ''}" data-idx="${i}" data-field="t2" style="width:100px"></td>
            <td><input type="text" value="${(p.target && p.target[2]) || ''}" data-idx="${i}" data-field="t3" style="width:100px"></td>
            <td><input type="text" value="${(p.target && p.target[3]) || ''}" data-idx="${i}" data-field="t4" style="width:100px"></td>
<td><input type="text" value="${p.targetTotal || ''}" data-idx="${i}" data-field="target_total" style="width:100px" oninput="autoComputePhysicalAdmin(${i})"></td>
            <td><input type="text" value="${(p.actual && p.actual[0]) || ''}" data-idx="${i}" data-field="a1" style="width:100px"></td>
            <td><input type="text" value="${(p.actual && p.actual[1]) || ''}" data-idx="${i}" data-field="a2" style="width:100px"></td>
            <td><input type="text" value="${(p.actual && p.actual[2]) || ''}" data-idx="${i}" data-field="a3" style="width:100px"></td>
            <td><input type="text" value="${(p.actual && p.actual[3]) || ''}" data-idx="${i}" data-field="a4" style="width:100px"></td>
            <td><input type="text" value="${p.actualTotal || ''}" data-idx="${i}" data-field="actual_total" style="width:100px" oninput="autoComputePhysicalAdmin(${i})"></td>
            <td><input type="text" value="${p.variance !== undefined && p.variance !== 'N/A' ? formatCurrency(p.variance) : (p.variance || 'N/A')}" class="input-number" style="width:100px;" data-field="variance"></td>
            <td><input type="text" value="${p.accomplishment !== undefined && p.accomplishment !== 'N/A' ? p.accomplishment + '%' : (p.accomplishment || 'N/A')}" class="input-number" style="width:100px;" data-field="accomplishment"></td>
            <td><input type="text" value="${escapeHtml(p.remarks || '')}" data-idx="${i}" data-field="remarks" style="width:150px"></td>
            <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="deleteAdminRow(this)">×</button></td>
        </tr>`;
    }).join('');

    const tot = { aipPs: 0, aipMooe: 0, aipCo: 0, abPs: 0, abMooe: 0, abCo: 0, abTotal: 0 };
    programs.forEach(p => {
        tot.aipPs += (p.aipAmount && p.aipAmount.ps) || 0;
        tot.aipMooe += (p.aipAmount && p.aipAmount.mooe) || 0;
        tot.aipCo += (p.aipAmount && p.aipAmount.co) || 0;
        tot.abPs += (p.annualBudget && p.annualBudget.ps) || 0;
        tot.abMooe += (p.annualBudget && p.annualBudget.mooe) || 0;
        tot.abCo += (p.annualBudget && p.annualBudget.co) || 0;
        tot.abTotal += (p.annualBudget && p.annualBudget.total) || 0;
    });
    bodyEl.innerHTML = bodyRows + `
        <tr class="total-row">
            <td colspan="2"><strong>TOTAL APPROPRIATION</strong></td>
            <td><strong>${tot.aipPs.toFixed(2)}</strong></td>
            <td><strong>${tot.aipMooe.toFixed(2)}</strong></td>
            <td><strong>${tot.aipCo.toFixed(2)}</strong></td>
            <td><strong>${tot.abPs.toFixed(2)}</strong></td>
            <td><strong>${tot.abMooe.toFixed(2)}</strong></td>
            <td><strong>${tot.abCo.toFixed(2)}</strong></td>
            <td><strong>${tot.abTotal.toFixed(2)}</strong></td>
            <td colspan="16"></td>
        </tr>`;
}

function recomputeOfficeEditorTotals() {
    const inOfficeEditor = document.getElementById('office-editor-card')?.style.display === 'block';
    const bodyId = inOfficeEditor ? 'office-editor-body' : 'report-detail-body';
    const body = document.getElementById(bodyId);
    if (!body) return;
    const totalRow = body.querySelector('.total-row');
    if (!totalRow) return;
    const dataRows = body.querySelectorAll('tr:not(.total-row)');
    if (dataRows.length === 0) return;
    const reportType = inOfficeEditor ? editingOfficeTab : (viewingReportType || activeReportType);
    const isPhysical = reportType === 'physical';
    const isAnnual = reportType === 'annual' || reportType === 'annual_financial';
    const totals = { aipPs: 0, aipMooe: 0, aipCo: 0, abPs: 0, abMooe: 0, abCo: 0, abTotal: 0, allot: 0, oblig: 0 };
    dataRows.forEach(row => {
        const g = (sel) => parseFloat(row.querySelector(sel)?.value) || 0;
        totals.aipPs += g('[data-field="aip_ps"]'); totals.aipMooe += g('[data-field="aip_mooe"]');
        totals.aipCo += g('[data-field="aip_co"]'); totals.abPs += g('[data-field="ab_ps"]');
        totals.abMooe += g('[data-field="ab_mooe"]'); totals.abCo += g('[data-field="ab_co"]');
        totals.abTotal += g('[data-field="ab_total"]');
        if (!isPhysical) {
            totals.allot += g('[data-field="allotment"]');
            totals.oblig += g('[data-field="obligations"]');
        }
    });
    const cells = totalRow.querySelectorAll('td, th');
    const set = (idx, val) => { if (cells[idx]) cells[idx].innerHTML = `<strong>${val}</strong>`; };
    set(1, totals.aipPs.toFixed(2)); set(2, totals.aipMooe.toFixed(2)); set(3, totals.aipCo.toFixed(2));
    set(4, totals.abPs.toFixed(2)); set(5, totals.abMooe.toFixed(2)); set(6, totals.abCo.toFixed(2)); set(7, totals.abTotal.toFixed(2));
    if (!isPhysical) {
        set(8, totals.allot.toFixed(2)); set(9, totals.oblig.toFixed(2));
        const variance = totals.allot - totals.oblig;
        const absorptive = totals.allot > 0 ? ((totals.oblig / totals.allot) * 100).toFixed(2) : '0.00';
        set(10, variance.toFixed(2)); set(11, absorptive + '%');
    }
}

function autoComputeRow(el) {
    const row = el.closest('tr');
    if (!row) return;
    const inOfficeEditor = document.getElementById('office-editor-card')?.style.display === 'block';
    const field = el.dataset.field;
    if (inOfficeEditor && (field === 'ab_ps' || field === 'ab_mooe' || field === 'ab_co')) {
        const code = row.querySelector('[data-field="code"]')?.value;
        const office = officeMap.get(editingOfficeId);
        if (code && office && office.programs) {
            const master = office.programs.find(m => m.code === code);
            if (master) {
                if (!master.annualBudget) master.annualBudget = { ps: 0, mooe: 0, co: 0, total: 0 };
                const val = parseFloat(el.value) || 0;
                if (field === 'ab_ps') master.annualBudget.ps = val;
                else if (field === 'ab_mooe') master.annualBudget.mooe = val;
                else if (field === 'ab_co') master.annualBudget.co = val;
                master.annualBudget.total = master.annualBudget.ps + master.annualBudget.mooe + master.annualBudget.co;
            }
        }
    }
    const reportType = inOfficeEditor ? editingOfficeTab : (viewingReportType || activeReportType);
    const isAnnual = reportType === 'annual' || reportType === 'annual_financial';
    const ps = parseFloat(row.querySelector('[data-field="ab_ps"]')?.value) || 0;
    const mooe = parseFloat(row.querySelector('[data-field="ab_mooe"]')?.value) || 0;
    const co = parseFloat(row.querySelector('[data-field="ab_co"]')?.value) || 0;
    const allotment = isAnnual ? (ps + mooe + co) : (ps + mooe + co) / 4;
    const allotmentInput = row.querySelector('[data-field="allotment"]');
    if (allotmentInput) allotmentInput.value = allotment.toFixed(2);
    const obligations = parseFloat(row.querySelector('[data-field="obligations"]')?.value) || 0;
    const variance = allotment - obligations;
    const absorptive = allotment > 0 ? (obligations / allotment) * 100 : 0;
    const vSpan = row.querySelector('[data-display="variance"]');
    const absSpan = row.querySelector('[data-display="absorptive"]');
    if (vSpan) vSpan.textContent = variance.toFixed(2);
    if (absSpan) absSpan.textContent = absorptive.toFixed(2) + '%';
    recomputeOfficeEditorTotals();
}

function renderAnnualDetail(programs, office, headEl, bodyEl, readOnly) {
    if (!headEl) headEl = document.getElementById('report-detail-head');
    if (!bodyEl) bodyEl = document.getElementById('report-detail-body');
    const progData = office ? office.programs : [];

    headEl.innerHTML = `<tr>
        <th rowspan="3">AIP Code</th>
        <th rowspan="3">Program / Project</th>
        <th colspan="3">AIP Amount FY ${currentYear}</th>
        <th colspan="4">Annual Budget Amount FY ${currentYear}</th>
        <th colspan="5">Annual Financial Performance</th>
        <th rowspan="3">Proof of Payment</th>
        <th rowspan="3">Action</th>
    </tr>
    <tr>
        <th>PS</th><th>MOOE</th><th>CO</th>
        <th>PS</th><th>MOOE</th><th>CO</th><th>Total</th>
        <th>Allotment Released</th>
        <th>Actual Obligations Incurred</th>
        <th>Variance</th>
        <th>Absorptive Capacity</th>
        <th>Remarks</th>
    </tr>`;

    if (programs.length === 0) {
        const colspan = readOnly ? 15 : 16;
        bodyEl.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;padding:24px;color:var(--muted);">${readOnly ? 'No submitted data.' : 'No submitted data yet. Click "+ Add Row" to begin.'}</td></tr>`;
        return;
    }

    programs = programs.filter(p => p.name !== 'TOTAL APPROPRIATION' && p.name !== 'TOTAL APPROPRIATIONS');
    const bodyRows = programs.map((p, i) => {
        const master = progData.find(m => m.code === p.code) || {};
        const aip = p.aipAmount || master.aipAmount || {};
        const ab = p.annualBudget || master.annualBudget || {};
        const fmt = v => (v || 0).toFixed(2);
        if (readOnly) {
            return `
            <tr>
                <td><span>${escapeHtml(p.code)}</span></td>
                <td><span>${escapeHtml(p.name)}</span></td>
                <td><span>${fmt(aip.ps)}</span></td>
                <td><span>${fmt(aip.mooe)}</span></td>
                <td><span>${fmt(aip.co)}</span></td>
                <td><span>${fmt(ab.ps)}</span></td>
                <td><span>${fmt(ab.mooe)}</span></td>
                <td><span>${fmt(ab.co)}</span></td>
                <td><span>${fmt(ab.total)}</span></td>
                <td><span>${fmt(p.allotment)}</span></td>
                <td><span>${fmt(p.obligations)}</span></td>
                <td><span>${fmt(p.variance)}</span></td>
                <td><span>${fmt(p.absorptive)}%</span></td>
                <td><span>${escapeHtml(p.remarks || '')}</span></td>
                <td><span>${escapeHtml(p.proofOfPayment || '')}</span></td>
            </tr>`;
        }
        return `
        <tr>
            <td><input type="text" value="${escapeHtml(p.code)}" data-idx="${i}" data-field="code" style="width:120px"></td>
            <td><input type="text" value="${escapeHtml(p.name)}" data-idx="${i}" data-field="name" style="width:220px"></td>
            <td><input type="number" step="0.01" value="${aip.ps || 0}" data-idx="${i}" data-field="aip_ps" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${aip.mooe || 0}" data-idx="${i}" data-field="aip_mooe" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${aip.co || 0}" data-idx="${i}" data-field="aip_co" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${ab.ps || 0}" data-idx="${i}" data-field="ab_ps" style="width:110px" oninput="autoComputeRow(this)"></td>
            <td><input type="number" step="0.01" value="${ab.mooe || 0}" data-idx="${i}" data-field="ab_mooe" style="width:110px" oninput="autoComputeRow(this)"></td>
            <td><input type="number" step="0.01" value="${ab.co || 0}" data-idx="${i}" data-field="ab_co" style="width:110px" oninput="autoComputeRow(this)"></td>
            <td><input type="number" step="0.01" value="${ab.total || 0}" data-idx="${i}" data-field="ab_total" style="width:110px"></td>
            <td><input type="number" step="0.01" value="${p.allotment || ((ab.ps||0)+(ab.mooe||0)+(ab.co||0))}" data-idx="${i}" data-field="allotment" readonly style="width:130px"></td>
            <td><input type="number" step="0.01" value="${p.obligations || 0}" data-idx="${i}" data-field="obligations" style="width:130px" oninput="autoComputeRow(this)"></td>
            <td><span id="v_${i}" data-display="variance">${(p.variance || 0).toFixed(2)}</span></td>
            <td><span id="abs_${i}" data-display="absorptive">${(p.absorptive || 0).toFixed(2)}%</span></td>
            <td><input type="text" value="${escapeHtml(p.remarks || '')}" data-idx="${i}" data-field="remarks" style="width:150px"></td>
            <td><input type="text" value="${escapeHtml(p.proofOfPayment || '')}" data-idx="${i}" data-field="proof" style="width:160px"></td>
            <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="deleteAdminRow(this)">×</button></td>
        </tr>`;
    }).join('');

    const tot = { aipPs: 0, aipMooe: 0, aipCo: 0, abPs: 0, abMooe: 0, abCo: 0, abTotal: 0, allot: 0, oblig: 0 };
    programs.forEach(p => {
        const master = progData.find(m => m.code === p.code) || {};
        const aip = p.aipAmount || master.aipAmount || {};
        const ab = master.annualBudget || p.annualBudget || {};
        tot.aipPs += aip.ps || 0; tot.aipMooe += aip.mooe || 0; tot.aipCo += aip.co || 0;
        tot.abPs += ab.ps || 0; tot.abMooe += ab.mooe || 0; tot.abCo += ab.co || 0; tot.abTotal += ab.total || 0;
        tot.allot += p.allotment || ((ab.ps||0)+(ab.mooe||0)+(ab.co||0));
        tot.oblig += p.obligations || 0;
    });
    const variance = tot.allot - tot.oblig;
    const absorptive = tot.allot > 0 ? ((tot.oblig / tot.allot) * 100).toFixed(2) : '0.00';
    bodyEl.innerHTML = bodyRows + `
        <tr class="total-row">
            <td colspan="2"><strong>TOTAL APPROPRIATION</strong></td>
            <td><strong>${tot.aipPs.toFixed(2)}</strong></td>
            <td><strong>${tot.aipMooe.toFixed(2)}</strong></td>
            <td><strong>${tot.aipCo.toFixed(2)}</strong></td>
            <td><strong>${tot.abPs.toFixed(2)}</strong></td>
            <td><strong>${tot.abMooe.toFixed(2)}</strong></td>
            <td><strong>${tot.abCo.toFixed(2)}</strong></td>
            <td><strong>${tot.abTotal.toFixed(2)}</strong></td>
            <td><strong>${tot.allot.toFixed(2)}</strong></td>
            <td><strong>${tot.oblig.toFixed(2)}</strong></td>
            <td><strong>${variance.toFixed(2)}</strong></td>
            <td><strong>${absorptive}%</strong></td>
            <td></td>
            <td></td>
            ${readOnly ? '' : '<td></td>'}
        </tr>`;
}

function renderAipOfficeEditorDetail(rows, headEl, bodyEl) {
    if (!headEl) headEl = document.getElementById('report-detail-head');
    if (!bodyEl) bodyEl = document.getElementById('report-detail-body');

    headEl.innerHTML = `<tr>
        <th rowspan="2">AIP Ref. Code</th>
        <th rowspan="2">Programs, Projects and Activities</th>
        <th rowspan="2">Implementing Office / Dept</th>
        <th rowspan="2">Start Date</th>
        <th rowspan="2">Completion Date</th>
        <th rowspan="2">Expected Outputs</th>
        <th rowspan="2">Funding Source</th>
        <th colspan="5">Amount</th>
        <th rowspan="2">CC Expenditure</th>
        <th rowspan="2">CC Adaptation / Mitigation</th>
        <th rowspan="2">CC Typology Code</th>
        <th rowspan="2">Action</th>
    </tr>
    <tr>
        <th>PS</th><th>MOOE</th><th>FE</th><th>CO</th><th>Total</th>
    </tr>`;

    bodyEl.innerHTML = rows.map((r, i) => {
        const total = (r.ps || 0) + (r.mooe || 0) + (r.fe || 0) + (r.co || 0);
        return `
        <tr>
            <td><input type="text" value="${escapeHtml(r.refCode || '')}" data-idx="${i}" data-field="aip_ref" style="width:120px"></td>
            <td><input type="text" value="${escapeHtml(r.program || '')}" data-idx="${i}" data-field="aip_program" style="width:220px"></td>
            <td><input type="text" value="${escapeHtml(r.implementingOffice || '')}" data-idx="${i}" data-field="aip_office" style="width:160px"></td>
            <td><input type="month" value="${escapeHtml(r.startDate || '')}" data-idx="${i}" data-field="aip_start" style="width:140px"></td>
            <td><input type="month" value="${escapeHtml(r.completionDate || '')}" data-idx="${i}" data-field="aip_end" style="width:140px"></td>
            <td><input type="text" value="${escapeHtml(r.expectedOutputs || '')}" data-idx="${i}" data-field="aip_outputs" style="width:160px"></td>
            <td><input type="text" value="${escapeHtml(r.fundingSource || '')}" data-idx="${i}" data-field="aip_funding" style="width:130px"></td>
            <td><input type="number" step="0.01" value="${r.ps || 0}" data-idx="${i}" data-field="aip_ps" style="width:110px" oninput="recalcAipEditorTotal(${i})"></td>
            <td><input type="number" step="0.01" value="${r.mooe || 0}" data-idx="${i}" data-field="aip_mooe" style="width:110px" oninput="recalcAipEditorTotal(${i})"></td>
            <td><input type="number" step="0.01" value="${r.fe || 0}" data-idx="${i}" data-field="aip_fe" style="width:110px" oninput="recalcAipEditorTotal(${i})"></td>
            <td><input type="number" step="0.01" value="${r.co || 0}" data-idx="${i}" data-field="aip_co" style="width:110px" oninput="recalcAipEditorTotal(${i})"></td>
            <td><span id="oe_aip_total_${i}">${total.toFixed(2)}</span></td>
            <td><input type="number" step="0.01" value="${r.ccExpenditure || 0}" data-idx="${i}" data-field="aip_cc" style="width:130px"></td>
            <td><input type="text" value="${escapeHtml(r.ccAdaptation || '')}" data-idx="${i}" data-field="aip_cc_type" style="width:140px"></td>
            <td><input type="text" value="${escapeHtml(r.ccTypology || '')}" data-idx="${i}" data-field="aip_cc_code" style="width:130px"></td>
            <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="deleteAdminRow(this)">×</button></td>
        </tr>`;
    }).join('');
}

function recalcAipEditorTotal(index) {
    const row = document.querySelector(`#office-editor-body tr:nth-child(${index + 1})`);
    if (!row) return;
    const inputs = row.querySelectorAll('input');
    let ps = 0, mooe = 0, fe = 0, co = 0;
    inputs.forEach(inp => {
        const f = inp.dataset.field;
        const v = parseFloat(inp.value) || 0;
        if (f === 'aip_ps') ps = v;
        else if (f === 'aip_mooe') mooe = v;
        else if (f === 'aip_fe') fe = v;
        else if (f === 'aip_co') co = v;
    });
    const total = ps + mooe + fe + co;
    const span = document.getElementById(`oe_aip_total_${index}`);
    if (span) span.textContent = total.toFixed(2);
}

function renderAipReportDetail(rows) {
    const headEl = document.getElementById('report-detail-head');
    const bodyEl = document.getElementById('report-detail-body');

    headEl.innerHTML = `<tr>
        <th rowspan="2">AIP Ref. Code</th>
        <th rowspan="2">Programs, Projects and Activities</th>
        <th rowspan="2">Implementing Office / Dept</th>
        <th rowspan="2">Start Date</th>
        <th rowspan="2">Completion Date</th>
        <th rowspan="2">Expected Outputs</th>
        <th rowspan="2">Funding Source</th>
        <th colspan="5">Amount</th>
        <th rowspan="2">CC Expenditure</th>
        <th rowspan="2">CC Adaptation / Mitigation</th>
        <th rowspan="2">CC Typology Code</th>
        <th rowspan="2">Action</th>
    </tr>
    <tr>
        <th>PS</th><th>MOOE</th><th>FE</th><th>CO</th><th>Total</th>
    </tr>`;

    bodyEl.innerHTML = rows.map((r, i) => {
        const total = (parseFloat(r.ps) || 0) + (parseFloat(r.mooe) || 0) + (parseFloat(r.fe) || 0) + (parseFloat(r.co) || 0);
        return `<tr>
            <td><input type="text" value="${escapeHtml(r.refCode || '')}" data-idx="${i}" data-field="aip_ref" style="width:120px"></td>
            <td><input type="text" value="${escapeHtml(r.program || '')}" data-idx="${i}" data-field="aip_program" style="width:220px"></td>
            <td><input type="text" value="${escapeHtml(r.implementingOffice || '')}" data-idx="${i}" data-field="aip_office" style="width:160px"></td>
            <td><input type="month" value="${escapeHtml(r.startDate || '')}" data-idx="${i}" data-field="aip_start" style="width:140px"></td>
            <td><input type="month" value="${escapeHtml(r.completionDate || '')}" data-idx="${i}" data-field="aip_end" style="width:140px"></td>
            <td><input type="text" value="${escapeHtml(r.expectedOutputs || '')}" data-idx="${i}" data-field="aip_outputs" style="width:160px"></td>
            <td><input type="text" value="${escapeHtml(r.fundingSource || '')}" data-idx="${i}" data-field="aip_funding" style="width:130px"></td>
            <td><input type="number" step="0.01" value="${parseFloat(r.ps) || 0}" data-idx="${i}" data-field="aip_ps" style="width:110px" oninput="recalcAipReportTotal(${i})"></td>
            <td><input type="number" step="0.01" value="${parseFloat(r.mooe) || 0}" data-idx="${i}" data-field="aip_mooe" style="width:110px" oninput="recalcAipReportTotal(${i})"></td>
            <td><input type="number" step="0.01" value="${parseFloat(r.fe) || 0}" data-idx="${i}" data-field="aip_fe" style="width:110px" oninput="recalcAipReportTotal(${i})"></td>
            <td><input type="number" step="0.01" value="${parseFloat(r.co) || 0}" data-idx="${i}" data-field="aip_co" style="width:110px" oninput="recalcAipReportTotal(${i})"></td>
            <td><span id="rd_aip_total_${i}">${total.toFixed(2)}</span></td>
            <td><input type="number" step="0.01" value="${parseFloat(r.ccExpenditure) || 0}" data-idx="${i}" data-field="aip_cc" style="width:130px"></td>
            <td><input type="text" value="${escapeHtml(r.ccAdaptation || '')}" data-idx="${i}" data-field="aip_cc_type" style="width:140px"></td>
            <td><input type="text" value="${escapeHtml(r.ccTypology || '')}" data-idx="${i}" data-field="aip_cc_code" style="width:130px"></td>
            <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="this.closest('tr').remove()">×</button></td>
        </tr>`;
    }).join('');
}

function recalcAipReportTotal(index) {
    const row = document.querySelector(`#report-detail-body tr:nth-child(${index + 1})`);
    if (!row) return;
    const inputs = row.querySelectorAll('input');
    let ps = 0, mooe = 0, fe = 0, co = 0;
    inputs.forEach(inp => {
        const f = inp.dataset.field;
        const v = parseFloat(inp.value) || 0;
        if (f === 'aip_ps') ps = v;
        else if (f === 'aip_mooe') mooe = v;
        else if (f === 'aip_fe') fe = v;
        else if (f === 'aip_co') co = v;
    });
    const total = ps + mooe + fe + co;
    const span = document.getElementById(`rd_aip_total_${index}`);
    if (span) span.textContent = total.toFixed(2);
}

function addReportRow() {
    const bodyEl = document.getElementById('report-detail-body');
    const type = viewingReportType;
    const rows = bodyEl.querySelectorAll('tr');
    const idx = rows.length;

    let emptyRow = '';
    if (type === 'physical') {
        emptyRow = `
            <tr>
                <td><input type="text" value="" data-idx="${idx}" data-field="code" style="width:120px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="name" style="width:220px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="mfo" style="width:160px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="pi" style="width:160px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="t1" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="a1" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="t2" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="a2" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="t3" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="a3" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="t4" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="a4" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="target_total" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="actual_total" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="remarks" style="width:150px"></td>
                <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="this.closest('tr').remove()">×</button></td>
            </tr>`;
    } else if (type === 'aip') {
        emptyRow = `<tr>
            <td><input type="text" value="" data-idx="${idx}" data-field="aip_ref" style="width:120px"></td>
            <td><input type="text" value="" data-idx="${idx}" data-field="aip_program" style="width:220px"></td>
            <td><input type="text" value="" data-idx="${idx}" data-field="aip_office" style="width:160px"></td>
            <td><input type="month" value="" data-idx="${idx}" data-field="aip_start" style="width:140px"></td>
            <td><input type="month" value="" data-idx="${idx}" data-field="aip_end" style="width:140px"></td>
            <td><input type="text" value="" data-idx="${idx}" data-field="aip_outputs" style="width:160px"></td>
            <td><input type="text" value="" data-idx="${idx}" data-field="aip_funding" style="width:130px"></td>
            <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_ps" style="width:110px" oninput="recalcAipReportTotal(${idx})"></td>
            <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_mooe" style="width:110px" oninput="recalcAipReportTotal(${idx})"></td>
            <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_fe" style="width:110px" oninput="recalcAipReportTotal(${idx})"></td>
            <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_co" style="width:110px" oninput="recalcAipReportTotal(${idx})"></td>
            <td><span id="rd_aip_total_${idx}">0.00</span></td>
            <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_cc" style="width:130px"></td>
            <td><input type="text" value="" data-idx="${idx}" data-field="aip_cc_type" style="width:140px"></td>
            <td><input type="text" value="" data-idx="${idx}" data-field="aip_cc_code" style="width:130px"></td>
            <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="this.closest('tr').remove()">×</button></td>
        </tr>`;
    } else {
        const isAnnual = type === 'annual_financial';
        emptyRow = `
            <tr>
                <td><input type="text" value="" data-idx="${idx}" data-field="code" style="width:120px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="name" style="width:220px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_ps" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_mooe" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_co" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="ab_ps" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="ab_mooe" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="ab_co" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="ab_total" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="allotment" style="width:130px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="obligations" style="width:130px"></td>
                <td><span id="v_${idx}">0.00</span></td>
                <td><span id="abs_${idx}">0.00%</span></td>
                ${isAnnual ? '<td><input type="text" value="" data-idx="' + idx + '" data-field="proof" style="width:160px"></td>' : ''}
                <td><input type="text" value="" data-idx="${idx}" data-field="remarks" style="width:150px"></td>
                <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="this.closest('tr').remove()">×</button></td>
            </tr>`;
    }
    const totalRow = bodyEl.querySelector('.total-row');
    if (totalRow) {
        totalRow.insertAdjacentHTML('beforebegin', emptyRow);
    } else {
        bodyEl.insertAdjacentHTML('beforeend', emptyRow);
    }
}

function backToReportsList() {
    document.getElementById('report-detail-card').style.display = 'none';
    document.getElementById('office-reports-card').style.display = 'block';
    viewingReportType = null;
    viewingReportQuarter = null;
}

function saveReportDetail(btn) {
    if (!viewingReportOfficeId) return;

    const bodyEl = document.getElementById('report-detail-body');
    const rows = bodyEl.querySelectorAll('tr');
    const programs = [];
    const type = viewingReportType;
    const quarter = viewingReportQuarter || '';

    if (type === 'aip') {
        const aipData = [];
        rows.forEach(tr => {
            const inputs = tr.querySelectorAll('input');
            const rowData = {};
            inputs.forEach(inp => {
                const field = inp.dataset.field;
                const val = inp.value;
                if (field === 'aip_ref') rowData.refCode = val;
                else if (field === 'aip_program') rowData.program = val;
                else if (field === 'aip_office') rowData.implementingOffice = val;
                else if (field === 'aip_start') rowData.startDate = val;
                else if (field === 'aip_end') rowData.completionDate = val;
                else if (field === 'aip_outputs') rowData.expectedOutputs = val;
                else if (field === 'aip_funding') rowData.fundingSource = val;
                else if (field === 'aip_ps') rowData.ps = parseFloat(val) || 0;
                else if (field === 'aip_mooe') rowData.mooe = parseFloat(val) || 0;
                else if (field === 'aip_fe') rowData.fe = parseFloat(val) || 0;
                else if (field === 'aip_co') rowData.co = parseFloat(val) || 0;
                else if (field === 'aip_cc') rowData.ccExpenditure = parseFloat(val) || 0;
                else if (field === 'aip_cc_type') rowData.ccAdaptation = val;
                else if (field === 'aip_cc_code') rowData.ccTypology = val;
            });
            aipData.push(rowData);
        });
        const nonEmptyAipData = aipData.filter(r => !isAipRowEmpty(r));

        const office = officeMap.get(viewingReportOfficeId);
        const body = {
            office: viewingReportOfficeId,
            officeName: office ? office.name : '',
            year: currentYear,
            submittedAt: new Date().toISOString(),
            data: nonEmptyAipData
        };

        showConfirmDialog({
            title: 'Save AIP Changes',
            message: 'This will overwrite existing AIP data. Continue?',
            confirmText: 'Save',
            cancelText: 'Cancel'
        }).then(confirmed => {
            if (!confirmed) return;
            if (btn) setLoading(btn, true);

            fetchWithTimeout('/api/aip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    showToast('AIP saved successfully!', 'success');
                    backToReportsList();
                    viewOfficeReports(viewingReportOfficeId);
                } else {
                    showToast('Failed to save AIP.', 'error');
                }
                if (btn) setLoading(btn, false);
            })
            .catch(() => {
                showToast('Error saving AIP.', 'error');
                if (btn) setLoading(btn, false);
            });
        });
        return;
    }

    rows.forEach((tr, idx) => {
        const inputs = tr.querySelectorAll('input');
        const prog = { code: '', name: '', remarks: '' };

        inputs.forEach(inp => {
            const field = inp.dataset.field;
            const val = inp.value;
            if (field === 'code') prog.code = val;
            else if (field === 'name') prog.name = val;
            else if (field === 'remarks') prog.remarks = val;
            else if (field === 'allotment') prog.allotment = parseFloat(val) || 0;
            else if (field === 'obligations') prog.obligations = parseFloat(val) || 0;
            else if (field === 'proof') prog.proofOfPayment = val;
            else if (field === 'mfo') prog.mfo = val;
            else if (field === 'pi') prog.performanceIndicator = val;
            else if (field === 'aip_ps' || field === 'aip_mooe' || field === 'aip_co' ||
                     field === 'ab_ps' || field === 'ab_mooe' || field === 'ab_co' || field === 'ab_total') {
                if (!prog.aipAmount) prog.aipAmount = {};
                if (!prog.annualBudget) prog.annualBudget = {};
                if (field === 'aip_ps') prog.aipAmount.ps = parseFloat(val) || 0;
                else if (field === 'aip_mooe') prog.aipAmount.mooe = parseFloat(val) || 0;
                else if (field === 'aip_co') prog.aipAmount.co = parseFloat(val) || 0;
                else if (field === 'ab_ps') prog.annualBudget.ps = parseFloat(val) || 0;
                else if (field === 'ab_mooe') prog.annualBudget.mooe = parseFloat(val) || 0;
                else if (field === 'ab_co') prog.annualBudget.co = parseFloat(val) || 0;
                else if (field === 'ab_total') prog.annualBudget.total = parseFloat(val) || 0;
            }
            else if (field === 't1' || field === 't2' || field === 't3' || field === 't4' || field === 'a1' || field === 'a2' || field === 'a3' || field === 'a4') {
                if (!prog.target) prog.target = ['', '', '', ''];
                if (!prog.actual) prog.actual = ['', '', '', ''];
                const qIdx = parseInt(field[1]) - 1;
                if (field[0] === 't') prog.target[qIdx] = val;
                else prog.actual[qIdx] = val;
            }
            else if (field === 'target_total') prog.targetTotal = val;
            else if (field === 'actual_total') prog.actualTotal = val;
        });

        if (prog.allotment !== undefined && prog.obligations !== undefined) {
            prog.variance = prog.allotment - prog.obligations;
            prog.absorptive = prog.allotment > 0 ? Number(((prog.obligations / prog.allotment) * 100).toFixed(2)) : 0;
        }
        if (prog.targetTotal !== undefined && prog.actualTotal !== undefined) {
            const tn = parseFloat(prog.targetTotal);
            const an = parseFloat(prog.actualTotal);
            if (!isNaN(tn) && !isNaN(an)) {
                prog.variance = tn - an;
                prog.accomplishment = tn > 0 ? Number(((an / tn) * 100).toFixed(2)) : 0;
            } else {
                prog.variance = 'N/A';
                prog.accomplishment = 'N/A';
            }
        } else if (prog.target && prog.actual) {
            const targetNums = prog.target.map(v => parseFloat(v)).filter(v => !isNaN(v));
            const actualNums = prog.actual.map(v => parseFloat(v)).filter(v => !isNaN(v));
            const targetTotal = targetNums.reduce((s, v) => s + v, 0);
            const actualTotal = actualNums.reduce((s, v) => s + v, 0);
            prog.targetTotal = targetTotal;
            prog.actualTotal = actualTotal;
            prog.variance = targetTotal - actualTotal;
            prog.accomplishment = targetTotal > 0 ? Number(((actualTotal / targetTotal) * 100).toFixed(2)) : 0;
        }

        programs.push(prog);
    });

    saveProgramsToServer(programs);

    const office = officeMap.get(viewingReportOfficeId);
    const body = {
        office: viewingReportOfficeId,
        officeName: office ? office.name : '',
        quarter: quarter,
        year: currentYear,
        report_type: type,
        status: 'submitted',
        submittedAt: new Date().toISOString(),
        programs: programs
    };

    showConfirmDialog({
        title: 'Save Report Changes',
        message: 'This will overwrite existing report data. Continue?',
        confirmText: 'Save',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        if (btn) setLoading(btn, true);

        fetchWithTimeout('/api/reports/' + viewingReportOfficeId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('Report updated successfully!', 'success');
                backToReportsList();
                viewOfficeReports(viewingReportOfficeId);
            } else {
                showToast('Failed to save report.', 'error');
            }
            if (btn) setLoading(btn, false);
        })
        .catch(() => {
            showToast('Error saving report.', 'error');
            if (btn) setLoading(btn, false);
        });
    });
}

let editingOfficeId = null;
let editingOfficeTab = 'programs';
let editingOfficeQuarter = 'Q1';

function showAddOfficeDialog() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-dialog" style="max-width:420px;text-align:left;">
                <div class="confirm-icon">&#43;</div>
                <h3>Add Office</h3>
                <div class="dialog-form">
                    <label>Office ID <input type="text" id="dialog-office-id" placeholder="e.g. NEW-OFFICE" class="input-text" style="width:100%;"></label>
                    <label>Office Name <input type="text" id="dialog-office-name" placeholder="e.g. New Office" class="input-text" style="width:100%;"></label>
                    <label>Office Password <input type="text" id="dialog-office-password" placeholder="Enter password" class="input-text" style="width:100%;"></label>
                </div>
                <div class="confirm-actions">
                    <button class="btn-cancel">Cancel</button>
                    <button class="btn-confirm-delete" id="dialog-add-confirm">Add Office</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = (result) => { overlay.remove(); resolve(result); };
        overlay.querySelector('.btn-cancel').onclick = () => close(null);
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
        const confirmBtn = overlay.querySelector('#dialog-add-confirm');
        const idInput = overlay.querySelector('#dialog-office-id');
        const nameInput = overlay.querySelector('#dialog-office-name');
        const passInput = overlay.querySelector('#dialog-office-password');
        confirmBtn.onclick = () => {
            const id = idInput.value.trim();
            const name = nameInput.value.trim();
            const password = passInput.value.trim();
            if (!id) { showToast('Please enter an Office ID.', 'error'); idInput.focus(); return; }
            if (!name) { showToast('Please enter an Office Name.', 'error'); nameInput.focus(); return; }
            if (!password) { showToast('Please enter an Office Password.', 'error'); passInput.focus(); return; }
            close({ id, name, password });
        };
        idInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.focus(); });
        nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') passInput.focus(); });
        passInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmBtn.click(); });
        setTimeout(() => idInput.focus(), 100);
    });
}

function addOffice(btn) {
     showAddOfficeDialog().then(result => {
         if (!result) return;
         if (btn) setLoading(btn, true);
         fetchWithTimeout('/api/offices', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ id: result.id, name: result.name, password: result.password })
         })
         .then(r => r.json())
         .then(d => {
             if (d.success) {
                 refreshOfficeList().then(() => {
                     renderOfficesTable();
                     populateOfficeSelect();
                 });
             } else {
                 showToast('Failed to add office: ' + (d.error || 'unknown error'), 'error');
             }
             if (btn) setLoading(btn, false);
         })
         .catch(() => {
             showToast('Error adding office.', 'error');
             if (btn) setLoading(btn, false);
         });
     });
}

function deleteOffice(officeId) {
    showConfirmDialog({
        title: 'Delete Office',
        message: 'Delete this office and all its programs and reports?',
        confirmText: 'Delete',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        fetchWithTimeout('/api/offices/' + officeId, { method: 'DELETE' })
        .then(r => r.json())
        .then(d => {
            if (d.success) {
                refreshOfficeList().then(() => {
                    renderOfficesTable();
                    const dp = document.getElementById('dashboard-page-dashboard');
                    if (dp && dp.style.display !== 'none') loadDashboardData();
                });
            } else {
                showToast('Failed to delete office.', 'error');
            }
        })
        .catch(() => showToast('Error deleting office.', 'error'));
    });
}

function editOffice(officeId) {
    const office = officeMap.get(officeId);
    if (!office) {
        showToast('Office not found.', 'error');
        return;
    }
    editingOfficeId = officeId;
    editingOfficeTab = 'quarterly';
    editingOfficeQuarter = 'Q1';

    document.getElementById('offices-table-card').style.display = 'none';
    document.getElementById('office-editor-card').style.display = 'block';
    document.getElementById('office-editor-title').textContent = 'Editing: ' + office.name;

    // Set active tab and show quarter bar
    document.querySelectorAll('#office-editor-card .report-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === 'quarterly');
    });
    document.getElementById('office-editor-quarter-bar').style.display = 'flex';

    // Load quarterly report data
    const headEl = document.getElementById('office-editor-head');
    const bodyEl = document.getElementById('office-editor-body');
    loadOfficeEditorReportTab(headEl, bodyEl, 'quarterly', 'Q1', office);
}

function closeOfficeEditor() {
    editingOfficeId = null;
    editingOfficeTab = 'quarterly';
    editingOfficeQuarter = 'Q1';
    document.getElementById('offices-table-card').style.display = 'block';
    document.getElementById('office-editor-card').style.display = 'none';
    renderOfficesTable();
}

// Office Editor Tab Functions
function switchOfficeEditorTab(tab, btn) {
    editingOfficeTab = tab;

    document.querySelectorAll('#office-editor-card .report-tab').forEach(t => {
        t.classList.remove('active');
    });
    if (btn) btn.classList.add('active');

    const qbar = document.getElementById('office-editor-quarter-bar');
    if (qbar) qbar.style.display = tab === 'quarterly' ? 'flex' : 'none';

    const headEl = document.getElementById('office-editor-head');
    const bodyEl = document.getElementById('office-editor-body');
    const office = officeMap.get(editingOfficeId);
    if (!office) return;

    const quarter = tab === 'quarterly' ? editingOfficeQuarter : '';
    const type = tab === 'quarterly' ? 'quarterly' : tab === 'physical' ? 'physical' : tab === 'annual' ? 'annual_financial' : 'aip';
    loadOfficeEditorReportTab(headEl, bodyEl, type, quarter, office);
}

function switchOfficeEditorQuarter(quarter) {
    editingOfficeQuarter = quarter;
    if (editingOfficeTab === 'quarterly') {
        const headEl = document.getElementById('office-editor-head');
        const bodyEl = document.getElementById('office-editor-body');
        const office = officeMap.get(editingOfficeId);
        if (office) {
            loadOfficeEditorReportTab(headEl, bodyEl, 'quarterly', quarter, office);
        }
    }
}

function loadOfficeEditorReportTab(headEl, bodyEl, type, quarter, office) {
    bodyEl.innerHTML = '<tr><td colspan="20" style="text-align:center;padding:32px;"><div class="loading-wrap row" style="padding:0"><div class="spinner-md"></div><span>Loading...</span></div></td></tr>';

    const typeLabel = type === 'quarterly' ? 'Quarterly ' + quarter : type === 'physical' ? 'Physical Performance' : type === 'annual_financial' ? 'Annual Financial' : 'Annual Investment Program';
    document.getElementById('office-editor-title').textContent = office.name + ' - ' + typeLabel;

    if (type === 'aip') {
        fetch(`/api/aip/${editingOfficeId}?year=${currentYear}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            let rows = data && data.rows ? data.rows : [];
            if (rows.length === 0) {
                rows = Array.from({ length: 5 }, () => ({
                    refCode: '', program: '', implementingOffice: '', startDate: '', completionDate: '',
                    expectedOutputs: '', fundingSource: '', ps: 0, mooe: 0, fe: 0, co: 0, total: 0,
                    ccExpenditure: 0, ccAdaptation: '', ccTypology: ''
                }));
            }
            renderAipOfficeEditorDetail(rows, headEl, bodyEl);
        })
        .catch(() => {
            bodyEl.innerHTML = '<tr><td colspan="20" style="text-align:center;padding:24px;color:var(--muted);">Error loading AIP.</td></tr>';
        });
        return;
    }

    const url = quarter
        ? `/api/reports/${editingOfficeId}?quarter=${quarter}&type=${type}&year=${currentYear}`
        : `/api/reports/${editingOfficeId}?type=${type}&year=${currentYear}`;

    fetch(url)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
        let programs = data && data.programs ? data.programs : [];
        if (programs.length === 0 && office && office.programs && office.programs.length > 0) {
            programs = office.programs.map(p => ({
                code: p.code,
                name: p.name,
                aipAmount: p.aipAmount ? { ps: p.aipAmount.ps || 0, mooe: p.aipAmount.mooe || 0, co: p.aipAmount.co || 0 } : { ps: 0, mooe: 0, co: 0 },
                annualBudget: p.annualBudget ? { ps: p.annualBudget.ps || 0, mooe: p.annualBudget.mooe || 0, co: p.annualBudget.co || 0, total: p.annualBudget.total || 0 } : { ps: 0, mooe: 0, co: 0, total: 0 },
                mfo: p.mfo || '',
                performanceIndicator: p.performanceIndicator || '',
                allotment: 0,
                obligations: 0,
                remarks: '',
                target: ['', '', '', ''],
                actual: ['', '', '', ''],
                targetTotal: '',
                actualTotal: '',
                proofOfPayment: ''
            }));
        }
        if (type === 'physical') {
            renderPhysicalDetail(programs, office, headEl, bodyEl, false);
        } else if (type === 'quarterly') {
            renderQuarterlyDetail(programs, office, headEl, bodyEl, false);
        } else {
            renderAnnualDetail(programs, office, headEl, bodyEl, false);
        }
    })
    .catch(() => {
        bodyEl.innerHTML = '<tr><td colspan="20" style="text-align:center;padding:24px;color:var(--muted);">Error loading report.</td></tr>';
    });
}

function deleteAdminRow(btn) {
    btn.closest('tr').remove();
    saveOfficeEditor();
}

function addOfficeEditorRow() {
    const bodyEl = document.getElementById('office-editor-body');
    const rows = bodyEl.querySelectorAll('tr');
    const idx = rows.length;

    let emptyRow = '';
    if (editingOfficeTab === 'physical') {
        emptyRow = `
            <tr>
                <td><input type="text" value="" data-idx="${idx}" data-field="code" style="width:120px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="name" style="width:220px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="mfo" style="width:160px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="pi" style="width:160px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="t1" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="a1" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="t2" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="a2" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="t3" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="a3" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="t4" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="a4" style="width:110px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="target_total" style="width:110px" oninput="autoComputePhysicalAdmin(${idx})"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="actual_total" style="width:110px" oninput="autoComputePhysicalAdmin(${idx})"></td>
                <td><input type="text" id="v_${idx}" value="N/A" class="input-number" style="width:100px;"></td>
                <td><input type="text" id="abs_${idx}" value="N/A" class="input-number" style="width:100px;"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="remarks" style="width:150px"></td>
                <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="this.closest('tr').remove()">×</button></td>
            </tr>`;
    } else if (editingOfficeTab === 'aip') {
        emptyRow = `
            <tr>
                <td><input type="text" value="" data-idx="${idx}" data-field="aip_ref" style="width:120px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="aip_program" style="width:220px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="aip_office" style="width:160px"></td>
                <td><input type="month" value="" data-idx="${idx}" data-field="aip_start" style="width:140px"></td>
                <td><input type="month" value="" data-idx="${idx}" data-field="aip_end" style="width:140px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="aip_outputs" style="width:160px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="aip_funding" style="width:130px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_ps" style="width:110px" oninput="recalcAipEditorTotal(${idx})"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_mooe" style="width:110px" oninput="recalcAipEditorTotal(${idx})"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_fe" style="width:110px" oninput="recalcAipEditorTotal(${idx})"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_co" style="width:110px" oninput="recalcAipEditorTotal(${idx})"></td>
                <td><span id="oe_aip_total_${idx}">0.00</span></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_cc" style="width:130px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="aip_cc_type" style="width:140px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="aip_cc_code" style="width:130px"></td>
            <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="this.closest('tr').remove()">×</button></td>
        </tr>`;
    } else {
        const isAnnual = editingOfficeTab === 'annual';
        emptyRow = `
            <tr>
                <td><input type="text" value="" data-idx="${idx}" data-field="code" style="width:120px"></td>
                <td><input type="text" value="" data-idx="${idx}" data-field="name" style="width:220px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_ps" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_mooe" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="aip_co" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="ab_ps" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="ab_mooe" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="ab_co" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="ab_total" style="width:110px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="allotment" style="width:130px"></td>
                <td><input type="number" step="0.01" value="0" data-idx="${idx}" data-field="obligations" style="width:130px"></td>
                <td><span id="oe_v_${idx}">0.00</span></td>
                <td><span id="oe_abs_${idx}">0.00%</span></td>
                ${isAnnual ? '<td><input type="text" value="" data-idx="' + idx + '" data-field="proof" style="width:160px"></td>' : ''}
                <td><input type="text" value="" data-idx="${idx}" data-field="remarks" style="width:150px"></td>
                <td><button class="btn btn-outline btn-sm" style="color:#e74c3c;border-color:#e74c3c;padding:2px 6px;" onclick="this.closest('tr').remove()">×</button></td>
            </tr>`;
    }
    const totalRow = bodyEl.querySelector('.total-row');
    if (totalRow) {
        totalRow.insertAdjacentHTML('beforebegin', emptyRow);
    } else {
        bodyEl.insertAdjacentHTML('beforeend', emptyRow);
    }
}

function saveOfficeEditor(btn) {
    if (!editingOfficeId) return;
    if (btn) setLoading(btn, true);

    const bodyEl = document.getElementById('office-editor-body');
    const rows = bodyEl.querySelectorAll('tr');
    const programs = [];
    const type = editingOfficeTab === 'quarterly' ? 'quarterly' : editingOfficeTab === 'physical' ? 'physical' : editingOfficeTab === 'annual' ? 'annual_financial' : 'aip';
    const quarter = editingOfficeTab === 'quarterly' ? editingOfficeQuarter : '';

    if (type === 'aip') {
        const rows = [];
        document.querySelectorAll('#office-editor-body tr').forEach((tr, idx) => {
            const inputs = tr.querySelectorAll('input');
            const r = { refCode: '', program: '', implementingOffice: '', startDate: '', completionDate: '',
                       expectedOutputs: '', fundingSource: '', ps: 0, mooe: 0, fe: 0, co: 0, total: 0,
                       ccExpenditure: 0, ccAdaptation: '', ccTypology: '' };
            inputs.forEach(inp => {
                const f = inp.dataset.field;
                const v = inp.value;
                if (f === 'aip_ref') r.refCode = v;
                else if (f === 'aip_program') r.program = v;
                else if (f === 'aip_office') r.implementingOffice = v;
                else if (f === 'aip_start') r.startDate = v;
                else if (f === 'aip_end') r.completionDate = v;
                else if (f === 'aip_outputs') r.expectedOutputs = v;
                else if (f === 'aip_funding') r.fundingSource = v;
                else if (f === 'aip_ps') r.ps = parseFloat(v) || 0;
                else if (f === 'aip_mooe') r.mooe = parseFloat(v) || 0;
                else if (f === 'aip_fe') r.fe = parseFloat(v) || 0;
                else if (f === 'aip_co') r.co = parseFloat(v) || 0;
                else if (f === 'aip_cc') r.ccExpenditure = parseFloat(v) || 0;
                else if (f === 'aip_cc_type') r.ccAdaptation = v;
                else if (f === 'aip_cc_code') r.ccTypology = v;
            });
            r.total = r.ps + r.mooe + r.fe + r.co;
            rows.push(r);
        });
        const nonEmptyAipRows = rows.filter(r => !isAipRowEmpty(r));

        const office = officeMap.get(editingOfficeId);
        fetchWithTimeout('/api/aip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                office: editingOfficeId,
                officeName: office ? office.name : '',
                year: currentYear,
                status: 'submitted',
                submittedAt: new Date().toISOString(),
                rows: nonEmptyAipRows
            })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('AIP saved successfully!', 'success');
                refreshOfficeList();
                const activeBtn = document.querySelector('#office-editor-card .report-tab.active');
                switchOfficeEditorTab(editingOfficeTab, activeBtn);
            } else {
                showToast('Failed to save AIP.', 'error');
            }
            if (btn) setLoading(btn, false);
        })
        .catch(() => {
            showToast('Error saving AIP.', 'error');
            if (btn) setLoading(btn, false);
        });
        return;
    }

    rows.forEach((tr) => {
        const inputs = tr.querySelectorAll('input');
        const prog = { code: '', name: '', remarks: '' };

        inputs.forEach(inp => {
            const field = inp.dataset.field;
            const val = inp.value;
            if (field === 'code') prog.code = val;
            else if (field === 'name') prog.name = val;
            else if (field === 'remarks') prog.remarks = val;
            else if (field === 'allotment') prog.allotment = parseFloat(val) || 0;
            else if (field === 'obligations') prog.obligations = parseFloat(val) || 0;
            else if (field === 'proof') prog.proofOfPayment = val;
            else if (field === 'mfo') prog.mfo = val;
            else if (field === 'pi') prog.performanceIndicator = val;
            else if (field === 'aip_ps' || field === 'aip_mooe' || field === 'aip_co' ||
                     field === 'ab_ps' || field === 'ab_mooe' || field === 'ab_co' || field === 'ab_total') {
                if (!prog.aipAmount) prog.aipAmount = {};
                if (!prog.annualBudget) prog.annualBudget = {};
                if (field === 'aip_ps') prog.aipAmount.ps = parseFloat(val) || 0;
                else if (field === 'aip_mooe') prog.aipAmount.mooe = parseFloat(val) || 0;
                else if (field === 'aip_co') prog.aipAmount.co = parseFloat(val) || 0;
                else if (field === 'ab_ps') prog.annualBudget.ps = parseFloat(val) || 0;
                else if (field === 'ab_mooe') prog.annualBudget.mooe = parseFloat(val) || 0;
                else if (field === 'ab_co') prog.annualBudget.co = parseFloat(val) || 0;
                else if (field === 'ab_total') prog.annualBudget.total = parseFloat(val) || 0;
            }
            else if (field === 't1' || field === 't2' || field === 't3' || field === 't4' || field === 'a1' || field === 'a2' || field === 'a3' || field === 'a4') {
                if (!prog.target) prog.target = ['', '', '', ''];
                if (!prog.actual) prog.actual = ['', '', '', ''];
                const qIdx = parseInt(field[1]) - 1;
                if (field[0] === 't') prog.target[qIdx] = val;
                else prog.actual[qIdx] = val;
            }
            else if (field === 'target_total') prog.targetTotal = val;
            else if (field === 'actual_total') prog.actualTotal = val;
        });

        if (prog.allotment !== undefined && prog.obligations !== undefined) {
            prog.variance = prog.allotment - prog.obligations;
            prog.absorptive = prog.allotment > 0 ? Number(((prog.obligations / prog.allotment) * 100).toFixed(2)) : 0;
        }
        if (prog.targetTotal !== undefined && prog.actualTotal !== undefined) {
            const tn = parseFloat(prog.targetTotal);
            const an = parseFloat(prog.actualTotal);
            if (!isNaN(tn) && !isNaN(an)) {
                prog.variance = tn - an;
                prog.accomplishment = tn > 0 ? Number(((an / tn) * 100).toFixed(2)) : 0;
            } else {
                prog.variance = 'N/A';
                prog.accomplishment = 'N/A';
            }
        } else if (prog.target && prog.actual) {
            const targetNums = prog.target.map(v => parseFloat(v)).filter(v => !isNaN(v));
            const actualNums = prog.actual.map(v => parseFloat(v)).filter(v => !isNaN(v));
            const targetTotal = targetNums.reduce((s, v) => s + v, 0);
            const actualTotal = actualNums.reduce((s, v) => s + v, 0);
            prog.targetTotal = targetTotal;
            prog.actualTotal = actualTotal;
            prog.variance = targetTotal - actualTotal;
            prog.accomplishment = targetTotal > 0 ? Number(((actualTotal / targetTotal) * 100).toFixed(2)) : 0;
        }

        programs.push(prog);
    });

    fetchWithTimeout('/api/offices/' + editingOfficeId + '/programs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: currentYear, programs })
    }).catch(() => showToast('Failed to save programs.', 'error'));

    const office = officeMap.get(editingOfficeId);
    const body = {
        office: editingOfficeId,
        officeName: office ? office.name : '',
        quarter: quarter,
        year: currentYear,
        report_type: type,
        status: 'submitted',
        submittedAt: new Date().toISOString(),
        programs: programs
    };

    fetchWithTimeout('/api/reports/' + editingOfficeId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            showToast('Report saved successfully!', 'success');
            refreshOfficeList();
            // Reload current tab to reflect changes
            const activeBtn = document.querySelector('#office-editor-card .report-tab.active');
            switchOfficeEditorTab(editingOfficeTab, activeBtn);
        } else {
            showToast('Failed to save report.', 'error');
        }
        if (btn) setLoading(btn, false);
    })
    .catch(() => {
        showToast('Error saving report.', 'error');
        if (btn) setLoading(btn, false);
    });
}

// Filter office table
function filterOfficeTable(query) {
    const table = document.getElementById('offices-table');
    if (!table) return;

    const rows = table.querySelectorAll('tbody tr');
    const q = query.toLowerCase();

    rows.forEach(row => {
        const nameCell = row.cells[0];
        const match = nameCell ? nameCell.textContent.toLowerCase().includes(q) : false;
        row.style.display = match ? '' : 'none';
    });
}

// Switch between Office and Admin login tabs
function switchLoginTab(tab, element) {
    document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
    element.classList.add('active');
    document.getElementById('office-login-section').style.display = tab === 'office' ? 'block' : 'none';
    document.getElementById('admin-login-section').style.display = tab === 'admin' ? 'block' : 'none';
}

// Office Login - for office staff
function syncOfficePrograms(officeId) {
    return fetch(`/api/offices?year=${currentYear}`)
        .then(response => response.json())
        .then(serverOffices => {
            const serverOffice = serverOffices.find(o => o.id === officeId);
            if (serverOffice && serverOffice.programs) {
                const office = officeMap.get(officeId);
                if (office) {
                    office.programs = serverOffice.programs;
                }
            }
        })
        .catch(() => showToast('Failed to refresh office list.', 'error'));
}

function loginOffice() {
    const office = document.getElementById('office-select').value;
    const password = document.getElementById('office-password').value;

    if (office === '') {
        showToast('Please select your office.', 'warning');
        return;
    }

    if (password === '') {
        showToast('Please enter your password.', 'warning');
        return;
    }

    fetchWithTimeout('/api/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ office, role: 'employee', password })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            currentUser = { office, role: 'office' };
            localStorage.setItem('opencode_logged_in', '1');

            document.getElementById('login-wrapper').style.display = 'none';
            document.getElementById('employee-view').style.display = 'flex';
            document.getElementById('manager-dashboard').style.display = 'none';
            document.getElementById('global-year-bar').style.display = 'flex';

            document.body.classList.remove('show-dashboard');

            // Sync programs from database so admin edits are reflected
                syncOfficePrograms(office).then(() => {
                    populateYearSelector();
                    const dashNav = document.querySelector('#employee-view .nav-item[data-report="office-dashboard"]');
                    switchReport('office-dashboard', dashNav);
                    loadEmployeeDeadline();
                });
        } else {
            showToast('Invalid password. Please try again.', 'error');
        }
    })
    .catch(error => {
        showToast('Error connecting to server. Please try again.', 'error');
        console.error(error);
    });
}

// Admin Login - for admins
function loginAdmin() {
    const username = document.getElementById('admin-username').value;
    const password = document.getElementById('admin-password').value;

    if (username === '') {
        showToast('Please enter your username.', 'warning');
        return;
    }

    if (password === '') {
        showToast('Please enter your password.', 'warning');
        return;
    }

    fetchWithTimeout('/api/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ office: username, role: 'manager', password })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            currentUser = { username, role: 'admin' };
            localStorage.setItem('opencode_logged_in', '1');

            document.getElementById('login-wrapper').style.display = 'none';
            document.getElementById('employee-view').style.display = 'none';
            document.getElementById('manager-dashboard').style.display = 'block';
            document.getElementById('global-year-bar').style.display = 'flex';

            document.body.classList.add('show-dashboard');

            populateYearSelector();
            const dashNav = document.querySelector('#manager-dashboard .nav-item[data-page="dashboard"]');
            switchDashboardPage('dashboard', dashNav);
        } else {
            showToast('Invalid credentials. Please try again.', 'error');
        }
    })
    .catch(error => {
        showToast('Error connecting to server. Please try again.', 'error');
        console.error(error);
    });
}

function logout() {
    showConfirmDialog({
        title: 'Logout',
        message: 'Are you sure you want to logout? Any unsaved changes will be lost.',
        confirmText: 'Logout',
        confirmClass: 'btn-confirm-delete',
        cancelText: 'Cancel'
    }).then(confirmed => {
        if (!confirmed) return;
        localStorage.setItem('opencode_logout_ts', Date.now());
        localStorage.removeItem('opencode_logged_in');
        fetch('/api/logout', { method: 'POST' }).catch(() => {});
        currentUser = null;
        const empView = document.getElementById('employee-view');
        const mgrDash = document.getElementById('manager-dashboard');
        empView.style.display = 'none';
        mgrDash.style.display = 'none';
        document.getElementById('login-wrapper').style.display = 'flex';
        document.getElementById('global-year-bar').style.display = 'none';
        refreshOfficeList().then(() => populateOfficeSelect()).catch(() => populateOfficeSelect());
        document.getElementById('report-container').innerHTML = '';
        document.getElementById('office-password').value = '';
        document.getElementById('admin-username').value = '';
        document.getElementById('admin-password').value = '';
        document.body.classList.remove('show-dashboard');
    });
}

// ============================================
// Modern Dashboard Functions
// ============================================

function loadDashboardData() {
    const year = currentYear;
    const subtitle = document.getElementById('dashboard-subtitle');
    if (subtitle) subtitle.textContent = `Overview of all office submissions for FY ${year}`;
    const totalOffices = offices.length;
    let totalPrograms = 0;

    offices.forEach(office => {
        totalPrograms += office.programs.length;
    });

    document.getElementById('kpi-total-offices').textContent = totalOffices;
    document.getElementById('kpi-total-programs').textContent = totalPrograms;

    fetch(`/api/reports?type=annual_financial&year=${currentYear}`)
    .then(response => response.json())
    .then(submittedReports => {
        const submittedCount = submittedReports.length;
        const pendingCount = totalOffices - submittedCount;
        const submittedMap = {};
        submittedReports.forEach(r => { submittedMap[r.office_id] = r; });

        document.getElementById('kpi-submitted').textContent = submittedCount;
        document.getElementById('kpi-pending').textContent = pendingCount;

        const tableBody = document.getElementById('dashboard-table-body');
        tableBody.innerHTML = '';

        offices.forEach((office, index) => {
            const reportData = submittedMap[office.id];
            const isSubmitted = !!reportData;

            const row = document.createElement('tr');
            row.className = index % 2 === 0 ? 'row-even' : 'row-odd';

            row.innerHTML = `
                <td>${escapeHtml(office.name)}</td>
                <td>${office.programs.length}</td>
                <td>
                    <span class="status-badge ${isSubmitted ? 'status-submitted' : 'status-pending'}">
                        ${isSubmitted ? 'Submitted' : 'Pending'}
                    </span>
                </td>
                <td>${reportData ? formatDateTime(reportData.submitted_at) : '-'}</td>
            `;

            tableBody.appendChild(row);
        });

        drawBarChart(submittedMap);
        drawDonutChart(submittedCount, pendingCount);
        drawHorizontalBarChart();
    })
    .catch(error => {
        console.error('Error loading dashboard data:', error);
        document.getElementById('kpi-submitted').textContent = '0';
        document.getElementById('kpi-pending').textContent = '0';
    });
}

function drawBarChart(submittedMap) {
    const canvas = document.getElementById('barChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const data = offices.map(office => {
        return submittedMap && submittedMap[office.id] ? 100 : 0;
    });

    const labels = offices.map(office => office.name);

    const numBars = data.length;
    const barWidth = Math.max(8, Math.min(12, (750 - 60) / numBars - 8));
    const gap = Math.max(4, Math.min(8, barWidth * 0.5));
    const chartWidth = numBars * (barWidth + gap) + 50;
    const chartHeight = 180;
    const startX = 45;
    const startY = 230;

    canvas.width = Math.max(800, chartWidth);
    canvas.height = 280;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 30);
    ctx.lineTo(40, startY);
    ctx.stroke();

    ctx.fillStyle = '#666';
    ctx.font = '10px Arial';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 100; i += 20) {
        const y = startY - (i / 100) * chartHeight;
        ctx.fillText(i + '%', 35, y + 4);
        ctx.strokeStyle = '#eee';
        ctx.beginPath();
        ctx.moveTo(40, y);
        ctx.lineTo(canvas.width - 20, y);
        ctx.stroke();
    }

    data.forEach((value, index) => {
        const x = startX + index * (barWidth + gap);
        const barHeight = (value / 100) * chartHeight;
        const y = startY - barHeight;

        ctx.fillStyle = value > 0 ? '#28a745' : '#dc3545';
        ctx.fillRect(x, y, barWidth, barHeight);

        ctx.fillStyle = '#333';
        ctx.font = '8px Arial';
        ctx.textAlign = 'center';
        const label = labels[index].length > 10 ? labels[index].substring(0, 8) + '...' : labels[index];
        ctx.save();
        ctx.translate(x + barWidth / 2, startY + 35);
        ctx.rotate(-Math.PI / 4);
        ctx.fillText(label, 0, 0);
        ctx.restore();

        ctx.fillStyle = value > 0 ? '#28a745' : '#dc3545';
        ctx.font = 'bold 9px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(value > 0 ? '✓' : '—', x + barWidth / 2, y - 5);
    });
}

function drawDonutChart(submitted, pending) {
    const canvas = document.getElementById('donutChart');
    const ctx = canvas.getContext('2d');

    canvas.width = 200;
    canvas.height = 200;

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = 70;
    const lineWidth = 35;

    const total = submitted + pending;
    const submittedAngle = total > 0 ? (submitted / total) * 2 * Math.PI : 0;
    const pendingAngle = total > 0 ? (pending / total) * 2 * Math.PI : 0;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw submitted segment
    if (submitted > 0) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + submittedAngle);
        ctx.strokeStyle = '#28a745';
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }

    // Draw pending segment
    if (pending > 0) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, -Math.PI / 2 + submittedAngle, -Math.PI / 2 + submittedAngle + pendingAngle);
        ctx.strokeStyle = '#dc3545';
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }

    // Draw center text
    ctx.fillStyle = '#333';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const percentage = total > 0 ? Math.round((submitted / total) * 100) : 0;
    ctx.fillText(percentage + '%', centerX, centerY);
}

// ============================================
// Horizontal Bar Chart - Annual Financial Accomplishment per Office
// ============================================

function drawHorizontalBarChart() {
    const canvas = document.getElementById('horizontalBarChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    fetch(`/api/chart/annual-financial?year=${currentYear}`)
    .then(response => response.json())
    .then(chartData => {
        const chartMap = {};
        chartData.forEach(d => { chartMap[d.office] = d; });

        const officeData = offices.map(office => {
            const d = chartMap[office.id];
            if (d) {
                return {
                    name: office.name,
                    allotment: 0,
                    obligations: 0,
                    accomplishment: Math.min(d.absorptive, 100)
                };
            }
            return {
                name: office.name,
                allotment: 0,
                obligations: 0,
                accomplishment: 0
            };
        });

        officeData.sort((a, b) => b.accomplishment - a.accomplishment);

        const numBars = officeData.length;
        const barHeight = Math.max(12, Math.min(18, 300 / numBars - 4));
        const gap = 3;
        const labelWidth = 120;
        const chartWidth = 400;
        const valueWidth = 60;
        const padding = 20;

        const canvasWidth = labelWidth + chartWidth + valueWidth + padding * 2;
        const canvasHeight = numBars * (barHeight + gap) + padding * 2 + 30;

        canvas.width = canvasWidth;
        canvas.height = canvasHeight;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#333';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('Annual Financial Accomplishment by Office (%)', padding, padding + 10);

        const startY = padding + 35;
        const maxValue = 100;

        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(labelWidth + padding, startY - 5);
        ctx.lineTo(labelWidth + padding + chartWidth, startY - 5);
        ctx.stroke();

        ctx.fillStyle = '#666';
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        [0, 25, 50, 75, 100].forEach(val => {
            const x = labelWidth + padding + (val / maxValue) * chartWidth;
            ctx.fillText(val + '%', x, startY - 10);
        });

        officeData.forEach((data, index) => {
            const y = startY + index * (barHeight + gap);

            ctx.fillStyle = '#333';
            ctx.font = '10px Arial';
            ctx.textAlign = 'left';
            const displayName = data.name.length > 18 ? data.name.substring(0, 16) + '...' : data.name;
            ctx.fillText(displayName, padding, y + barHeight - 2);

            ctx.fillStyle = '#f0f0f0';
            ctx.fillRect(labelWidth + padding, y, chartWidth, barHeight);

            const barLength = (data.accomplishment / maxValue) * chartWidth;

            if (data.accomplishment >= 80) {
                ctx.fillStyle = '#28a745';
            } else if (data.accomplishment >= 50) {
                ctx.fillStyle = '#ffc107';
            } else if (data.accomplishment > 0) {
                ctx.fillStyle = '#dc3545';
            } else {
                ctx.fillStyle = '#e9ecef';
            }

            ctx.fillRect(labelWidth + padding, y, barLength, barHeight);

            ctx.fillStyle = '#333';
            ctx.font = 'bold 10px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(data.accomplishment.toFixed(1) + '%', labelWidth + padding + chartWidth + 5, y + barHeight - 2);
        });
    })
    .catch(error => console.error('Error loading chart data:', error));
}

// ============================================
// Office Staff Dashboard (Limited View)
// ============================================

function loadOfficeDashboard() {
    const office = officeMap.get(currentUser.office);
    if (!office) return;

    document.getElementById('office-welcome').textContent = `Welcome, ${office.name}!`;

    const year = currentYear;
    // Fetch submission status for this office
    const quarterlyPromises = ['Q1', 'Q2', 'Q3', 'Q4'].map(q =>
        fetch(`/api/reports/${office.id}?quarter=${q}&type=quarterly&year=${year}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    );
    const physicalPromise = fetch(`/api/reports/${office.id}?quarter=&type=physical&year=${year}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
    const annualPromise = fetch(`/api/reports/${office.id}?quarter=&type=annual_financial&year=${year}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

    Promise.all([...quarterlyPromises, physicalPromise, annualPromise])
    .then(([q1, q2, q3, q4, physical, annual]) => {
        const quarterlySubmissions = [q1, q2, q3, q4].filter(s => s !== null);
        const quarterlySubmitted = quarterlySubmissions.length;
        const physicalSubmitted = physical !== null;
        const annualSubmitted = annual !== null;

        const container = document.getElementById('office-dashboard-container');
        container.innerHTML = `
            <div class="kpi-grid">
                <div class="kpi-card navy">
                    <div class="kpi-label">Office Name</div>
                    <div class="kpi-value" style="font-size: 18px;">${office.name}</div>
                    <div class="kpi-sub">Your Office</div>
                </div>
                <div class="kpi-card sky">
                    <div class="kpi-label">Programs</div>
                    <div class="kpi-value">${office.programs?.length || 0}</div>
                    <div class="kpi-sub">Registered programs</div>
                </div>
                <div class="kpi-card mint">
                    <div class="kpi-label">Quarterly Submitted</div>
                    <div class="kpi-value">${quarterlySubmitted}/4</div>
                    <div class="kpi-sub">Quarterly reports</div>
                </div>
                <div class="kpi-card gold">
                    <div class="kpi-label">Annual Submitted</div>
                    <div class="kpi-value">${annualSubmitted ? 'Yes' : 'No'}</div>
                    <div class="kpi-sub">Annual report</div>
                </div>
            </div>

            <div class="charts-row">
                <div class="chart-card">
                    <h3>Quarterly Submission Status</h3>
                    <div class="chart-wrap">
                        <canvas id="officeQuarterChart"></canvas>
                    </div>
                </div>
                <div class="chart-card">
                    <h3>Other Reports Status</h3>
                    <div class="chart-wrap">
                        <canvas id="officeReportsChart"></canvas>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('office-dashboard-container').style.display = 'block';
        document.getElementById('report-container').style.display = 'none';

        drawOfficeQuarterChart(quarterlySubmitted);
        drawOfficeReportsChart(physicalSubmitted, annualSubmitted);
    })
    .catch(error => {
        console.error('Error loading office dashboard:', error);
    });
}

function drawOfficeQuarterChart(submitted) {
    const canvas = document.getElementById('officeQuarterChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = 300;
    canvas.height = 200;

    const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
    const data = quarters.map((_, i) => i < submitted ? 100 : 0);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = 70;
    const barWidth = 50;
    const startX = 30;
    const chartHeight = 140;
    const startY = 170;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw bars
    data.forEach((value, index) => {
        const x = startX + index * (barWidth + 20);
        const barHeight = (value / 100) * chartHeight;
        const y = startY - barHeight;

        ctx.fillStyle = value > 0 ? '#28a745' : '#dc3545';
        ctx.fillRect(x, y, barWidth, barHeight);

        ctx.fillStyle = '#333';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(quarters[index], x + barWidth / 2, startY + 18);

        ctx.fillStyle = value > 0 ? '#28a745' : '#dc3545';
        ctx.font = 'bold 11px Arial';
        ctx.fillText(value > 0 ? '✓' : '—', x + barWidth / 2, y - 8);
    });
}

function drawOfficeReportsChart(physical, annual) {
    const canvas = document.getElementById('officeReportsChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = 300;
    canvas.height = 200;

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = 60;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw pie segments
    let startAngle = -Math.PI / 2;

    // Physical Performance
    if (physical || annual) {
        const physicalAngle = (physical ? 0.5 : 0) * 2 * Math.PI;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, startAngle, startAngle + physicalAngle);
        ctx.fillStyle = physical ? '#28a745' : '#eee';
        ctx.fill();
        startAngle += physicalAngle;

        const annualAngle = (annual ? 0.5 : 0) * 2 * Math.PI;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, startAngle, startAngle + annualAngle);
        ctx.fillStyle = annual ? '#28a745' : '#eee';
        ctx.fill();
        startAngle += annualAngle;
    }

    // Draw legend
    ctx.font = '12px Arial';
    ctx.fillStyle = '#333';
    ctx.fillText('Physical: ' + (physical ? '✓ Done' : '— Pending'), 20, 180);
    ctx.fillText('Annual: ' + (annual ? '✓ Done' : '— Pending'), 160, 180);
}

function restoreSession() {
    if (!localStorage.getItem('opencode_logged_in')) return Promise.resolve();
    const logoutTs = localStorage.getItem('opencode_logout_ts');
    if (logoutTs && Date.now() - parseInt(logoutTs) < 10000) {
        localStorage.removeItem('opencode_logout_ts');
        return Promise.resolve();
    }
    return fetch('/api/me')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!data || !data.success || !data.user) return;
            const user = data.user;
            if (user.role === 'manager') {
                currentUser = { username: user.office_id, role: 'admin' };
                document.getElementById('login-wrapper').style.display = 'none';
                document.getElementById('employee-view').style.display = 'none';
                document.getElementById('manager-dashboard').style.display = 'block';
                document.getElementById('global-year-bar').style.display = 'flex';
                document.body.classList.add('show-dashboard');
                populateYearSelector();
                const dashNav = document.querySelector('#manager-dashboard .nav-item[data-page="dashboard"]');
                switchDashboardPage('dashboard', dashNav);
            } else if (user.role === 'employee') {
                currentUser = { office: user.office_id, role: 'office' };
                document.getElementById('login-wrapper').style.display = 'none';
                document.getElementById('employee-view').style.display = 'flex';
                document.getElementById('manager-dashboard').style.display = 'none';
                document.getElementById('global-year-bar').style.display = 'flex';
                document.body.classList.remove('show-dashboard');
                syncOfficePrograms(user.office_id).then(() => {
                    populateYearSelector();
                    const dashNav = document.querySelector('#employee-view .nav-item[data-report="office-dashboard"]');
                    switchReport('office-dashboard', dashNav);
                    loadEmployeeDeadline();
                });
            }
        })
        .catch(() => showToast('Failed to restore session.', 'error'));
}

refreshOfficeList().then(() => { populateOfficeSelect(); restoreSession(); }).catch(() => { populateOfficeSelect(); restoreSession(); });
