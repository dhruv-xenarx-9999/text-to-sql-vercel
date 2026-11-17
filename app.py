import os
import json
import sqlite3
import requests
from flask import Flask, render_template, request, jsonify, session

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "vercel_text_to_sql_secret_key")

IS_VERCEL = os.environ.get("VERCEL") == "1"
DB_FILE = "/tmp/database.db" if IS_VERCEL else "database.db"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"


# ==========================================
# 1. SQLITE INITIALIZATION & HELPERS
# ==========================================
def init_db():
    """Creates SQLite tables to store database metadata and Groq settings."""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS schema_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            db_name TEXT NOT NULL,
            tables_json TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            groq_api_key TEXT NOT NULL,
            groq_model TEXT NOT NULL,
            default_dialect TEXT NOT NULL
        )
    """)

    default_key = os.environ.get("GROQ_API_KEY", "")
    default_model = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")

    cursor.execute("""
        INSERT OR IGNORE INTO settings (id, groq_api_key, groq_model, default_dialect)
        VALUES (1, ?, ?, 'PostgreSQL')
    """, (default_key, default_model))

    cursor.execute("SELECT COUNT(*) FROM schema_config")
    if cursor.fetchone()[0] == 0:
        sample_tables = [
            {
                "table_name": "customers",
                "columns": [
                    {"name": "customer_id", "type": "INT", "pk": True, "fk": "", "description": "Unique ID for each customer"},
                    {"name": "full_name", "type": "VARCHAR(100)", "pk": False, "fk": "", "description": "Customer first and last name"},
                    {"name": "email", "type": "VARCHAR(150)", "pk": False, "fk": "", "description": "Customer email address"}
                ]
            },
            {
                "table_name": "orders",
                "columns": [
                    {"name": "order_id", "type": "INT", "pk": True, "fk": "", "description": "Unique order identifier"},
                    {"name": "customer_id", "type": "INT", "pk": False, "fk": "customers.customer_id", "description": "Links order to the customer who placed it"},
                    {"name": "total_amount", "type": "DECIMAL(10,2)", "pk": False, "fk": "", "description": "Total order cost in USD"},
                    {"name": "order_date", "type": "DATE", "pk": False, "fk": "", "description": "Date the order was placed"}
                ]
            }
        ]
        cursor.execute(
            "INSERT INTO schema_config (id, db_name, tables_json) VALUES (1, ?, ?)",
            ("ecommerce_db", json.dumps(sample_tables))
        )

    conn.commit()
    conn.close()


init_db()


def get_schema_data():
    if not os.path.exists(DB_FILE):
        init_db()
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT db_name, tables_json FROM schema_config WHERE id = 1")
    row = cursor.fetchone()
    conn.close()
    if row:
        return {"db_name": row[0], "tables": json.loads(row[1])}
    return {"db_name": "", "tables": []}


def get_settings_data():
    if not os.path.exists(DB_FILE):
        init_db()
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT groq_api_key, groq_model, default_dialect FROM settings WHERE id = 1")
    row = cursor.fetchone()
    conn.close()
    env_key = os.environ.get("GROQ_API_KEY", "")
    env_model = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")
    if row:
        api_key = row[0] or env_key
        return {"groq_api_key": api_key, "groq_model": row[1] or env_model, "default_dialect": row[2], "has_env_key": bool(env_key)}
    return {"groq_api_key": env_key, "groq_model": env_model, "default_dialect": "PostgreSQL", "has_env_key": bool(env_key)}


# ==========================================
# 2. PROMPT ENGINEERING FOR TEXT-TO-SQL
# ==========================================
def build_system_prompt(schema_data, dialect):
    """Formats the saved metadata into clear instructions for the model."""
    db_name = schema_data.get("db_name", "my_database")
    tables = schema_data.get("tables", [])

    if not tables:
        schema_text = "NO TABLES CONFIGURED YET."
    else:
        lines = [f"Database Name: {db_name}\nTables and Columns:"]
        for t in tables:
            lines.append(f"\nTable: {t['table_name']}")
            for col in t.get("columns", []):
                pk_tag = " [PRIMARY KEY]" if col.get("pk") else ""
                fk_tag = f" [FOREIGN KEY -> {col['fk']}]" if col.get("fk") else ""
                desc_tag = f" -- Description: {col['description']}" if col.get("description") else ""
                lines.append(f"  - {col['name']} ({col['type']}){pk_tag}{fk_tag}{desc_tag}")
        schema_text = "\n".join(lines)

    return f"""You are an expert SQL assistant. Your job is to convert English questions into accurate SQL queries using ONLY the database schema provided below.

TARGET SQL DIALECT: {dialect}
(You MUST strictly follow {dialect} syntax rules, functions, date formatting, quoting, and pagination like LIMIT vs TOP.)

SAVED DATABASE SCHEMA:
{schema_text}

STRICT RULES:
1. ONLY use the exact database, tables, columns, and relationships listed in the SAVED DATABASE SCHEMA above.
2. NEVER invent, guess, or assume tables, columns, or relationships that are not explicitly listed.
3. Use the defined Primary Keys and Foreign Keys when joining tables.
4. Read column descriptions carefully to understand business meaning.
5. Generate SELECT queries by default unless the user explicitly asks for INSERT, UPDATE, or DELETE.
6. NEVER claim you executed the query. You only write the SQL.
7. If the user's question cannot be answered with the configured tables/columns, or if details are ambiguous, DO NOT guess SQL—instead, politely ask the user a clarifying question explaining what column or table information is missing.
8. Keep your response clean and structured:
   - First, provide the SQL query inside a ```sql code block (if enough info is available).
   - Second, provide a brief, plain-English explanation (2-3 sentences) of how the query works.
"""


# ==========================================
# 3. FLASK ROUTES
# ==========================================
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/schema", methods=["GET", "POST"])
def manage_schema():
    if request.method == "GET":
        return jsonify(get_schema_data())

    data = request.json
    db_name = data.get("db_name", "").strip()
    tables = data.get("tables", [])

    if not os.path.exists(DB_FILE):
        init_db()
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO schema_config (id, db_name, tables_json)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            db_name = excluded.db_name,
            tables_json = excluded.tables_json
    """, (db_name, json.dumps(tables)))
    conn.commit()
    conn.close()

    session["chat_history"] = []
    return jsonify({"status": "success", "message": "Database schema saved!"})


@app.route("/api/settings", methods=["GET", "POST"])
def manage_settings():
    if request.method == "GET":
        s = get_settings_data()
        # Do not expose raw env key back to browser if loaded from server env
        return jsonify({
            "groq_api_key": "" if s["has_env_key"] else s["groq_api_key"],
            "has_env_key": s["has_env_key"],
            "groq_model": s["groq_model"],
            "default_dialect": s["default_dialect"]
        })

    data = request.json
    api_key = data.get("groq_api_key", "").strip()
    model = data.get("groq_model", "llama-3.1-8b-instant").strip()
    dialect = data.get("default_dialect", "PostgreSQL").strip()

    if not os.path.exists(DB_FILE):
        init_db()
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE settings
        SET groq_api_key = ?, groq_model = ?, default_dialect = ?
        WHERE id = 1
    """, (api_key, model, dialect))
    conn.commit()
    conn.close()

    return jsonify({"status": "success", "message": "Settings saved!"})


@app.route("/api/groq/models", methods=["POST"])
def get_groq_models():
    """Tests the Groq API key and fetches available text models."""
    data = request.json or {}
    api_key = data.get("groq_api_key", "").strip() or get_settings_data()["groq_api_key"]

    if not api_key:
        return jsonify({"connected": False, "models": [], "error": "Enter your Groq API key or set GROQ_API_KEY in Vercel."})

    try:
        resp = requests.get(
            f"{GROQ_BASE_URL}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10
        )
        resp.raise_for_status()
        models_data = resp.json().get("data", [])
        excluded = ("whisper", "guard", "orpheus")
        models = sorted([
            m["id"] for m in models_data
            if not any(x in m["id"].lower() for x in excluded)
        ])
        return jsonify({"connected": True, "models": models})
    except requests.exceptions.HTTPError:
        return jsonify({"connected": False, "models": [], "error": "Invalid Groq API key."})
    except Exception as e:
        return jsonify({"connected": False, "models": [], "error": str(e)})


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.json
    user_message = data.get("message", "").strip()
    selected_dialect = data.get("dialect", "").strip()
    client_schema = data.get("schema")
    client_model = data.get("model", "").strip()
    client_key = data.get("api_key", "").strip()

    if not user_message:
        return jsonify({"error": "Message cannot be empty."}), 400

    settings = get_settings_data()
    api_key = client_key or settings["groq_api_key"]
    if not api_key:
        return jsonify({
            "error": "Missing Groq API key. Add GROQ_API_KEY in Vercel Environment Variables or paste it in Settings."
        }), 400

    schema_data = client_schema if (client_schema and client_schema.get("tables")) else get_schema_data()
    if not schema_data.get("tables"):
        return jsonify({
            "reply": "You haven't configured any database tables yet! Please go to the **Database Setup** tab first and add your tables and columns."
        })

    model = client_model or settings["groq_model"]
    dialect = selected_dialect if selected_dialect else settings["default_dialect"]

    history = session.get("chat_history", [])
    system_prompt = build_system_prompt(schema_data, dialect)

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history[-6:])
    messages.append({"role": "user", "content": user_message})

    try:
        response = requests.post(
            f"{GROQ_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": 0.1
            },
            timeout=30
        )
        response.raise_for_status()
        ai_reply = response.json()["choices"][0]["message"]["content"]

        history.append({"role": "user", "content": user_message})
        history.append({"role": "assistant", "content": ai_reply})
        session["chat_history"] = history[-10:]

        return jsonify({"reply": ai_reply, "dialect": dialect, "model": model})

    except requests.exceptions.HTTPError:
        err_msg = response.json().get("error", {}).get("message", "Groq API request failed.")
        return jsonify({"error": f"Groq API error: {err_msg}"}), response.status_code
    except Exception as e:
        return jsonify({"error": f"Connection error: {str(e)}"}), 500


@app.route("/api/chat/clear", methods=["POST"])
def clear_chat():
    session["chat_history"] = []
    return jsonify({"status": "cleared"})


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000)
