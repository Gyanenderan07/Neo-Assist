/**
 * NEOASSIST AI — Autonomous Voice & Text Database Engine
 * Dynamic Schema Synchronization, Web Speech API & Real-time Grid
 */

(() => {
    'use strict';

    // State
    const state = {
        isListening: false,
        recognition: null,
        currentResultData: { columns: [], rows: [] },
        sortState: { column: null, direction: 'asc' },
        currentSchema: { tables: [], total_tables: 0 }
    };

    // Elements
    const elements = {
        // Navigation & Status
        navTableCount: document.getElementById('navTableCount'),
        navTableCountText: document.getElementById('navTableCountText'),
        apiKeyModalBtn: document.getElementById('apiKeyModalBtn'),
        resetDbBtn: document.getElementById('resetDbBtn'),

        // Sidebar
        schemaTreeContainer: document.getElementById('schemaTreeContainer'),
        emptySchemaPlaceholder: document.getElementById('emptySchemaPlaceholder'),
        sidebarTableCount: document.getElementById('sidebarTableCount'),
        refreshSchemaBtn: document.getElementById('refreshSchemaBtn'),
        schemaSearchInput: document.getElementById('schemaSearchInput'),

        // Console
        promptInput: document.getElementById('promptInput'),
        micBtn: document.getElementById('micBtn'),
        micIcon: document.getElementById('micIcon'),
        executeBtn: document.getElementById('executeBtn'),
        executeIcon: document.getElementById('executeIcon'),
        executeBtnText: document.getElementById('executeBtnText'),
        directSqlToggle: document.getElementById('directSqlToggle'),
        voiceActiveBar: document.getElementById('voiceActiveBar'),
        voiceTranscriptText: document.getElementById('voiceTranscriptText'),
        voiceCancelBtn: document.getElementById('voiceCancelBtn'),

        // Terminal
        sqlCodeBlock: document.getElementById('sqlCodeBlock'),
        queryTypeBadge: document.getElementById('queryTypeBadge'),
        latencyBadge: document.getElementById('latencyBadge'),
        rowsBadge: document.getElementById('rowsBadge'),
        copySqlBtn: document.getElementById('copySqlBtn'),
        copyBtnText: document.getElementById('copyBtnText'),
        explanationText: document.getElementById('explanationText'),

        // Data Grid
        dataTable: document.getElementById('dataTable'),
        tableHead: document.getElementById('tableHead'),
        tableBody: document.getElementById('tableBody'),
        emptyTableState: document.getElementById('emptyTableState'),
        recordCounterTag: document.getElementById('recordCounterTag'),
        tableFilterInput: document.getElementById('tableFilterInput'),
        exportCsvBtn: document.getElementById('exportCsvBtn'),
        exportJsonBtn: document.getElementById('exportJsonBtn'),

        // Modals
        apiKeyModal: document.getElementById('apiKeyModal'),
        closeApiKeyModalBtn: document.getElementById('closeApiKeyModalBtn'),
        cancelApiKeyBtn: document.getElementById('cancelApiKeyBtn'),
        saveApiKeyBtn: document.getElementById('saveApiKeyBtn'),
        geminiKeyInput: document.getElementById('geminiKeyInput'),
        toggleKeyVisBtn: document.getElementById('toggleKeyVisBtn'),
        keyVisIcon: document.getElementById('keyVisIcon'),
        keyStatusFeedback: document.getElementById('keyStatusFeedback'),

        resetModal: document.getElementById('resetModal'),
        closeResetModalBtn: document.getElementById('closeResetModalBtn'),
        cancelResetBtn: document.getElementById('cancelResetBtn'),
        confirmResetBtn: document.getElementById('confirmResetBtn'),

        toastContainer: document.getElementById('toastContainer')
    };

    // -------------------------------------------------------------------------
    // TOAST NOTIFICATIONS
    // -------------------------------------------------------------------------
    function showToast(message, type = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `toast-msg ${type}`;
        const icons = {
            success: 'fa-circle-check',
            error: 'fa-circle-exclamation',
            info: 'fa-circle-info'
        };
        toast.innerHTML = `<i class="fa-solid ${icons[type] || 'fa-bell'}"></i> <span>${message}</span>`;
        elements.toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 250);
        }, duration);
    }

    // -------------------------------------------------------------------------
    // WEB SPEECH API (VOICE PIPELINE)
    // -------------------------------------------------------------------------
    function initSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            elements.micBtn.title = 'Speech Recognition requires Chrome or Edge (Web Speech API).';
            elements.micBtn.style.opacity = '0.6';
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            state.isListening = true;
            elements.micBtn.classList.add('recording');
            elements.voiceActiveBar.classList.add('active');
            elements.voiceTranscriptText.textContent = 'Listening... Speak your database command naturally';
        };

        recognition.onresult = (event) => {
            let interim = '';
            let final = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const text = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    final += text;
                } else {
                    interim += text;
                }
            }
            const current = final || interim;
            if (current) {
                elements.voiceTranscriptText.textContent = `"${current}"`;
                elements.promptInput.value = current;
                autoResizeTextarea(elements.promptInput);
            }
        };

        recognition.onerror = (event) => {
            console.warn('Speech error:', event.error);
            stopListening();
            if (event.error !== 'no-speech') {
                showToast(`Voice input notice: ${event.error}`, 'info');
            }
        };

        recognition.onend = () => {
            stopListening();
            if (elements.promptInput.value.trim().length > 3) {
                elements.executeBtn.focus();
            }
        };

        state.recognition = recognition;
    }

    function toggleListening() {
        if (!state.recognition) {
            showToast('Voice input requires Web Speech API (Chrome/Edge).', 'info');
            return;
        }

        if (state.isListening) {
            state.recognition.stop();
            stopListening();
        } else {
            try {
                state.recognition.start();
            } catch (err) {
                state.recognition.stop();
            }
        }
    }

    function stopListening() {
        state.isListening = false;
        elements.micBtn.classList.remove('recording');
        elements.voiceActiveBar.classList.remove('active');
    }

    // -------------------------------------------------------------------------
    // SCHEMA TREE RENDERING
    // -------------------------------------------------------------------------
    async function fetchSchema() {
        try {
            elements.refreshSchemaBtn.querySelector('i').classList.add('fa-spin');
            const res = await fetch('/api/schema');
            const data = await res.json();
            if (data.success && data.schema) {
                state.currentSchema = data.schema;
                renderSchemaTree(data.schema);
                updateStats(data.schema);
            }
        } catch (err) {
            console.error('Schema fetch error:', err);
        } finally {
            setTimeout(() => {
                elements.refreshSchemaBtn.querySelector('i').classList.remove('fa-spin');
            }, 250);
        }
    }

    function updateStats(schema) {
        const count = schema.total_tables || 0;
        elements.sidebarTableCount.textContent = count;
        elements.navTableCountText.textContent = `${count} ${count === 1 ? 'Table' : 'Tables'} Active`;
    }

    function renderSchemaTree(schema) {
        elements.schemaTreeContainer.innerHTML = '';

        if (!schema.tables || schema.tables.length === 0) {
            elements.schemaTreeContainer.innerHTML = `
                <div class="empty-schema-msg">
                    <div class="empty-icon"><i class="fa-solid fa-layer-group"></i></div>
                    <h5>Zero-Config Empty State</h5>
                    <p>Database has 0 tables. Speak or type a command to autonomously generate tables and insert records.</p>
                </div>
            `;
            return;
        }

        const filter = (elements.schemaSearchInput.value || '').toLowerCase().trim();

        schema.tables.forEach(table => {
            const matchesTable = table.name.toLowerCase().includes(filter);
            const matchesCol = table.columns.some(c => c.name.toLowerCase().includes(filter) || c.type.toLowerCase().includes(filter));

            if (filter && !matchesTable && !matchesCol) return;

            const card = document.createElement('div');
            card.className = 'schema-table-card';

            card.innerHTML = `
                <div class="schema-table-header" data-table="${escapeHtml(table.name)}">
                    <div class="table-label-wrap">
                        <i class="fa-solid fa-table accent-icon"></i>
                        <span class="table-name-txt">${escapeHtml(table.name)}</span>
                        <span class="table-rows-badge">${table.row_count} rows</span>
                    </div>
                    <div class="table-actions-wrap">
                        <button class="table-action-pill query-btn" title="SELECT * FROM ${table.name}">
                            <i class="fa-solid fa-play"></i>
                        </button>
                        <button class="table-action-pill count-btn" title="COUNT(*) FROM ${table.name}">
                            <i class="fa-solid fa-calculator"></i>
                        </button>
                        <button class="table-action-pill drop-btn" title="DROP TABLE ${table.name}">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="table-columns-tray">
                    ${table.columns.map(col => `
                        <div class="tray-col-row">
                            <span>${col.pk ? '<span class="col-pk">PK</span>' : ''} ${escapeHtml(col.name)}</span>
                            <span class="col-type">${escapeHtml(col.type)}</span>
                        </div>
                    `).join('')}
                </div>
            `;

            // Quick Actions
            card.querySelector('.query-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                runDirectQuery(`SELECT * FROM "${table.name}" LIMIT 50;`);
            });

            card.querySelector('.count-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                runDirectQuery(`SELECT COUNT(*) as total_records FROM "${table.name}";`);
            });

            card.querySelector('.drop-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Drop table "${table.name}"?`)) {
                    runDirectQuery(`DROP TABLE IF EXISTS "${table.name}";`);
                }
            });

            card.querySelector('.schema-table-header').addEventListener('click', () => {
                runDirectQuery(`SELECT * FROM "${table.name}" LIMIT 50;`);
            });

            elements.schemaTreeContainer.appendChild(card);
        });
    }

    // -------------------------------------------------------------------------
    // EXECUTION DISPATCHER
    // -------------------------------------------------------------------------
    async function executeQuery() {
        const prompt = elements.promptInput.value.trim();
        if (!prompt) {
            showToast('Enter or speak a command first.', 'info');
            elements.promptInput.focus();
            return;
        }

        const isDirect = elements.directSqlToggle.checked;
        const storedKey = localStorage.getItem('neoassist_gemini_key') || '';

        setLoading(true);

        try {
            const res = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: prompt,
                    api_key: storedKey,
                    direct_sql: isDirect
                })
            });

            const data = await res.json();

            if (!res.ok || !data.success) {
                const errMsg = data.error || data.execution?.error || 'Execution failed';
                showToast(`Error: ${errMsg}`, 'error');
                elements.sqlCodeBlock.innerHTML = `<span style="color:#fb7185;">-- EXECUTION ERROR:\n${escapeHtml(errMsg)}\n\n-- SQL:\n${escapeHtml(data.ai_result?.sql || prompt)}</span>`;
                elements.queryTypeBadge.textContent = 'ERROR';
                elements.latencyBadge.innerHTML = `<i class="fa-solid fa-clock"></i> ${data.execution?.execution_time_ms || 0} ms`;
                return;
            }

            showToast('Query executed successfully!', 'success');

            // 1. Update SQL Terminal
            const rawSql = data.execution.executed_sql || data.ai_result?.sql || prompt;
            renderSyntaxHighlightedSql(rawSql);

            // 2. Terminal Meta Badges
            elements.queryTypeBadge.textContent = data.ai_result?.query_type || (isDirect ? 'SQL' : 'AI DQL');
            elements.latencyBadge.innerHTML = `<i class="fa-solid fa-clock"></i> ${data.execution.execution_time_ms} ms`;
            
            const rowCount = data.execution.row_count || 0;
            const affected = data.execution.rows_affected || 0;
            elements.rowsBadge.innerHTML = `<i class="fa-solid fa-table-list"></i> ${rowCount ? `${rowCount} rows` : `${affected} affected`}`;

            // 3. Explanation Footer
            elements.explanationText.textContent = data.ai_result?.explanation || 'Query executed cleanly on database.';

            // 4. Data Grid
            state.currentResultData = {
                columns: data.execution.columns || [],
                rows: data.execution.rows || []
            };
            renderDataTable(state.currentResultData);

            // 5. Update Schema
            if (data.schema) {
                state.currentSchema = data.schema;
                renderSchemaTree(data.schema);
                updateStats(data.schema);
            } else {
                fetchSchema();
            }

        } catch (err) {
            console.error('Execution error:', err);
            showToast(`System exception: ${err.message}`, 'error');
        } finally {
            setLoading(false);
        }
    }

    function runDirectQuery(sql) {
        elements.promptInput.value = sql;
        elements.directSqlToggle.checked = true;
        autoResizeTextarea(elements.promptInput);
        executeQuery();
    }

    function setLoading(isLoading) {
        elements.executeBtn.disabled = isLoading;
        if (isLoading) {
            elements.executeIcon.className = 'fa-solid fa-circle-notch fa-spin';
            elements.executeBtnText.textContent = 'Running...';
            elements.sqlCodeBlock.innerHTML = '<span style="color:#94a3b8;">-- Processing natural language & executing pipeline...\n-- Please wait...</span>';
            elements.queryTypeBadge.textContent = 'RUNNING';
        } else {
            elements.executeIcon.className = 'fa-solid fa-bolt';
            elements.executeBtnText.textContent = 'Execute';
        }
    }

    // -------------------------------------------------------------------------
    // SQL SYNTAX HIGHLIGHTER
    // -------------------------------------------------------------------------
    function renderSyntaxHighlightedSql(rawSql) {
        const keywords = [
            'SELECT', 'FROM', 'WHERE', 'CREATE', 'TABLE', 'IF', 'NOT', 'EXISTS',
            'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'DROP', 'ALTER',
            'JOIN', 'LEFT', 'RIGHT', 'INNER', 'ON', 'GROUP', 'BY', 'ORDER', 'ASC',
            'DESC', 'LIMIT', 'OFFSET', 'PRIMARY', 'KEY', 'AUTOINCREMENT', 'AND',
            'OR', 'IN', 'LIKE', 'AS', 'PRAGMA', 'WITH', 'DEFAULT', 'GENERATED',
            'ALWAYS', 'STORED', 'TEXT', 'INTEGER', 'REAL', 'TIMESTAMP', 'DATE', 'BOOLEAN'
        ];
        const funcs = ['COUNT', 'AVG', 'SUM', 'MAX', 'MIN', 'ROUND', 'DATE', 'DATETIME'];

        let highlighted = escapeHtml(rawSql);
        highlighted = highlighted.replace(/'([^']*)'/g, '<span class="sql-str">\'$1\'</span>');
        highlighted = highlighted.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="sql-num">$1</span>');

        funcs.forEach(fn => {
            const regex = new RegExp(`\\b(${fn})\\b(?=\\s*\\()`, 'gi');
            highlighted = highlighted.replace(regex, '<span class="sql-fn">$1</span>');
        });

        keywords.forEach(kw => {
            const regex = new RegExp(`\\b(${kw})\\b`, 'gi');
            highlighted = highlighted.replace(regex, '<span class="sql-keyword">$1</span>');
        });

        elements.sqlCodeBlock.innerHTML = highlighted;
    }

    // -------------------------------------------------------------------------
    // DYNAMIC DATA GRID
    // -------------------------------------------------------------------------
    function renderDataTable(data) {
        const { columns, rows } = data;
        if (!columns || columns.length === 0 || !rows || rows.length === 0) {
            elements.dataTable.style.display = 'none';
            elements.emptyTableState.style.display = 'flex';
            elements.recordCounterTag.textContent = '0 records';
            return;
        }

        elements.emptyTableState.style.display = 'none';
        elements.dataTable.style.display = 'table';
        elements.recordCounterTag.textContent = `${rows.length} ${rows.length === 1 ? 'record' : 'records'}`;

        // Build Header
        elements.tableHead.innerHTML = `
            <tr>
                ${columns.map((col, idx) => `
                    <th data-col="${escapeHtml(col)}" data-index="${idx}">
                        <div class="th-cell">
                            <span>${escapeHtml(col)}</span>
                            <i class="fa-solid fa-sort sort-indicator" id="sort-icon-${idx}"></i>
                        </div>
                    </th>
                `).join('')}
            </tr>
        `;

        elements.tableHead.querySelectorAll('th').forEach(th => {
            th.addEventListener('click', () => {
                const colName = th.getAttribute('data-col');
                const colIdx = parseInt(th.getAttribute('data-index'), 10);
                sortTable(colName, colIdx);
            });
        });

        renderRows(rows, columns);
    }

    function renderRows(rows, columns) {
        elements.tableBody.innerHTML = '';
        const filterVal = (elements.tableFilterInput.value || '').toLowerCase().trim();

        rows.forEach(row => {
            if (filterVal) {
                const rowStr = Object.values(row).join(' ').toLowerCase();
                if (!rowStr.includes(filterVal)) return;
            }

            const tr = document.createElement('tr');
            columns.forEach(col => {
                const val = row[col];
                const td = document.createElement('td');
                if (typeof val === 'number') {
                    td.className = 'td-num';
                    td.textContent = Number.isInteger(val) ? val.toLocaleString() : val.toFixed(2);
                } else if (val === null || val === undefined) {
                    td.innerHTML = '<span style="color:#64748b;font-style:italic;">NULL</span>';
                } else {
                    td.textContent = String(val);
                }
                tr.appendChild(td);
            });
            elements.tableBody.appendChild(tr);
        });
    }

    function sortTable(columnName, colIdx) {
        if (!state.currentResultData.rows || state.currentResultData.rows.length === 0) return;

        let direction = 'asc';
        if (state.sortState.column === columnName && state.sortState.direction === 'asc') {
            direction = 'desc';
        }
        state.sortState = { column: columnName, direction: direction };

        elements.tableHead.querySelectorAll('.sort-indicator').forEach(icon => {
            icon.className = 'fa-solid fa-sort sort-indicator';
        });
        const activeIcon = document.getElementById(`sort-icon-${colIdx}`);
        if (activeIcon) {
            activeIcon.className = `fa-solid fa-sort-${direction === 'asc' ? 'up' : 'down'} sort-indicator accent-icon`;
        }

        state.currentResultData.rows.sort((a, b) => {
            const vA = a[columnName];
            const vB = b[columnName];
            if (vA === vB) return 0;
            if (vA === null || vA === undefined) return 1;
            if (vB === null || vB === undefined) return -1;
            if (typeof vA === 'number' && typeof vB === 'number') {
                return direction === 'asc' ? vA - vB : vB - vA;
            }
            return direction === 'asc'
                ? String(vA).localeCompare(String(vB))
                : String(vB).localeCompare(String(vA));
        });

        renderRows(state.currentResultData.rows, state.currentResultData.columns);
    }

    // -------------------------------------------------------------------------
    // EXPORT FUNCTIONS (CSV / JSON)
    // -------------------------------------------------------------------------
    function exportCsv() {
        const { columns, rows } = state.currentResultData;
        if (!rows || rows.length === 0) {
            showToast('No records to export.', 'info');
            return;
        }

        const header = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(',');
        const body = rows.map(r => {
            return columns.map(c => {
                const val = r[c] !== null && r[c] !== undefined ? String(r[c]) : '';
                return `"${val.replace(/"/g, '""')}"`;
            }).join(',');
        }).join('\n');

        downloadBlob(`${header}\n${body}`, 'neoassist_export.csv', 'text/csv');
        showToast('Exported dataset to CSV!', 'success');
    }

    function exportJson() {
        const { rows } = state.currentResultData;
        if (!rows || rows.length === 0) {
            showToast('No records to export.', 'info');
            return;
        }

        const jsonStr = JSON.stringify(rows, null, 2);
        downloadBlob(jsonStr, 'neoassist_export.json', 'application/json');
        showToast('Exported dataset to JSON!', 'success');
    }

    function downloadBlob(content, filename, type) {
        const blob = new Blob([content], { type: type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // -------------------------------------------------------------------------
    // COPY SQL
    // -------------------------------------------------------------------------
    function copySql() {
        const text = elements.sqlCodeBlock.innerText;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            elements.copyBtnText.textContent = 'Copied!';
            showToast('SQL copied to clipboard!', 'success');
            setTimeout(() => {
                elements.copyBtnText.textContent = 'Copy SQL';
            }, 1800);
        }).catch(() => {
            showToast('Failed to copy to clipboard.', 'error');
        });
    }

    // -------------------------------------------------------------------------
    // DATABASE RESET
    // -------------------------------------------------------------------------
    async function resetDatabase() {
        try {
            elements.confirmResetBtn.disabled = true;
            elements.confirmResetBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Resetting...';

            const res = await fetch('/api/reset', { method: 'POST' });
            const data = await res.json();

            if (data.success) {
                showToast(data.message, 'success');
                elements.resetModal.classList.remove('show');
                state.currentResultData = { columns: [], rows: [] };
                renderDataTable(state.currentResultData);
                elements.sqlCodeBlock.innerHTML = '-- Database reset to 0 tables (Empty state).\n-- Ready for autonomous schema synthesis.';
                elements.queryTypeBadge.textContent = 'RESET';
                elements.latencyBadge.innerHTML = '<i class="fa-solid fa-clock"></i> 0.0 ms';
                elements.rowsBadge.innerHTML = '<i class="fa-solid fa-table-list"></i> 0 rows';
                elements.explanationText.textContent = 'Database cleanly wiped to zero-config state. Enter your first prompt to generate tables dynamically.';
                fetchSchema();
            } else {
                showToast(`Reset error: ${data.error}`, 'error');
            }
        } catch (e) {
            showToast(`Reset failed: ${e.message}`, 'error');
        } finally {
            elements.confirmResetBtn.disabled = false;
            elements.confirmResetBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Confirm Reset';
        }
    }

    // -------------------------------------------------------------------------
    // GEMINI KEY MODAL
    // -------------------------------------------------------------------------
    function setupApiKeyModal() {
        const savedKey = localStorage.getItem('neoassist_gemini_key') || '';
        if (savedKey) elements.geminiKeyInput.value = savedKey;

        elements.apiKeyModalBtn.addEventListener('click', () => {
            elements.apiKeyModal.classList.add('show');
            elements.keyStatusFeedback.style.display = 'none';
        });

        elements.closeApiKeyModalBtn.addEventListener('click', () => {
            elements.apiKeyModal.classList.remove('show');
        });

        elements.cancelApiKeyBtn.addEventListener('click', () => {
            elements.apiKeyModal.classList.remove('show');
        });

        elements.toggleKeyVisBtn.addEventListener('click', () => {
            const isPass = elements.geminiKeyInput.type === 'password';
            elements.geminiKeyInput.type = isPass ? 'text' : 'password';
            elements.keyVisIcon.className = isPass ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
        });

        elements.saveApiKeyBtn.addEventListener('click', async () => {
            const key = elements.geminiKeyInput.value.trim();
            if (!key) {
                elements.keyStatusFeedback.className = 'modal-feedback error';
                elements.keyStatusFeedback.textContent = 'Please enter an API key.';
                return;
            }

            elements.saveApiKeyBtn.disabled = true;
            elements.saveApiKeyBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Verifying...';

            try {
                const res = await fetch('/api/save-key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ api_key: key })
                });
                const data = await res.json();
                if (data.success) {
                    localStorage.setItem('neoassist_gemini_key', key);
                    elements.keyStatusFeedback.className = 'modal-feedback success';
                    elements.keyStatusFeedback.textContent = data.message;
                    showToast('Gemini API Key configured successfully!', 'success');
                    setTimeout(() => elements.apiKeyModal.classList.remove('show'), 1000);
                } else {
                    elements.keyStatusFeedback.className = 'modal-feedback error';
                    elements.keyStatusFeedback.textContent = data.error || 'Verification failed.';
                }
            } catch (err) {
                elements.keyStatusFeedback.className = 'modal-feedback error';
                elements.keyStatusFeedback.textContent = `Network error: ${err.message}`;
            } finally {
                elements.saveApiKeyBtn.disabled = false;
                elements.saveApiKeyBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save & Verify Key';
            }
        });
    }

    // -------------------------------------------------------------------------
    // UTILS & LISTENERS
    // -------------------------------------------------------------------------
    function autoResizeTextarea(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function bindEvents() {
        elements.executeBtn.addEventListener('click', executeQuery);
        elements.promptInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                executeQuery();
            } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                executeQuery();
            }
        });
        elements.promptInput.addEventListener('input', () => autoResizeTextarea(elements.promptInput));

        elements.micBtn.addEventListener('click', toggleListening);
        elements.voiceCancelBtn.addEventListener('click', stopListening);
        elements.copySqlBtn.addEventListener('click', copySql);
        elements.exportCsvBtn.addEventListener('click', exportCsv);
        elements.exportJsonBtn.addEventListener('click', exportJson);

        elements.tableFilterInput.addEventListener('input', () => {
            renderRows(state.currentResultData.rows, state.currentResultData.columns);
        });

        elements.schemaSearchInput.addEventListener('input', () => {
            renderSchemaTree(state.currentSchema);
        });

        elements.refreshSchemaBtn.addEventListener('click', fetchSchema);

        // Reset Modal
        elements.resetDbBtn.addEventListener('click', () => elements.resetModal.classList.add('show'));
        elements.closeResetModalBtn.addEventListener('click', () => elements.resetModal.classList.remove('show'));
        elements.cancelResetBtn.addEventListener('click', () => elements.resetModal.classList.remove('show'));
        elements.confirmResetBtn.addEventListener('click', resetDatabase);

        // Direct SQL toggle placeholder update
        elements.directSqlToggle.addEventListener('change', (e) => {
            elements.promptInput.placeholder = e.target.checked
                ? 'Enter raw SQLite statement (e.g. SELECT * FROM employees; or CREATE TABLE ...)'
                : "Speak or type your database instruction... (e.g. 'Add an employee Sarah in Finance with salary 95000')";
        });

        // Esc key closes modals
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                elements.apiKeyModal.classList.remove('show');
                elements.resetModal.classList.remove('show');
                if (state.isListening) stopListening();
            }
        });
    }

    function init() {
        initSpeechRecognition();
        setupApiKeyModal();
        bindEvents();
        fetchSchema();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
