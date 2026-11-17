document.addEventListener("DOMContentLoaded", () => {
    let schemaState = { db_name: "", tables: [] };

    // ==========================================
    // 1. NAVIGATION BETWEEN THE 3 SCREENS
    // ==========================================
    const navButtons = document.querySelectorAll(".nav-btn");
    const screens = document.querySelectorAll(".screen");

    navButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            navButtons.forEach(b => b.classList.remove("active"));
            screens.forEach(s => s.classList.remove("active"));

            btn.classList.add("active");
            const targetId = btn.getAttribute("data-target");
            document.getElementById(targetId).classList.add("active");
        });
    });

    function showToast(message) {
        const toast = document.getElementById("toast");
        toast.textContent = message;
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 3000);
    }

    // ==========================================
    // 2. LOAD INITIAL DATA (LOCALSTORAGE + SERVER)
    // ==========================================
    async function loadInitialData() {
        const savedLocalSchema = localStorage.getItem("text2sql_schema");
        if (savedLocalSchema) {
            schemaState = JSON.parse(savedLocalSchema);
            // Sync local schema to serverless backend
            await fetch("/api/schema", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(schemaState)
            });
        } else {
            const schemaRes = await fetch("/api/schema");
            schemaState = await schemaRes.json();
        }
        renderSchemaForm();
        updateSidebarStatus();

        const settingsRes = await fetch("/api/settings");
        const serverSettings = await settingsRes.json();
        const savedLocalSettings = JSON.parse(localStorage.getItem("text2sql_settings") || "{}");

        const activeKey = savedLocalSettings.groq_api_key || serverSettings.groq_api_key || "";
        const activeModel = savedLocalSettings.groq_model || serverSettings.groq_model;
        const activeDialect = savedLocalSettings.default_dialect || serverSettings.default_dialect;

        document.getElementById("groq-api-key-input").value = activeKey;
        document.getElementById("chat-dialect-select").value = activeDialect;
        document.getElementById("default-dialect-select").value = activeDialect;
        document.getElementById("active-model-indicator").textContent = `Model: ${activeModel}`;

        if (serverSettings.has_env_key && !activeKey) {
            document.getElementById("env-key-hint").textContent = "Server GROQ_API_KEY detected from Vercel Environment Variables.";
        }

        if (activeKey || serverSettings.has_env_key) {
            await checkGroqConnection(activeModel);
        } else {
            const badge = document.getElementById("groq-status-badge");
            badge.textContent = "API Key Required";
            badge.className = "status-badge status-disconnected";
        }
    }

    function updateSidebarStatus() {
        const dbName = schemaState.db_name || "Not configured";
        const tableCount = schemaState.tables ? schemaState.tables.length : 0;
        document.getElementById("active-db-indicator").textContent = `DB: ${dbName} (${tableCount} tables)`;
    }

    // ==========================================
    // 3. DATABASE SETUP SCREEN LOGIC
    // ==========================================
    const tablesContainer = document.getElementById("tables-container");
    const dbNameInput = document.getElementById("db-name-input");

    function renderSchemaForm() {
        dbNameInput.value = schemaState.db_name || "";
        tablesContainer.innerHTML = "";

        schemaState.tables.forEach((table, tIndex) => {
            const tableCard = document.createElement("div");
            tableCard.className = "table-card";

            let columnsRowsHtml = "";
            table.columns.forEach((col, cIndex) => {
                columnsRowsHtml += `
                    <tr>
                        <td><input type="text" placeholder="e.g., user_id" value="${escapeHtml(col.name)}" onchange="updateColumn(${tIndex}, ${cIndex}, 'name', this.value)"></td>
                        <td><input type="text" placeholder="e.g., INT, VARCHAR(100)" value="${escapeHtml(col.type)}" onchange="updateColumn(${tIndex}, ${cIndex}, 'type', this.value)"></td>
                        <td style="text-align:center;"><input type="checkbox" ${col.pk ? "checked" : ""} onchange="updateColumn(${tIndex}, ${cIndex}, 'pk', this.checked)"></td>
                        <td><input type="text" placeholder="Optional: users.id" value="${escapeHtml(col.fk || "")}" onchange="updateColumn(${tIndex}, ${cIndex}, 'fk', this.value)"></td>
                        <td><input type="text" placeholder="What does this column mean?" value="${escapeHtml(col.description || "")}" onchange="updateColumn(${tIndex}, ${cIndex}, 'description', this.value)"></td>
                        <td><button type="button" class="btn btn-danger" onclick="removeColumn(${tIndex}, ${cIndex})">✕</button></td>
                    </tr>
                `;
            });

            tableCard.innerHTML = `
                <div class="table-card-header">
                    <div style="flex:1;">
                        <label><strong>Table Name</strong></label>
                        <input type="text" class="text-input" placeholder="e.g., orders" value="${escapeHtml(table.table_name)}" onchange="updateTableName(${tIndex}, this.value)">
                    </div>
                    <button type="button" class="btn btn-danger" onclick="removeTable(${tIndex})">Delete Table</button>
                </div>

                <table class="columns-table">
                    <thead>
                        <tr>
                            <th style="width: 18%;">Column Name</th>
                            <th style="width: 15%;">Data Type</th>
                            <th style="width: 6%; text-align:center;">PK</th>
                            <th style="width: 18%;">Foreign Key (Optional)</th>
                            <th style="width: 37%;">Description</th>
                            <th style="width: 6%;"></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${columnsRowsHtml}
                    </tbody>
                </table>

                <button type="button" class="btn btn-secondary" onclick="addColumn(${tIndex})">+ Add Column</button>
            `;

            tablesContainer.appendChild(tableCard);
        });
    }

    window.updateTableName = (tIndex, value) => {
        schemaState.tables[tIndex].table_name = value.trim();
    };

    window.updateColumn = (tIndex, cIndex, field, value) => {
        schemaState.tables[tIndex].columns[cIndex][field] = typeof value === "string" ? value.trim() : value;
    };

    window.addColumn = (tIndex) => {
        schemaState.tables[tIndex].columns.push({
            name: "",
            type: "VARCHAR(100)",
            pk: false,
            fk: "",
            description: ""
        });
        renderSchemaForm();
    };

    window.removeColumn = (tIndex, cIndex) => {
        schemaState.tables[tIndex].columns.splice(cIndex, 1);
        renderSchemaForm();
    };

    window.removeTable = (tIndex) => {
        schemaState.tables.splice(tIndex, 1);
        renderSchemaForm();
    };

    document.getElementById("add-table-btn").addEventListener("click", () => {
        schemaState.tables.push({
            table_name: "",
            columns: [
                { name: "id", type: "INT", pk: true, fk: "", description: "Primary key" }
            ]
        });
        renderSchemaForm();
    });

    document.getElementById("save-schema-btn").addEventListener("click", async () => {
        schemaState.db_name = dbNameInput.value.trim();

        const cleanedTables = schemaState.tables
            .filter(t => t.table_name.trim() !== "")
            .map(t => ({
                table_name: t.table_name.trim(),
                columns: t.columns.filter(c => c.name.trim() !== "")
            }));

        schemaState.tables = cleanedTables;
        localStorage.setItem("text2sql_schema", JSON.stringify(schemaState));

        const res = await fetch("/api/schema", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(schemaState)
        });

        const data = await res.json();
        renderSchemaForm();
        updateSidebarStatus();
        showToast(data.message || "Schema saved!");
    });

    // ==========================================
    // 4. SETTINGS SCREEN LOGIC
    // ==========================================
    async function checkGroqConnection(selectedModel = null) {
        const statusBadge = document.getElementById("groq-status-badge");
        const modelSelect = document.getElementById("groq-model-select");
        const apiKey = document.getElementById("groq-api-key-input").value.trim();

        statusBadge.textContent = "Verifying Groq API...";
        statusBadge.className = "status-badge status-checking";

        const res = await fetch("/api/groq/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groq_api_key: apiKey })
        });
        const data = await res.json();

        if (data.connected) {
            statusBadge.textContent = `Connected (${data.models.length} models available)`;
            statusBadge.className = "status-badge status-connected";

            if (data.models.length > 0) {
                const currentVal = selectedModel || modelSelect.value;
                modelSelect.innerHTML = "";
                data.models.forEach(modelName => {
                    const opt = document.createElement("option");
                    opt.value = modelName;
                    opt.textContent = modelName;
                    if (modelName === currentVal) {
                        opt.selected = true;
                    }
                    modelSelect.appendChild(opt);
                });
            }
        } else {
            statusBadge.textContent = data.error || "Invalid API Key";
            statusBadge.className = "status-badge status-disconnected";
        }
    }

    document.getElementById("test-connection-btn").addEventListener("click", () => {
        checkGroqConnection();
    });

    document.getElementById("save-settings-btn").addEventListener("click", async () => {
        const apiKey = document.getElementById("groq-api-key-input").value.trim();
        const model = document.getElementById("groq-model-select").value;
        const dialect = document.getElementById("default-dialect-select").value;

        localStorage.setItem("text2sql_settings", JSON.stringify({
            groq_api_key: apiKey,
            groq_model: model,
            default_dialect: dialect
        }));

        const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                groq_api_key: apiKey,
                groq_model: model,
                default_dialect: dialect
            })
        });

        const data = await res.json();
        document.getElementById("chat-dialect-select").value = dialect;
        document.getElementById("active-model-indicator").textContent = `Model: ${model}`;
        showToast(data.message || "Settings saved!");
        checkGroqConnection(model);
    });

    // ==========================================
    // 5. CHATBOT SCREEN LOGIC
    // ==========================================
    const chatForm = document.getElementById("chat-form");
    const userInput = document.getElementById("user-input");
    const chatBox = document.getElementById("chat-box");
    const sendBtn = document.getElementById("send-btn");

    chatForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const message = userInput.value.trim();
        const dialect = document.getElementById("chat-dialect-select").value;
        const savedSettings = JSON.parse(localStorage.getItem("text2sql_settings") || "{}");
        if (!message) return;

        appendMessage("user", message);
        userInput.value = "";
        sendBtn.disabled = true;
        sendBtn.textContent = "Thinking...";

        const loadingId = appendMessage("bot", `Generating ${dialect} query via Groq...`);

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message,
                    dialect,
                    schema: schemaState,
                    model: savedSettings.groq_model || document.getElementById("groq-model-select").value,
                    api_key: savedSettings.groq_api_key || ""
                })
            });

            const data = await res.json();
            document.getElementById(loadingId).remove();

            if (data.error) {
                appendMessage("bot", `⚠️ Error: ${data.error}`);
            } else {
                appendBotFormattedMessage(data.reply, data.dialect || dialect);
            }
        } catch (err) {
            document.getElementById(loadingId).remove();
            appendMessage("bot", "⚠️ Network error while contacting server.");
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = "Generate SQL";
        }
    });

    document.getElementById("clear-chat-btn").addEventListener("click", async () => {
        await fetch("/api/chat/clear", { method: "POST" });
        chatBox.innerHTML = `
            <div class="message bot-message">
                <div class="message-content">Chat history cleared. Ask a new question whenever you're ready!</div>
            </div>
        `;
    });

    function appendMessage(sender, text) {
        const id = "msg-" + Date.now();
        const div = document.createElement("div");
        div.id = id;
        div.className = `message ${sender === "user" ? "user-message" : "bot-message"}`;
        div.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
        chatBox.appendChild(div);
        chatBox.scrollTop = chatBox.scrollHeight;
        return id;
    }

    function appendBotFormattedMessage(markdownText, dialect) {
        const div = document.createElement("div");
        div.className = "message bot-message";

        const sqlRegex = /```sql\s*([\s\S]*?)```/gi;
        let formattedHtml = escapeHtml(markdownText);

        formattedHtml = formattedHtml.replace(sqlRegex, (match, sqlCode) => {
            const cleanSql = sqlCode.trim();
            const encodedSql = encodeURIComponent(cleanSql);
            return `
                <div class="sql-block-wrapper">
                    <div class="sql-block-header">
                        <span>${escapeHtml(dialect)} Query</span>
                        <button type="button" class="copy-sql-btn" onclick="copySqlToClipboard(this, '${encodedSql}')">Copy SQL</button>
                    </div>
                    <pre class="sql-code">${cleanSql}</pre>
                </div>
            `;
        });

        formattedHtml = formattedHtml.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        formattedHtml = formattedHtml.replace(/\n/g, "<br>");

        div.innerHTML = `<div class="message-content">${formattedHtml}</div>`;
        chatBox.appendChild(div);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    window.copySqlToClipboard = (buttonEl, encodedSql) => {
        const sqlText = decodeURIComponent(encodedSql);
        navigator.clipboard.writeText(sqlText).then(() => {
            buttonEl.textContent = "Copied!";
            setTimeout(() => {
                buttonEl.textContent = "Copy SQL";
            }, 2000);
        });
    };

    function escapeHtml(str) {
        if (!str) return "";
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    loadInitialData();
});
