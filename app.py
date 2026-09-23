import os
import re
import json
import time
import sqlite3
import logging
from datetime import datetime, timezone
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv

load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("NeoAssistAI")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.urandom(24).hex()

# Determine database path (use /tmp/database.db in Vercel serverless environments)
if os.environ.get("VERCEL"):
    DB_PATH = "/tmp/database.db"
    logger.info("Running on Vercel: using /tmp/database.db")
else:
    DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "database.db")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# Optional Gemini client
genai = None
try:
    import google.generativeai as genai_module
    genai = genai_module
    if GEMINI_API_KEY:
        genai.configure(api_key=GEMINI_API_KEY)
        logger.info("Google Generative AI configured successfully.")
except Exception as e:
    logger.warning(f"Google Generative AI module note: {e}")

def init_db():
    """Initializes the database file cleanly in an empty state (0 tables)."""
    parent_dir = os.path.dirname(DB_PATH)
    if parent_dir and not os.path.exists(parent_dir):
        os.makedirs(parent_dir, exist_ok=True)
    if not os.path.exists(DB_PATH):
        conn = sqlite3.connect(DB_PATH)
        conn.close()
        logger.info(f"Initialized clean SQLite database at {DB_PATH}")

init_db()

def get_db_connection():
    """Returns a SQLite connection configured with Row factory and foreign keys."""
    init_db()
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

# -----------------------------------------------------------------------------
# 1. PRE-LLM SPEECH & NATURAL LANGUAGE SANITIZATION
# -----------------------------------------------------------------------------
def sanitize_natural_prompt(raw_prompt: str) -> str:
    """
    Cleanses voice transcription noise, polite conversational prefixes, filler words,
    and colloquial phrasing to distill core database intent.
    """
    if not raw_prompt:
        return ""

    text = raw_prompt.strip()

    # Normalize voice transcription spoken symbols/words
    spoken_replacements = [
        (r"\b(dollars?|bucks?)\b", "$"),
        (r"\bpercents?\b", "%"),
        (r"\bdot com\b", ".com"),
        (r"\bat sign\b", "@"),
        (r"\be-mail\b", "email"),
    ]
    for pattern, repl in spoken_replacements:
        text = re.sub(pattern, repl, text, flags=re.IGNORECASE)

    # Conversational greetings and polite request filler patterns
    filler_patterns = [
        r"^(?:hey|hello|hi|okay|ok|yo)\s+(?:neo|assist|neoassist|ai|bot|assistant|system)?\s*[,!.:-]*\s*",
        r"^(?:can\s+you\s+(?:please\s+)?|could\s+you\s+(?:please\s+)?|would\s+you\s+(?:please\s+)?|please\s+)",
        r"^(?:i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+)",
        r"^(?:help\s+me\s+(?:to\s+)?|tell\s+me\s+(?:to\s+)?|go\s+ahead\s+and\s+)",
        r"^(?:i'd\s+like\s+to\s+|let's\s+|let\s+us\s+)",
        r"\b(?:um|uh|er|ah|like|you\s+know|basically|actually|alright)\b",
    ]

    for pat in filler_patterns:
        text = re.sub(pat, "", text, flags=re.IGNORECASE).strip()

    # Clean double spaces and punctuation anomalies
    text = re.sub(r"\s+", " ", text).strip()
    return text

# -----------------------------------------------------------------------------
# 2. RUNTIME DATABASE INTROSPECTION
# -----------------------------------------------------------------------------
def introspect_schema() -> dict:
    """
    Inspects sqlite_master and PRAGMA table_info at runtime.
    Returns dynamic metadata of all active tables, columns, constraints, and row counts.
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    schema_info = {
        "tables": [],
        "total_tables": 0,
        "total_columns": 0,
        "total_rows": 0,
        "raw_ddl": ""
    }

    try:
        cursor.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC;"
        )
        tables = cursor.fetchall()
        all_ddl = []

        for table in tables:
            t_name = table["name"]
            t_sql = table["sql"] or ""
            all_ddl.append(t_sql)

            cursor.execute(f"PRAGMA table_info(\"{t_name}\");")
            cols_data = cursor.fetchall()

            cursor.execute(f"SELECT COUNT(*) as count FROM \"{t_name}\";")
            row_count = cursor.fetchone()["count"]
            schema_info["total_rows"] += row_count

            # Fetch preview sample rows
            cursor.execute(f"SELECT * FROM \"{t_name}\" LIMIT 3;")
            sample_rows = [dict(r) for r in cursor.fetchall()]

            columns = []
            for col in cols_data:
                columns.append({
                    "cid": col["cid"],
                    "name": col["name"],
                    "type": col["type"] or "TEXT",
                    "notnull": bool(col["notnull"]),
                    "dflt_value": col["dflt_value"],
                    "pk": bool(col["pk"])
                })
                schema_info["total_columns"] += 1

            schema_info["tables"].append({
                "name": t_name,
                "sql": t_sql,
                "columns": columns,
                "row_count": row_count,
                "sample_rows": sample_rows
            })

        schema_info["total_tables"] = len(schema_info["tables"])
        schema_info["raw_ddl"] = "\n\n".join(all_ddl)
    except Exception as e:
        logger.error(f"Schema introspection error: {e}")
    finally:
        conn.close()

    return schema_info

def clean_sql_output(raw_output: str) -> str:
    """Strips markdown code blocks and backticks from generated SQL."""
    cleaned = raw_output.strip()
    match = re.search(r"```(?:sql)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if match:
        cleaned = match.group(1).strip()
    else:
        cleaned = re.sub(r"^`+|`+$", "", cleaned).strip()
    return cleaned

# -----------------------------------------------------------------------------
# 3. DYNAMIC AUTONOMOUS ENGINE (FALLBACK & ZERO-KEY RUNNER)
# -----------------------------------------------------------------------------
def autonomous_heuristic_engine(prompt: str, schema_info: dict) -> dict:
    """
    Autonomous rule & pattern engine that dynamically handles DDL synthesis, DML,
    and analytical DQL even when no Gemini API key is configured.
    """
    clean_prompt = sanitize_natural_prompt(prompt)
    p_lower = clean_prompt.lower()
    tables = {t["name"].lower(): t for t in schema_info["tables"]}

    # Direct SQL
    if re.match(r"^\s*(SELECT|INSERT|CREATE|UPDATE|DELETE|DROP|ALTER|PRAGMA|WITH)\b", clean_prompt, re.IGNORECASE):
        q_type = "DQL" if re.match(r"^\s*(SELECT|WITH|PRAGMA)", clean_prompt, re.IGNORECASE) else (
            "DDL" if re.search(r"\b(CREATE|DROP|ALTER)\b", clean_prompt, re.IGNORECASE) else "DML"
        )
        return {
            "sql": clean_prompt,
            "explanation": "Executed direct SQL statement provided by user.",
            "query_type": q_type,
            "source": "Direct SQL"
        }

    # Pattern: Show/List all tables
    if any(q in p_lower for q in ["show tables", "list tables", "what tables", "show all tables", "view tables", "display tables"]):
        return {
            "sql": "SELECT name as table_name, type, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
            "explanation": "Queried sqlite_master to inspect all registered database tables.",
            "query_type": "DQL",
            "source": "Autonomous Engine"
        }

    # Pattern: Drop/Delete table
    drop_match = re.search(r"(?:drop|delete|remove)\s+(?:table\s+)?([A-Za-z0-9_]+)", clean_prompt, re.IGNORECASE)
    if drop_match and "table" in p_lower:
        tbl_candidate = drop_match.group(1).lower()
        matched = next((name for name in tables if name == tbl_candidate or name == tbl_candidate + "s"), tbl_candidate)
        return {
            "sql": f"DROP TABLE IF EXISTS \"{matched}\";",
            "explanation": f"Dropped table '{matched}' from the database.",
            "query_type": "DDL",
            "source": "Autonomous Engine"
        }

    # Pattern: Add/Insert Record into Table (e.g. "Add an employee Sarah in Finance with salary 95000")
    emp_match = re.search(
        r"(?:add|insert|create|record)\s+(?:an?\s+)?employee\s+([A-Za-z]+)\s+(?:in|to)?\s*([A-Za-z\s]+?)\s+(?:with\s+(?:a\s+)?salary\s+(?:of\s+)?\$?([0-9,.]+))",
        clean_prompt,
        re.IGNORECASE
    )
    if emp_match:
        name = emp_match.group(1).strip()
        dept = emp_match.group(2).strip().title()
        salary = float(emp_match.group(3).replace(",", ""))
        sql_parts = []
        if "employees" not in tables:
            sql_parts.append("""CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    salary REAL NOT NULL,
    status TEXT DEFAULT 'Active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);""")
        sql_parts.append(f"INSERT INTO employees (name, department, salary) VALUES ('{name}', '{dept}', {salary});")
        sql_parts.append("SELECT * FROM employees ORDER BY id DESC LIMIT 25;")
        return {
            "sql": "\n".join(sql_parts),
            "explanation": f"Created 'employees' table (if needed) and inserted record for {name} ({dept}) with salary ${salary:,.2f}.",
            "query_type": "HYBRID" if "employees" not in tables else "DML",
            "source": "Autonomous Engine"
        }

    # Pattern: Products catalog creation & insertion
    if "product" in p_lower and ("create" in p_lower or "add" in p_lower or "catalog" in p_lower):
        if "products" not in tables:
            sql = """CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO products (product_name, category, price, stock_quantity) VALUES
('Quantum Laptop X', 'Electronics', 1499.99, 45),
('Ergonomic Mesh Chair', 'Furniture', 349.50, 80),
('Noise-Cancelling Headphones', 'Audio', 199.99, 120),
('USB-C 100W Docking Hub', 'Accessories', 89.00, 210);
SELECT * FROM products;"""
            return {
                "sql": sql,
                "explanation": "Created 'products' table and populated baseline catalog records.",
                "query_type": "HYBRID",
                "source": "Autonomous Engine"
            }

    # Pattern: Orders & sales table creation
    if ("order" in p_lower or "sale" in p_lower or "purchase" in p_lower) and ("create" in p_lower or "add" in p_lower):
        if "orders" not in tables:
            sql = """CREATE TABLE IF NOT EXISTS orders (
    order_id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL,
    total_amount REAL GENERATED ALWAYS AS (quantity * unit_price) STORED,
    order_date DATE DEFAULT (DATE('now'))
);
INSERT INTO orders (customer_name, product_name, quantity, unit_price) VALUES
('Acme Corp', 'Quantum Laptop X', 3, 1499.99),
('Starlight Media', 'Noise-Cancelling Headphones', 5, 199.99),
('Apex Solutions', 'Ergonomic Mesh Chair', 2, 349.50),
('Hyperion Tech', 'USB-C 100W Docking Hub', 10, 89.00);
SELECT * FROM orders;"""
            return {
                "sql": sql,
                "explanation": "Created 'orders' table with computed column and inserted initial sales data.",
                "query_type": "HYBRID",
                "source": "Autonomous Engine"
            }

    # Pattern: Generic entity dynamic creation (e.g. "Create a table for users with name and email")
    create_match = re.search(r"create\s+(?:a\s+)?table\s+(?:for\s+)?([A-Za-z0-9_]+)", clean_prompt, re.IGNORECASE)
    if create_match:
        raw_tbl = create_match.group(1).lower()
        tbl_name = raw_tbl if raw_tbl.endswith("s") else raw_tbl + "s"
        sql = f"""CREATE TABLE IF NOT EXISTS {tbl_name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'Active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO {tbl_name} (name, description) VALUES ('Initial {raw_tbl.title()}', 'Default synthesized record');
SELECT * FROM {tbl_name};"""
        return {
            "sql": sql,
            "explanation": f"Synthesized '{tbl_name}' table schema with primary key and default record.",
            "query_type": "HYBRID",
            "source": "Autonomous Engine"
        }

    # Pattern: Queries targeting existing tables
    target_table = None
    for t_name, t_info in tables.items():
        if t_name in p_lower or (t_name.rstrip("s") in p_lower and len(t_name) > 3):
            target_table = (t_name, t_info)
            break
        # Match if table columns appear in prompt
        matching_cols = [c["name"].lower() for c in t_info["columns"] if c["name"].lower() in p_lower]
        if len(matching_cols) >= 2:
            target_table = (t_name, t_info)
            break

    if target_table:
        t_name, t_info = target_table

        # Aggregations: Average, Avg, Count, Sum, Max, Min
        if any(w in p_lower for w in ["average", "avg", "mean", "sum", "total", "count", "maximum", "max", "minimum", "min"]):
            num_cols = [c["name"] for c in t_info["columns"] if c["type"].upper() in ["REAL", "INTEGER", "NUMERIC", "FLOAT"] and not c["pk"]]
            cat_cols = [c["name"] for c in t_info["columns"] if c["type"].upper() in ["TEXT", "VARCHAR", "STRING"]]

            mentioned_num = [c for c in num_cols if c.lower() in p_lower]
            mentioned_cat = [c for c in cat_cols if c.lower() in p_lower]

            target_num = mentioned_num[0] if mentioned_num else (num_cols[0] if num_cols else "*")
            target_cat = mentioned_cat[0] if mentioned_cat else (cat_cols[0] if cat_cols else None)

            if "average" in p_lower or "avg" in p_lower:
                if target_cat and target_num != "*":
                    sql = f"SELECT {target_cat}, COUNT(*) as total_records, ROUND(AVG({target_num}), 2) as avg_{target_num} FROM \"{t_name}\" GROUP BY {target_cat} ORDER BY avg_{target_num} DESC;"
                else:
                    sql = f"SELECT ROUND(AVG({target_num}), 2) as avg_{target_num} FROM \"{t_name}\";"
                return {
                    "sql": sql,
                    "explanation": f"Calculated average {target_num} for table '{t_name}'.",
                    "query_type": "DQL",
                    "source": "Autonomous Engine"
                }

            if "sum" in p_lower or "total" in p_lower:
                sql = f"SELECT {target_cat + ', ' if target_cat else ''}ROUND(SUM({target_num}), 2) as total_{target_num} FROM \"{t_name}\" {f'GROUP BY {target_cat}' if target_cat else ''};"
                return {
                    "sql": sql,
                    "explanation": f"Calculated total {target_num} for table '{t_name}'.",
                    "query_type": "DQL",
                    "source": "Autonomous Engine"
                }

            if "count" in p_lower:
                sql = f"SELECT COUNT(*) as total_records FROM \"{t_name}\";"
                return {
                    "sql": sql,
                    "explanation": f"Counted total records in table '{t_name}'.",
                    "query_type": "DQL",
                    "source": "Autonomous Engine"
                }

        # Sorting: highest, lowest, top, most
        if any(w in p_lower for w in ["highest", "top", "max", "most", "best"]):
            num_cols = [c["name"] for c in t_info["columns"] if c["type"].upper() in ["REAL", "INTEGER", "NUMERIC", "FLOAT"]]
            order_col = num_cols[0] if num_cols else t_info["columns"][0]["name"]
            sql = f"SELECT * FROM \"{t_name}\" ORDER BY {order_col} DESC LIMIT 10;"
            return {
                "sql": sql,
                "explanation": f"Retrieved top records from '{t_name}' sorted descending by '{order_col}'.",
                "query_type": "DQL",
                "source": "Autonomous Engine"
            }

        # Generic SELECT all from matching table
        sql = f"SELECT * FROM \"{t_name}\" LIMIT 100;"
        return {
            "sql": sql,
            "explanation": f"Selected active records from table '{t_name}'.",
            "query_type": "DQL",
            "source": "Autonomous Engine"
        }

    # If database is completely empty and no table matched, bootstrap dynamically
    if not tables:
        sql = """CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    role TEXT NOT NULL,
    salary REAL NOT NULL,
    hire_date DATE DEFAULT (DATE('now', '-30 days'))
);
INSERT INTO employees (name, department, role, salary) VALUES
('Sarah Jenkins', 'Engineering', 'Lead AI Architect', 145000),
('Michael Chang', 'Engineering', 'Senior Backend Dev', 120000),
('Elena Rostova', 'Product', 'Principal PM', 130000),
('David Miller', 'Finance', 'Financial Analyst', 95000),
('Aria Patel', 'Design', 'Lead UX Motion Designer', 115000);
SELECT * FROM employees;"""
        return {
            "sql": sql,
            "explanation": f"Synthesized initial 'employees' table and seeded enterprise records based on intent: '{clean_prompt}'.",
            "query_type": "HYBRID",
            "source": "Autonomous Engine"
        }

    # Default query first table
    first_tbl = list(tables.keys())[0]
    return {
        "sql": f"SELECT * FROM \"{first_tbl}\" LIMIT 50;",
        "explanation": f"Retrieved records from '{first_tbl}'.",
        "query_type": "DQL",
        "source": "Autonomous Engine"
    }

# -----------------------------------------------------------------------------
# 4. GEMINI API PROMPT & LLM GENERATION PIPELINE
# -----------------------------------------------------------------------------
def generate_sql_with_gemini(raw_prompt: str, schema_info: dict, user_api_key: str = "") -> dict:
    """
    Sanitizes natural language prompt and feeds current schema into Google Gemini API.
    Enforces robust system instruction and returns structured JSON SQL payload.
    """
    cleaned_prompt = sanitize_natural_prompt(raw_prompt)
    api_key = user_api_key or GEMINI_API_KEY

    if not api_key or not genai:
        return autonomous_heuristic_engine(cleaned_prompt, schema_info)

    try:
        genai.configure(api_key=api_key)

        # Build schema representation
        schema_summary = []
        for t in schema_info["tables"]:
            cols_desc = ", ".join([f"{c['name']} ({c['type']}{' PK' if c['pk'] else ''})" for c in t["columns"]])
            schema_summary.append(f"Table '{t['name']}' ({t['row_count']} rows):\n  Columns: {cols_desc}\n  DDL: {t['sql']}")
            if t["sample_rows"]:
                schema_summary.append(f"  Sample: {json.dumps(t['sample_rows'][:2])}")

        schema_text = "\n\n".join(schema_summary) if schema_summary else "DATABASE IS CURRENTLY 100% EMPTY (0 tables exist)."

        system_instruction = f"""You are NeoAssist AI, an elite autonomous SQL database architect and query execution engine for SQLite.
Your task is to convert natural language business queries, natural voice transcripts, and multi-sentence commands into valid, executable SQLite SQL queries.

CURRENT LIVE DATABASE SCHEMA:
{schema_text}

CRITICAL EXECUTION RULES:
1. Extract the core database intent regardless of polite phrases, conversational fillers, or voice transcription quirks.
2. If the user mentions storing data for an entity or concept that does NOT currently exist in the database, you MUST generate a `CREATE TABLE IF NOT EXISTS table_name (...);` statement FIRST with appropriate column data types (INTEGER, TEXT, REAL, BOOLEAN, TIMESTAMP), primary keys, and auto-increment constraints, followed immediately by the corresponding `INSERT INTO` statement.
3. If the user asks to delete, alter, or drop a table or record, formulate valid SQLite syntax and execute it directly.
4. For data modifications (INSERT, UPDATE, DELETE), optionally append a `SELECT * FROM table_name ORDER BY 1 DESC LIMIT 25;` to return the updated data state.
5. For aggregations and calculations, assign meaningful column aliases (e.g. `avg_salary`, `total_revenue`, `record_count`).
6. Never fail due to slight sentence structure variations or voice transcription phrasing.
7. Return YOUR RESPONSE ONLY as a raw, valid JSON object matching this schema (no markdown wrappers):
{{
  "sql": "Executable SQLite query or multi-statement script separated by semicolons",
  "explanation": "Clear 1-2 sentence human explanation of the database operations performed",
  "query_type": "DDL | DML | DQL | HYBRID"
}}"""

        candidate_models = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"]
        for m_name in candidate_models:
            try:
                model = genai.GenerativeModel(m_name)
                response = model.generate_content(
                    f"{system_instruction}\n\nUSER PROMPT: {cleaned_prompt}"
                )
                if response and response.text:
                    raw_text = response.text.strip()
                    json_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw_text)
                    if json_match:
                        raw_text = json_match.group(1).strip()
                    data = json.loads(raw_text)
                    data["sql"] = clean_sql_output(data.get("sql", ""))
                    data["source"] = f"Gemini ({m_name})"
                    return data
            except Exception as ex:
                logger.warning(f"Gemini {m_name} attempt: {ex}")
                continue

        # Fallback if API calls fail
        fallback = autonomous_heuristic_engine(cleaned_prompt, schema_info)
        fallback["source"] = "Autonomous Engine (API fallback)"
        return fallback

    except Exception as e:
        logger.error(f"Gemini error: {e}")
        return autonomous_heuristic_engine(cleaned_prompt, schema_info)

# -----------------------------------------------------------------------------
# 5. MULTI-STATEMENT TRANSACTION EXECUTION WRAPPER
# -----------------------------------------------------------------------------
def execute_sql_safely(sql_script: str) -> dict:
    """
    Executes multi-statement SQL strings safely within an atomic transaction.
    Wraps execution in BEGIN/COMMIT, auto-detects affected tables to return latest data,
    and returns structured execution metrics.
    """
    start_time = time.perf_counter()
    conn = get_db_connection()
    cursor = conn.cursor()

    statements = [s.strip() for s in sql_script.split(";") if s.strip()]
    total_affected = 0
    columns = []
    rows = []
    executed_statements = []
    last_affected_table = None

    try:
        select_executed = False

        for stmt in statements:
            if not stmt:
                continue

            executed_statements.append(stmt)
            upper_stmt = stmt.upper().strip()

            # Track affected table name from DML/DDL
            tbl_match = re.search(r"(?:INTO|FROM|TABLE|UPDATE)\s+[\"']?([A-Za-z0-9_]+)[\"']?", stmt, re.IGNORECASE)
            if tbl_match:
                last_affected_table = tbl_match.group(1)

            if upper_stmt.startswith("SELECT") or upper_stmt.startswith("PRAGMA") or upper_stmt.startswith("WITH"):
                cursor.execute(stmt)
                if cursor.description:
                    columns = [d[0] for d in cursor.description]
                    fetched = cursor.fetchall()
                    rows = [dict(r) for r in fetched]
                    select_executed = True
            else:
                cursor.execute(stmt)
                total_affected += max(cursor.rowcount, 0)

        conn.commit()

        # If DML or DDL executed and no SELECT was in the script,
        # auto-fetch latest state of the affected table so UI displays records dynamically
        if not select_executed and last_affected_table:
            try:
                cursor.execute(f"SELECT * FROM \"{last_affected_table}\" ORDER BY 1 DESC LIMIT 50;")
                if cursor.description:
                    columns = [d[0] for d in cursor.description]
                    rows = [dict(r) for r in cursor.fetchall()]
            except Exception:
                pass

        execution_ms = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "success": True,
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "rows_affected": total_affected,
            "execution_time_ms": execution_ms,
            "executed_sql": ";\n".join(executed_statements) + (";" if executed_statements else ""),
            "error": None
        }
    except Exception as e:
        conn.rollback()
        execution_ms = round((time.perf_counter() - start_time) * 1000, 2)
        logger.error(f"SQL execution error: {e} in {sql_script}")
        return {
            "success": False,
            "columns": [],
            "rows": [],
            "row_count": 0,
            "rows_affected": 0,
            "execution_time_ms": execution_ms,
            "executed_sql": sql_script,
            "error": str(e)
        }
    finally:
        conn.close()

# -----------------------------------------------------------------------------
# 6. REST API ROUTES
# -----------------------------------------------------------------------------
@app.route("/")
def index():
    """Renders main application dashboard."""
    return render_template("index.html")

@app.route("/api/schema", methods=["GET"])
def api_schema():
    """Returns dynamic database schema introspection."""
    schema = introspect_schema()
    return jsonify({
        "success": True,
        "schema": schema,
        "timestamp": datetime.now(timezone.utc).isoformat()
    })

@app.route("/api/execute", methods=["POST"])
def api_execute():
    """
    Main Autonomous Execution Endpoint:
    Accepts: { "prompt": "...", "api_key": "...", "direct_sql": false }
    Pre-LLM sanitizes prompt -> Introspects Schema -> Generates SQL -> Executes -> Returns structured response.
    """
    data = request.get_json() or {}
    raw_prompt = data.get("prompt", "").strip()
    user_key = data.get("api_key", "").strip()
    direct_sql = data.get("direct_sql", False)

    if not raw_prompt:
        return jsonify({"success": False, "error": "Prompt cannot be empty."}), 400

    # 1. Sanitize prompt
    cleaned_prompt = sanitize_natural_prompt(raw_prompt)

    # 2. Introspect live schema
    current_schema = introspect_schema()

    # 3. Determine SQL
    if direct_sql:
        ai_result = {
            "sql": raw_prompt,
            "explanation": "Executed direct SQL statement.",
            "query_type": "Direct SQL",
            "source": "Manual"
        }
    else:
        ai_result = generate_sql_with_gemini(cleaned_prompt, current_schema, user_key)

    generated_sql = ai_result.get("sql", "").strip()
    if not generated_sql:
        return jsonify({
            "success": False,
            "error": "Could not generate valid SQL from the prompt.",
            "ai_result": ai_result
        }), 400

    # 4. Safe transaction execution
    exec_result = execute_sql_safely(generated_sql)

    # 5. Live schema refresh
    updated_schema = introspect_schema()

    return jsonify({
        "success": exec_result["success"],
        "prompt": raw_prompt,
        "cleaned_prompt": cleaned_prompt,
        "ai_result": ai_result,
        "execution": exec_result,
        "schema": updated_schema,
        "has_key": bool(user_key or GEMINI_API_KEY)
    })

@app.route("/api/reset", methods=["POST"])
def api_reset():
    """Cleanly drops all user tables, restoring zero-config empty state."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
        tables = cursor.fetchall()
        for t in tables:
            cursor.execute(f"DROP TABLE IF EXISTS \"{t['name']}\";")
        conn.commit()
        schema = introspect_schema()
        return jsonify({
            "success": True,
            "message": f"Database cleanly reset to 0 tables (Dropped {len(tables)} tables).",
            "schema": schema
        })
    except Exception as e:
        conn.rollback()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/save-key", methods=["POST"])
def api_save_key():
    """Validates and stores the Gemini API key in runtime."""
    global GEMINI_API_KEY
    data = request.get_json() or {}
    key = data.get("api_key", "").strip()

    if not key:
        return jsonify({"success": False, "error": "API Key cannot be empty."}), 400

    try:
        if genai:
            genai.configure(api_key=key)
            model = genai.GenerativeModel("gemini-1.5-flash")
            test_resp = model.generate_content("Respond with 'OK'")
            if test_resp and test_resp.text:
                GEMINI_API_KEY = key
                return jsonify({"success": True, "message": "Gemini API key verified and saved successfully!"})
        GEMINI_API_KEY = key
        return jsonify({"success": True, "message": "API Key stored for session."})
    except Exception as e:
        return jsonify({"success": False, "error": f"Verification failed: {str(e)}"}), 400

if __name__ == "__main__":
    logger.info("Starting NeoAssist AI Server on http://127.0.0.1:5000 ...")
    app.run(host="127.0.0.1", port=5000, debug=True)
