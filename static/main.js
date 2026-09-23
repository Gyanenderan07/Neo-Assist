/**
 * NEOASSIST AI — Autonomous Voice & Text Conversational Database Engine
 * Award-Winning UI/UX, Dynamic Schema Introspection, Web Speech API & Interactive Grid
 */

(() => {
    'use strict';

    // -------------------------------------------------------------------------
    // STATE MANAGEMENT
    // -------------------------------------------------------------------------
    const state = {
        isListening: false,
        recognition: null,
        soundEnabled: true,
        currentResultData: { columns: [], rows: [] },
        sortState: { column: null, direction: 'asc' },
        currentSchema: { tables: [], total_tables: 0 },
        audioCtx: null
    };

    // -------------------------------------------------------------------------
    // DOM ELEMENTS
    // -------------------------------------------------------------------------
    const elements = {
        // Nav & Status
        dbTableCountBadge: document.getElementById('dbTableCountBadge'),
        aiModelBadge: document.getElementById('aiModelBadge'),
        aiModelText: document.getElementById('aiModelText'),
        audioToggleBtn: document.getElementById('audioToggleBtn'),
        audioToggleIcon: document.getElementById('audioToggleIcon'),
        resetDbBtn: document.getElementById('resetDbBtn'),
        apiKeyModalBtn: document.getElementById('apiKeyModalBtn'),

        // Sidebar
        schemaTreeContainer: document.getElementById('schemaTreeContainer'),
        schemaEmptyState: document.getElementById('schemaEmptyState'),
        tableCountBadge: document.getElementById('tableCountBadge'),
        refreshSchemaBtn: document.getElementById('refreshSchemaBtn'),
        schemaSearchInput: document.getElementById('schemaSearchInput'),

        // Command Console
        promptInput: document.getElementById('promptInput'),
        micBtn: document.getElementById('micBtn'),
        micIcon: document.getElementById('micIcon'),
        executeBtn: document.getElementById('executeBtn'),
        executeIcon: document.getElementById('executeIcon'),
        executeBtnText: document.getElementById('executeBtnText'),
        directSqlToggle: document.getElementById('directSqlToggle'),
        voiceListeningBanner: document.getElementById('voiceListeningBanner'),
        voiceTranscriptPreview: document.getElementById('voiceTranscriptPreview'),
        voiceCancelBtn: document.getElementById('voiceCancelBtn'),
        presetChipsContainer: document.getElementById('presetChipsContainer'),

        // Terminal Panel
        sqlCodeBlock: document.getElementById('sqlCodeBlock'),
        queryTypeBadge: document.getElementById('queryTypeBadge'),
        queryLatencyBadge: document.getElementById('queryLatencyBadge'),
        queryRowBadge: document.getElementById('queryRowBadge'),
        copySqlBtn: document.getElementById('copySqlBtn'),
        copyBtnText: document.getElementById('copyBtnText'),
        insightsContent: document.getElementById('insightsContent'),
        insightsSourceTag: document.getElementById('insightsSourceTag'),

        // Data Workspace
        tableContainer: document.getElementById('tableContainer'),
        tableEmptyState: document.getElementById('tableEmptyState'),
        neoDataTable: document.getElementById('neoDataTable'),
        neoTableHead: document.getElementById('neoTableHead'),
        neoTableBody: document.getElementById('neoTableBody'),
        dataCountTag: document.getElementById('dataCountTag'),
        tableFilterInput: document.getElementById('tableFilterInput'),
        exportCsvBtn: document.getElementById('exportCsvBtn'),
        exportJsonBtn: document.getElementById('exportJsonBtn'),

        // Modals
        apiKeyModal: document.getElementById('apiKeyModal'),
        closeApiKeyModalBtn: document.getElementById('closeApiKeyModalBtn'),
        cancelApiKeyBtn: document.getElementById('cancelApiKeyBtn'),
        saveApiKeyBtn: document.getElementById('saveApiKeyBtn'),
        geminiKeyInput: document.getElementById('geminiKeyInput'),
        toggleKeyVisibility: document.getElementById('toggleKeyVisibility'),
        keyVisIcon: document.getElementById('keyVisIcon'),
        keyModalStatus: document.getElementById('keyModalStatus'),

        resetModal: document.getElementById('resetModal'),
        closeResetModalBtn: document.getElementById('closeResetModalBtn'),
        cancelResetBtn: document.getElementById('cancelResetBtn'),
        confirmResetBtn: document.getElementById('confirmResetBtn'),

        toastContainer: document.getElementById('toastContainer')
    };

    // -------------------------------------------------------------------------
    // WEB AUDIO API SOUND SYSTEM
    // -------------------------------------------------------------------------
    function playAudioTone(type) {
        if (!state.soundEnabled) return;
        try {
            if (!state.audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                state.audioCtx = new AudioContext();
            }
            if (state.audioCtx.state === 'suspended') {
                state.audioCtx.resume();
            }

            const ctx = state.audioCtx;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            const now = ctx.currentTime;

            if (type === 'mic-start') {
                osc.type = 'sine';
                osc.frequency.setValueAtTime(440, now);
                osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                osc.start(now);
                osc.stop(now + 0.15);
            } else if (type === 'mic-stop') {
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, now);
                osc.frequency.exponentialRampToValueAtTime(440, now + 0.12);
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                osc.start(now);
                osc.stop(now + 0.15);
            } else if (type === 'success') {
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(523.25, now); // C5
                osc.frequency.setValueAtTime(659.25, now + 0.08); // E5
                osc.frequency.setValueAtTime(783.99, now + 0.16); // G5
                gain.gain.setValueAtTime(0.06, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
                osc.start(now);
                osc.stop(now + 0.35);
            } else if (type === 'error') {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(220, now);
                osc.frequency.setValueAtTime(160, now + 0.1);
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
                osc.start(now);
                osc.stop(now + 0.25);
            }
        } catch (e) {
            console.debug('Audio feedback error:', e);
        }
    }

    // -------------------------------------------------------------------------
    // TOAST NOTIFICATIONS
    // -------------------------------------------------------------------------
    function showToast(message, type = 'info', duration = 3500) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const iconMap = {
            success: 'fa-circle-check',
            error: 'fa-circle-xmark',
            info: 'fa-circle-info'
        };

        toast.innerHTML = `
            <i class="fa-solid ${iconMap[type] || 'fa-bell'}"></i>
            <span>${message}</span>
        `;
        
        elements.toastContainer.appendChild(toast);
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // -------------------------------------------------------------------------
    // WEB SPEECH API INITIALIZATION & CONTROLS
    // -------------------------------------------------------------------------
    function initSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            elements.micBtn.title = 'Web Speech API not supported in this browser. Use Chrome or Edge for voice support.';
            elements.micBtn.style.opacity = '0.5';
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            state.isListening = true;
            elements.micBtn.classList.add('recording');
            elements.voiceListeningBanner.classList.add('active');
            elements.voiceTranscriptPreview.textContent = 'Listening... Speak naturally (e.g. "Add employee Sarah...")';
            playAudioTone('mic-start');
        };

        recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }

            const current = finalTranscript || interimTranscript;
            if (current) {
                elements.voiceTranscriptPreview.textContent = `"${current}"`;
                elements.promptInput.value = current;
                autoExpandTextarea(elements.promptInput);
            }
        };

        recognition.onerror = (event) => {
            console.warn('Speech Recognition error:', event.error);
            stopListening();
            if (event.error !== 'no-speech') {
                showToast(`Microphone notice: ${event.error}`, 'info');
            }
        };

        recognition.onend = () => {
            stopListening();
            // If user provided a prompt via voice, auto-focus execute button
            if (elements.promptInput.value.trim().length > 3) {
                elements.executeBtn.focus();
            }
        };

        state.recognition = recognition;
    }

    function toggleListening() {
        if (!state.recognition) {
            showToast('Voice input requires Chrome or Edge (Web Speech API).', 'info');
            return;
        }

        if (state.isListening) {
            state.recognition.stop();
            stopListening();
        } else {
            try {
                state.recognition.start();
            } catch (e) {
                console.error('Cannot start recognition:', e);
                state.recognition.stop();
            }
        }
    }

    function stopListening() {
        state.isListening = false;
        elements.micBtn.classList.remove('recording');
        elements.voiceListeningBanner.classList.remove('active');
        playAudioTone('mic-stop');
    }

    // -------------------------------------------------------------------------
    // SCHEMA INTROSPECTION & SIDEBAR RENDERING
    // -------------------------------------------------------------------------
    async function fetchSchema() {
        try {
            elements.refreshSchemaBtn.querySelector('i').classList.add('fa-spin');
            const res = await fetch('/api/schema');
            const data = await res.json();
            
            if (data.success && data.schema) {
                state.currentSchema = data.schema;
                renderSchemaTree(data.schema);
                updateTopBarStats(data.schema);
            }
        } catch (err) {
            console.error('Failed to introspect schema:', err);
        } finally {
            setTimeout(() => {
                elements.refreshSchemaBtn.querySelector('i').classList.remove('fa-spin');
            }, 300);
        }
    }

    function updateTopBarStats(schema) {
        const count = schema.total_tables || 0;
        elements.tableCountBadge.textContent = count;
        elements.dbTableCountBadge.textContent = `${count} ${count === 1 ? 'Table' : 'Tables'} Active`;
        
        // Update Gemini Model Badge if key exists in storage
        const storedKey = localStorage.getItem('neoassist_gemini_key');
        if (storedKey) {
            elements.aiModelText.textContent = 'Gemini Active';
            elements.aiModelBadge.classList.add('active-pill');
        } else {
            elements.aiModelText.textContent = 'Autonomous Engine';
        }
    }

    function renderSchemaTree(schema) {
        elements.schemaTreeContainer.innerHTML = '';
        
        if (!schema.tables || schema.tables.length === 0) {
            elements.schemaTreeContainer.innerHTML = `
                <div class="schema-empty-state">
                    <div class="empty-icon-wrap">
                        <i class="fa-solid fa-cube"></i>
                    </div>
                    <h4>Zero-Config Start</h4>
                    <p>Database is currently 100% empty (0 tables).</p>
                    <div class="empty-guidance">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                        <span>Speak or type an instruction to dynamically build tables & insert records automatically!</span>
                    </div>
                </div>
            `;
            return;
        }

        const filter = (elements.schemaSearchInput.value || '').toLowerCase().trim();

        schema.tables.forEach(table => {
            // Check if matches filter
            const matchesTable = table.name.toLowerCase().includes(filter);
            const matchingCols = table.columns.filter(c => c.name.toLowerCase().includes(filter) || c.type.toLowerCase().includes(filter));
            
            if (filter && !matchesTable && matchingCols.length === 0) {
                return;
            }

            const card = document.createElement('div');
            card.className = 'table-card';
            
            card.innerHTML = `
                <div class="table-card-header" data-table="${table.name}">
                    <div class="table-title-area">
                        <i class="fa-solid fa-table cyan-glow-icon"></i>
                        <span class="table-name">${escapeHtml(table.name)}</span>
                        <span class="table-row-tag">${table.row_count} rows</span>
                    </div>
                    <div class="table-actions">
                        <button class="table-quick-btn query-btn" title="SELECT * FROM ${table.name}">
                            <i class="fa-solid fa-play"></i>
                        </button>
                        <button class="table-quick-btn count-btn" title="COUNT(*) FROM ${table.name}">
                            <i class="fa-solid fa-calculator"></i>
                        </button>
                        <button class="table-quick-btn drop-btn" title="DROP TABLE ${table.name}">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="table-columns-list">
                    ${table.columns.map(col => `
                        <div class="column-row">
                            <div class="column-name-wrap">
                                ${col.pk ? '<span class="col-pk-badge">PK</span>' : '<i class="fa-regular fa-circle" style="font-size:7px;color:#64748b;"></i>'}
                                <span>${escapeHtml(col.name)}</span>
                            </div>
                            <span class="col-type-tag">${escapeHtml(col.type)}</span>
                        </div>
                    `).join('')}
                </div>
            `;

            // Table quick action bindings
            const queryBtn = card.querySelector('.query-btn');
            queryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                runDirectQuery(`SELECT * FROM "${table.name}" LIMIT 50;`);
            });

            const countBtn = card.querySelector('.count-btn');
            countBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                runDirectQuery(`SELECT COUNT(*) as total_records FROM "${table.name}";`);
            });

            const dropBtn = card.querySelector('.drop-btn');
            dropBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Are you sure you want to DROP TABLE "${table.name}"?`)) {
                    runDirectQuery(`DROP TABLE IF EXISTS "${table.name}";`);
                }
            });

            // Click table header to view records
            card.querySelector('.table-card-header').addEventListener('click', () => {
                runDirectQuery(`SELECT * FROM "${table.name}" LIMIT 50;`);
            });

            elements.schemaTreeContainer.appendChild(card);
        });
    }

    // -------------------------------------------------------------------------
    // EXECUTION PIPELINE (VOICE / TEXT / SQL)
    // -------------------------------------------------------------------------
    async function executeQuery() {
        const prompt = elements.promptInput.value.trim();
        if (!prompt) {
            showToast('Please type or speak a command first.', 'info');
            elements.promptInput.focus();
            return;
        }

        const isDirectSql = elements.directSqlToggle.checked;
        const storedKey = localStorage.getItem('neoassist_gemini_key') || '';

        // UI Loading State
        setLoadingState(true);

        try {
            const res = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: prompt,
                    api_key: storedKey,
                    direct_sql: isDirectSql
                })
            });

            const data = await res.json();

            if (!res.ok || !data.success) {
                const errMsg = data.error || data.execution?.error || 'Execution failed';
                showToast(`Error: ${errMsg}`, 'error');
                playAudioTone('error');

                // Render error state in terminal
                elements.sqlCodeBlock.innerHTML = `<span style="color:#fb7185;">-- EXECUTION ERROR:\n${escapeHtml(errMsg)}\n\n-- SQL:\n${escapeHtml(data.ai_result?.sql || prompt)}</span>`;
                elements.queryTypeBadge.textContent = 'ERROR';
                elements.queryLatencyBadge.innerHTML = `<i class="fa-solid fa-clock"></i> ${data.execution?.execution_time_ms || 0} ms`;
                return;
            }

            // Success path
            playAudioTone('success');
            showToast('Autonomous pipeline executed successfully!', 'success');

            // 1. Update Terminal SQL Display with syntax highlighting
            const rawSql = data.execution.executed_sql || data.ai_result?.sql || prompt;
            renderSyntaxHighlightedSql(rawSql);

            // 2. Update Terminal Badges
            elements.queryTypeBadge.textContent = data.ai_result?.query_type || (isDirectSql ? 'SQL' : 'AI DQL');
            elements.queryLatencyBadge.innerHTML = `<i class="fa-solid fa-clock"></i> ${data.execution.execution_time_ms} ms`;
            
            const rowCount = data.execution.row_count || 0;
            const affected = data.execution.rows_affected || 0;
            elements.queryRowBadge.innerHTML = `<i class="fa-solid fa-layer-group"></i> ${rowCount ? `${rowCount} rows` : `${affected} affected`}`;

            // 3. Update AI Insights Card
            elements.insightsContent.textContent = data.ai_result?.explanation || 'Query executed cleanly on SQLite database.';
            if (data.ai_result?.insights) {
                elements.insightsContent.innerHTML += `<br><strong style="color:var(--accent-cyan);margin-top:6px;display:inline-block;">💡 Strategic Finding:</strong> ${escapeHtml(data.ai_result.insights)}`;
            }
            elements.insightsSourceTag.textContent = data.ai_result?.source || 'Autonomous Engine';

            // 4. Update Interactive Data Workspace
            state.currentResultData = {
                columns: data.execution.columns || [],
                rows: data.execution.rows || []
            };
            renderDataTable(state.currentResultData);

            // 5. Update Live Schema Sidebar
            if (data.schema) {
                state.currentSchema = data.schema;
                renderSchemaTree(data.schema);
                updateTopBarStats(data.schema);
            } else {
                fetchSchema();
            }

        } catch (err) {
            console.error('Execution exception:', err);
            showToast(`System exception: ${err.message}`, 'error');
            playAudioTone('error');
        } finally {
            setLoadingState(false);
        }
    }

    function runDirectQuery(sql) {
        elements.promptInput.value = sql;
        elements.directSqlToggle.checked = true;
        autoExpandTextarea(elements.promptInput);
        executeQuery();
    }

    function setLoadingState(isLoading) {
        elements.executeBtn.disabled = isLoading;
        if (isLoading) {
            elements.executeIcon.className = 'fa-solid fa-circle-notch fa-spin';
            elements.executeBtnText.textContent = 'Running...';
            elements.sqlCodeBlock.innerHTML = '<span style="color:#94a3b8;">-- Synthesizing autonomous schema & executing query...\n-- Please wait...</span>';
            elements.queryTypeBadge.textContent = 'RUNNING';
        } else {
            elements.executeIcon.className = 'fa-solid fa-bolt-lightning';
            elements.executeBtnText.textContent = 'Execute';
        }
    }

    // -------------------------------------------------------------------------
    // SYNTAX HIGHLIGHTING (SQL FORMATTER)
    // -------------------------------------------------------------------------
    function renderSyntaxHighlightedSql(rawSql) {
        const keywords = [
            'SELECT', 'FROM', 'WHERE', 'CREATE', 'TABLE', 'IF', 'NOT', 'EXISTS',
            'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'DROP', 'ALTER',
            'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER',
            'ASC', 'DESC', 'LIMIT', 'OFFSET', 'PRIMARY', 'KEY', 'AUTOINCREMENT',
            'AND', 'OR', 'IN', 'LIKE', 'AS', 'PRAGMA', 'WITH', 'DEFAULT', 'GENERATED',
            'ALWAYS', 'STORED', 'TEXT', 'INTEGER', 'REAL', 'TIMESTAMP', 'DATE', 'BOOLEAN'
        ];

        const funcs = ['COUNT', 'AVG', 'SUM', 'MAX', 'MIN', 'ROUND', 'DATE', 'DATETIME'];

        let highlighted = escapeHtml(rawSql);

        // Highlight strings
        highlighted = highlighted.replace(/'([^']*)'/g, '<span class="sql-str">\'$1\'</span>');
        
        // Highlight numbers
        highlighted = highlighted.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="sql-num">$1</span>');

        // Highlight functions
        funcs.forEach(fn => {
            const regex = new RegExp(`\\b(${fn})\\b(?=\\s*\\()`, 'gi');
            highlighted = highlighted.replace(regex, '<span class="sql-fn">$1</span>');
        });

        // Highlight keywords
        keywords.forEach(kw => {
            const regex = new RegExp(`\\b(${kw})\\b`, 'gi');
            highlighted = highlighted.replace(regex, '<span class="sql-keyword">$1</span>');
        });

        elements.sqlCodeBlock.innerHTML = highlighted;
    }

    // -------------------------------------------------------------------------
    // INTERACTIVE DATA WORKSPACE RENDERING
    // -------------------------------------------------------------------------
    function renderDataTable(data) {
        const { columns, rows } = data;
        
        if (!columns || columns.length === 0 || !rows || rows.length === 0) {
            elements.neoDataTable.style.display = 'none';
            elements.tableEmptyState.style.display = 'flex';
            elements.dataCountTag.textContent = '0 records';
            return;
        }

        elements.tableEmptyState.style.display = 'none';
        elements.neoDataTable.style.display = 'table';
        elements.dataCountTag.textContent = `${rows.length} ${rows.length === 1 ? 'record' : 'records'}`;

        // Build Header
        elements.neoTableHead.innerHTML = `
            <tr>
                ${columns.map((col, idx) => `
                    <th data-col-index="${idx}" data-col-name="${escapeHtml(col)}">
                        <div class="th-inner">
                            <span>${escapeHtml(col)}</span>
                            <i class="fa-solid fa-sort sort-icon" id="sort-icon-${idx}"></i>
                        </div>
                    </th>
                `).join('')}
            </tr>
        `;

        // Attach sort listeners
        elements.neoTableHead.querySelectorAll('th').forEach(th => {
            th.addEventListener('click', () => {
                const colName = th.getAttribute('data-col-name');
                const colIdx = parseInt(th.getAttribute('data-col-index'), 10);
                sortTable(colName, colIdx);
            });
        });

        // Render Body
        renderTableRows(rows, columns);
    }

    function renderTableRows(rows, columns) {
        elements.neoTableBody.innerHTML = '';
        const filterVal = (elements.tableFilterInput.value || '').toLowerCase().trim();

        rows.forEach(row => {
            // Apply client filter
            if (filterVal) {
                const rowStr = Object.values(row).join(' ').toLowerCase();
                if (!rowStr.includes(filterVal)) return;
            }

            const tr = document.createElement('tr');
            columns.forEach(col => {
                const val = row[col];
                const td = document.createElement('td');

                if (typeof val === 'number') {
                    td.className = 'td-number';
                    td.textContent = Number.isInteger(val) ? val.toLocaleString() : val.toFixed(2);
                } else if (val === null || val === undefined) {
                    td.innerHTML = '<span style="color:#64748b;font-style:italic;">NULL</span>';
                } else {
                    td.textContent = String(val);
                }

                tr.appendChild(td);
            });
            elements.neoTableBody.appendChild(tr);
        });
    }

    function sortTable(columnName, colIdx) {
        if (!state.currentResultData.rows || state.currentResultData.rows.length === 0) return;

        let direction = 'asc';
        if (state.sortState.column === columnName && state.sortState.direction === 'asc') {
            direction = 'desc';
        }

        state.sortState = { column: columnName, direction: direction };

        // Update sort icons
        elements.neoTableHead.querySelectorAll('.sort-icon').forEach(icon => {
            icon.className = 'fa-solid fa-sort sort-icon';
        });
        const currentIcon = document.getElementById(`sort-icon-${colIdx}`);
        if (currentIcon) {
            currentIcon.className = `fa-solid fa-sort-${direction === 'asc' ? 'up' : 'down'} sort-icon cyan-glow-icon`;
        }

        // Sort data
        state.currentResultData.rows.sort((a, b) => {
            const valA = a[columnName];
            const valB = b[columnName];

            if (valA === valB) return 0;
            if (valA === null || valA === undefined) return 1;
            if (valB === null || valB === undefined) return -1;

            if (typeof valA === 'number' && typeof valB === 'number') {
                return direction === 'asc' ? valA - valB : valB - valA;
            }
            return direction === 'asc'
                ? String(valA).localeCompare(String(valB))
                : String(valB).localeCompare(String(valA));
        });

        renderTableRows(state.currentResultData.rows, state.currentResultData.columns);
    }

    // -------------------------------------------------------------------------
    // EXPORT UTILITIES (CSV / JSON)
    // -------------------------------------------------------------------------
    function exportToCsv() {
        const { columns, rows } = state.currentResultData;
        if (!rows || rows.length === 0) {
            showToast('No data to export.', 'info');
            return;
        }

        const headerRow = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(',');
        const dataRows = rows.map(r => {
            return columns.map(c => {
                const val = r[c] !== null && r[c] !== undefined ? String(r[c]) : '';
                return `"${val.replace(/"/g, '""')}"`;
            }).join(',');
        });

        const csvContent = [headerRow, ...dataRows].join('\n');
        downloadFile(csvContent, 'neoassist_export.csv', 'text/csv');
        showToast('Exported dataset to CSV!', 'success');
    }

    function exportToJson() {
        const { rows } = state.currentResultData;
        if (!rows || rows.length === 0) {
            showToast('No data to export.', 'info');
            return;
        }

        const jsonContent = JSON.stringify(rows, null, 2);
        downloadFile(jsonContent, 'neoassist_export.json', 'application/json');
        showToast('Exported dataset to JSON!', 'success');
    }

    function downloadFile(content, fileName, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // -------------------------------------------------------------------------
    // COPY TO CLIPBOARD
    // -------------------------------------------------------------------------
    function copySqlToClipboard() {
        const sql = elements.sqlCodeBlock.innerText;
        if (!sql) return;

        navigator.clipboard.writeText(sql).then(() => {
            elements.copyBtnText.textContent = 'Copied!';
            elements.copyIcon.className = 'fa-solid fa-check text-success';
            showToast('SQL copied to clipboard!', 'success');
            setTimeout(() => {
                elements.copyBtnText.textContent = 'Copy SQL';
                elements.copyIcon.className = 'fa-regular fa-copy';
            }, 2000);
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
                playAudioTone('success');
                elements.resetModal.classList.remove('show');
                
                // Clear UI state
                state.currentResultData = { columns: [], rows: [] };
                renderDataTable(state.currentResultData);
                
                elements.sqlCodeBlock.innerHTML = '-- Database reset to 0 tables (Empty state).\n-- Ready for autonomous schema synthesis.';
                elements.queryTypeBadge.textContent = 'RESET';
                elements.queryLatencyBadge.innerHTML = '<i class="fa-solid fa-clock"></i> 0.0 ms';
                elements.queryRowBadge.innerHTML = '<i class="fa-solid fa-layer-group"></i> 0 rows';
                elements.insightsContent.textContent = 'Database cleanly wiped to zero-config state. Enter your first prompt to generate tables dynamically.';

                // Update Schema
                fetchSchema();
            } else {
                showToast(`Reset error: ${data.error}`, 'error');
            }
        } catch (e) {
            showToast(`Reset failed: ${e.message}`, 'error');
        } finally {
            elements.confirmResetBtn.disabled = false;
            elements.confirmResetBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Confirm Reset (0 Tables)';
        }
    }

    // -------------------------------------------------------------------------
    // GEMINI API KEY MODAL
    // -------------------------------------------------------------------------
    function setupApiKeyModal() {
        const storedKey = localStorage.getItem('neoassist_gemini_key') || '';
        if (storedKey) {
            elements.geminiKeyInput.value = storedKey;
        }

        elements.apiKeyModalBtn.addEventListener('click', () => {
            elements.apiKeyModal.classList.add('show');
            elements.keyModalStatus.style.display = 'none';
        });

        elements.closeApiKeyModalBtn.addEventListener('click', () => {
            elements.apiKeyModal.classList.remove('show');
        });

        elements.cancelApiKeyBtn.addEventListener('click', () => {
            elements.apiKeyModal.classList.remove('show');
        });

        elements.toggleKeyVisibility.addEventListener('click', () => {
            if (elements.geminiKeyInput.type === 'password') {
                elements.geminiKeyInput.type = 'text';
                elements.keyVisIcon.className = 'fa-regular fa-eye-slash';
            } else {
                elements.geminiKeyInput.type = 'password';
                elements.keyVisIcon.className = 'fa-regular fa-eye';
            }
        });

        elements.saveApiKeyBtn.addEventListener('click', async () => {
            const key = elements.geminiKeyInput.value.trim();
            if (!key) {
                elements.keyModalStatus.className = 'modal-status-msg error';
                elements.keyModalStatus.textContent = 'Please enter a valid key or cancel.';
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
                    elements.keyModalStatus.className = 'modal-status-msg success';
                    elements.keyModalStatus.textContent = data.message;
                    showToast('Gemini API Key connected successfully!', 'success');
                    elements.aiModelText.textContent = 'Gemini 1.5 Flash';
                    elements.aiModelBadge.classList.add('active-pill');

                    setTimeout(() => {
                        elements.apiKeyModal.classList.remove('show');
                    }, 1200);
                } else {
                    elements.keyModalStatus.className = 'modal-status-msg error';
                    elements.keyModalStatus.textContent = data.error || 'Failed to verify API key.';
                }
            } catch (err) {
                elements.keyModalStatus.className = 'modal-status-msg error';
                elements.keyModalStatus.textContent = `Network error: ${err.message}`;
            } finally {
                elements.saveApiKeyBtn.disabled = false;
                elements.saveApiKeyBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save & Verify Key';
            }
        });
    }

    // -------------------------------------------------------------------------
    // UTILITIES & EVENT BINDINGS
    // -------------------------------------------------------------------------
    function autoExpandTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
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
        // Execute button & input hotkeys
        elements.executeBtn.addEventListener('click', executeQuery);
        
        elements.promptInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                executeQuery();
            } else if (e.key === 'Enter' && !e.shiftKey) {
                // If single-line prompt, execute on enter
                e.preventDefault();
                executeQuery();
            }
        });

        elements.promptInput.addEventListener('input', () => {
            autoExpandTextarea(elements.promptInput);
        });

        // Mic button
        elements.micBtn.addEventListener('click', toggleListening);
        elements.voiceCancelBtn.addEventListener('click', stopListening);

        // Copy SQL
        elements.copySqlBtn.addEventListener('click', copySqlToClipboard);

        // Export Buttons
        elements.exportCsvBtn.addEventListener('click', exportToCsv);
        elements.exportJsonBtn.addEventListener('click', exportToJson);

        // Filter result set
        elements.tableFilterInput.addEventListener('input', () => {
            renderTableRows(state.currentResultData.rows, state.currentResultData.columns);
        });

        // Sidebar search
        elements.schemaSearchInput.addEventListener('input', () => {
            renderSchemaTree(state.currentSchema);
        });

        // Sidebar refresh
        elements.refreshSchemaBtn.addEventListener('click', fetchSchema);

        // Preset chips
        elements.presetChipsContainer.querySelectorAll('.preset-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const promptText = chip.getAttribute('data-prompt');
                elements.promptInput.value = promptText;
                autoExpandTextarea(elements.promptInput);
                elements.directSqlToggle.checked = false;
                executeQuery();
            });
        });

        // Reset DB modal triggers
        elements.resetDbBtn.addEventListener('click', () => {
            elements.resetModal.classList.add('show');
        });
        elements.closeResetModalBtn.addEventListener('click', () => {
            elements.resetModal.classList.remove('show');
        });
        elements.cancelResetBtn.addEventListener('click', () => {
            elements.resetModal.classList.remove('show');
        });
        elements.confirmResetBtn.addEventListener('click', resetDatabase);

        // Audio toggle
        elements.audioToggleBtn.addEventListener('click', () => {
            state.soundEnabled = !state.soundEnabled;
            elements.audioToggleIcon.className = state.soundEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
            showToast(state.soundEnabled ? 'Audio feedback enabled' : 'Audio feedback muted', 'info');
        });

        // Direct SQL toggle label update
        elements.directSqlToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                elements.promptInput.placeholder = 'Enter raw SQL (e.g. SELECT * FROM employees; or CREATE TABLE ...)';
            } else {
                elements.promptInput.placeholder = "Speak or type a command... (e.g. 'Add an employee Sarah in Finance with salary 95000')";
            }
        });

        // Close modals on Escape key
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                elements.apiKeyModal.classList.remove('show');
                elements.resetModal.classList.remove('show');
                if (state.isListening) stopListening();
            }
        });
    }

    // -------------------------------------------------------------------------
    // INITIALIZATION
    // -------------------------------------------------------------------------
    function init() {
        console.log('NeoAssist AI Engine Initializing...');
        initSpeechRecognition();
        setupApiKeyModal();
        bindEvents();
        fetchSchema();
    }

    // Start on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
