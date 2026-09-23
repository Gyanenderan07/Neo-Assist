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

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "database.db")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# Optional Gemini setup
genai = None
try:
    import google.generativeai as genai_module
    genai = genai_module
    if GEMINI_API_KEY:
        genai.configure(api_key=GEMINI_API_KEY)
        logger.info("Google Generative AI configured successfully with GEMINI_API_KEY.")
except Exception as e:
    logger.warning(f"Google Generative AI module initialization notice: {e}")

def get_db_connection():
    """Returns a SQLite connection configured with Row factory."""
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def init_db():
    """Initializes the database.db file cleanly in an empty state (0 tables)."""
    if not os.path.exists(DB_PATH):
        conn = sqlite3.connect(DB_PATH)
        conn.close()
        logger.info(f"Initialized clean empty SQLite database at {DB_PATH}")

init_db()

def introspect_schema():
    """
    Introspects the live SQLite database by querying sqlite_master and PRAGMA table_info.
    Returns complete structured schema information.
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
            
            # Fetch column info
            cursor.execute(f"PRAGMA table_info(\"{t_name}\");")
            columns_data = cursor.fetchall()
            
            # Fetch row count
            cursor.execute(f"SELECT COUNT(*) as count FROM \"{t_name}\";")
            row_count = cursor.fetchone()["count"]
            schema_info["total_rows"] += row_count
            
            # Fetch up to 3 preview sample rows
            cursor.execute(f"SELECT * FROM \"{t_name}\" LIMIT 3;")
            sample_rows = [dict(r) for r in cursor.fetchall()]
            
            columns = []
            for col in columns_data:
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
        logger.error(f"Error during schema introspection: {e}")
    finally:
        conn.close()
        
    return schema_info

def clean_sql_output(raw_output: str) -> str:
    """Strips markdown code blocks, backticks, and extra whitespace from generated SQL."""
    cleaned = raw_output.strip()
    # Match ```sql ... ``` or ``` ... ```
    match = re.search(r"```(?:sql)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if match:
        cleaned = match.group(1).strip()
    else:
        # Strip single backticks if wrapped
        cleaned = re.sub(r"^`+|`+$", "", cleaned).strip()
    return cleaned

def autonomous_heuristic_engine(prompt: str, schema_info: dict) -> dict:
    """
    Intelligent autonomous fallback rule engine that parses natural language intent,
    inspects existing schema, and generates clean DDL, DML, or DQL when Gemini API is
    not yet configured or when handling common data patterns.
    """
    p_lower = prompt.strip().lower()
    tables = {t["name"].lower(): t for t in schema_info["tables"]}
    
    # Check if user directly provided raw SQL
    if re.match(r"^\s*(SELECT|INSERT|CREATE|UPDATE|DELETE|DROP|ALTER|PRAGMA)\b", prompt, re.IGNORECASE):
        cleaned_sql = prompt.strip()
        q_type = "DQL" if cleaned_sql.upper().startswith("SELECT") else ("DDL" if "CREATE" in cleaned_sql.upper() or "DROP" in cleaned_sql.upper() else "DML")
        return {
            "sql": cleaned_sql,
            "explanation": "Direct SQL statement provided by user.",
            "query_type": q_type,
            "insights": "Executed raw user-supplied SQL statement.",
            "source": "Direct SQL"
        }

    # Pattern 1: Add an employee Sarah in Finance with salary 95000
    emp_match = re.search(r"add (?:an? )?employee\s+([A-Za-z]+)\s+(?:in|to)?\s*([A-Za-z\s]+?)\s+(?:with (?:a )?salary (?:of )?\$?([0-9,.]+))", prompt, re.IGNORECASE)
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
        sql_parts.append("SELECT * FROM employees ORDER BY id DESC LIMIT 10;")
        return {
            "sql": "\n".join(sql_parts),
            "explanation": f"Created the 'employees' table (if absent) and inserted {name} ({dept}) with salary ${salary:,.2f}.",
            "query_type": "HYBRID" if "employees" not in tables else "DML",
            "insights": f"Employee {name} recorded in {dept} department.",
            "source": "Autonomous Heuristic"
        }

    # Pattern 2: Add customer / client
    cust_match = re.search(r"add (?:a )?customer\s+([A-Za-z\s]+?)\s+(?:with email\s+([^\s]+))?\s*(?:with|and)?\s*(?:balance\s+\$?([0-9,.]+))?", prompt, re.IGNORECASE)
    if cust_match and ("customer" in p_lower or "client" in p_lower):
        c_name = cust_match.group(1).strip().title()
        email = cust_match.group(2) or f"{c_name.lower().replace(' ', '.')}@example.com"
        bal = float(cust_match.group(3).replace(",", "")) if cust_match.group(3) else 100.0
        sql_parts = []
        if "customers" not in tables:
            sql_parts.append("""CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    balance REAL DEFAULT 0.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);""")
        sql_parts.append(f"INSERT INTO customers (name, email, balance) VALUES ('{c_name}', '{email}', {bal});")
        sql_parts.append("SELECT * FROM customers ORDER BY id DESC LIMIT 10;")
        return {
            "sql": "\n".join(sql_parts),
            "explanation": f"Created 'customers' table (if absent) and registered customer {c_name} with balance ${bal:,.2f}.",
            "query_type": "HYBRID" if "customers" not in tables else "DML",
            "insights": f"Customer account {c_name} created with email {email}.",
            "source": "Autonomous Heuristic"
        }

    # Pattern 3: Create table products / items / orders
    if "create" in p_lower and "product" in p_lower:
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
            "explanation": "Created 'products' table with inventory attributes and seeded initial catalog items.",
            "query_type": "HYBRID",
            "insights": "Product catalog initialized with 4 baseline items across multiple categories.",
            "source": "Autonomous Heuristic"
        }

    # Pattern 4: Create table sales / transactions
    if "create" in p_lower and ("sale" in p_lower or "order" in p_lower or "transaction" in p_lower):
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
            "explanation": "Created 'orders' table with computed column total_amount and inserted 4 initial orders.",
            "query_type": "HYBRID",
            "insights": "Orders schema generated with automatic financial calculation logic.",
            "source": "Autonomous Heuristic"
        }

    # Pattern 5: Show all / List all tables
    if any(q in p_lower for q in ["show tables", "list tables", "what tables", "show all tables", "view tables"]):
        return {
            "sql": "SELECT name as table_name, type, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
            "explanation": "Queries sqlite_master to list all registered user tables in the database.",
            "query_type": "DQL",
            "insights": f"Currently {len(tables)} user tables present in database.",
            "source": "Autonomous Heuristic"
        }

    # Pattern 6: Queries targeting existing tables or matching column names
    target_table = None
    for t_name, t_info in tables.items():
        if t_name in p_lower or (t_name.rstrip("s") in p_lower and len(t_name) > 3):
            target_table = (t_name, t_info)
            break
        # Also check if multiple columns match prompt
        matching_cols = [c["name"].lower() for c in t_info["columns"] if c["name"].lower() in p_lower]
        if len(matching_cols) >= 2:
            target_table = (t_name, t_info)
            break

    if target_table:
        t_name, t_info = target_table
        # Check for aggregations: average, sum, count, group by
        if "average" in p_lower or "avg" in p_lower:
            num_cols = [c["name"] for c in t_info["columns"] if c["type"].upper() in ["REAL", "INTEGER", "NUMERIC", "FLOAT"] and not c["pk"]]
            cat_cols = [c["name"] for c in t_info["columns"] if c["type"].upper() in ["TEXT", "VARCHAR", "STRING"]]
            
            # Prioritize columns explicitly mentioned in the prompt
            mentioned_num = [c for c in num_cols if c.lower() in p_lower]
            mentioned_cat = [c for c in cat_cols if c.lower() in p_lower]
            
            target_num = mentioned_num[0] if mentioned_num else (num_cols[0] if num_cols else "*")
            target_cat = mentioned_cat[0] if mentioned_cat else (cat_cols[0] if cat_cols else None)
            
            if target_cat and target_num != "*":
                sql = f"SELECT {target_cat}, COUNT(*) as total_records, ROUND(AVG({target_num}), 2) as avg_{target_num} FROM \"{t_name}\" GROUP BY {target_cat} ORDER BY avg_{target_num} DESC;"
                return {
                    "sql": sql,
                    "explanation": f"Calculated average {target_num} and count grouped by {target_cat} for table '{t_name}'.",
                    "query_type": "DQL",
                    "insights": f"Aggregated {t_name} data across {target_cat}.",
                    "source": "Autonomous Heuristic"
                }
            
            # Show highest / maximum / top
            if "highest" in p_lower or "top" in p_lower or "max" in p_lower or "most" in p_lower:
                num_cols = [c["name"] for c in t_info["columns"] if c["type"].upper() in ["REAL", "INTEGER", "NUMERIC", "FLOAT"]]
                order_col = num_cols[0] if num_cols else t_info["columns"][0]["name"]
                sql = f"SELECT * FROM {t_name} ORDER BY {order_col} DESC LIMIT 5;"
                return {
                    "sql": sql,
                    "explanation": f"Retrieved top records from '{t_name}' sorted descending by '{order_col}'.",
                    "query_type": "DQL",
                    "insights": f"Highest values in {t_name} sorted by {order_col}.",
                    "source": "Autonomous Heuristic"
                }

            # Generic SELECT * FROM table
            if any(w in p_lower for w in ["show", "list", "view", "get", "display", "all"]):
                sql = f"SELECT * FROM {t_name} ORDER BY 1 ASC LIMIT 100;"
                return {
                    "sql": sql,
                    "explanation": f"Selected all columns and up to 100 rows from '{t_name}'.",
                    "query_type": "DQL",
                    "insights": f"Full dataset preview for table '{t_name}'.",
                    "source": "Autonomous Heuristic"
                }

    # Default fallback: If database is empty, generate a helpful initial multi-table enterprise schema
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
            "explanation": f"The database is currently empty. Generated an initial 'employees' table and seeded 5 enterprise records to kickstart the system for '{prompt}'.",
            "query_type": "HYBRID",
            "insights": "Database initialized with core enterprise team schema.",
            "source": "Autonomous Initialization"
        }

    # Generic search across first available table
    first_tbl = list(tables.keys())[0]
    return {
        "sql": f"SELECT * FROM {first_tbl} LIMIT 25;",
        "explanation": f"Displaying records from '{first_tbl}'.",
        "query_type": "DQL",
        "insights": f"Queried {first_tbl} table based on prompt context.",
        "source": "Autonomous Heuristic"
    }

def generate_sql_with_gemini(prompt: str, schema_info: dict, user_api_key: str = "") -> dict:
    """
    Sends the prompt along with the live SQLite schema context to Google Gemini API.
    Expects structured JSON containing SQL, explanation, query_type, and insights.
    """
    api_key = user_api_key or GEMINI_API_KEY
    if not api_key:
        logger.info("No Gemini API key available. Delegating to Autonomous Heuristic Engine.")
        return autonomous_heuristic_engine(prompt, schema_info)
        
    if not genai:
        logger.warning("google.generativeai module not loaded. Delegating to Autonomous Heuristic Engine.")
        return autonomous_heuristic_engine(prompt, schema_info)
        
    try:
        genai.configure(api_key=api_key)
        
        # Build prompt with rich schema context
        schema_summary = []
        for t in schema_info["tables"]:
            cols_desc = ", ".join([f"{c['name']} ({c['type']}{' PK' if c['pk'] else ''})" for c in t["columns"]])
            schema_summary.append(f"Table '{t['name']}' ({t['row_count']} rows):\n  Columns: {cols_desc}\n  DDL: {t['sql']}")
            if t["sample_rows"]:
                schema_summary.append(f"  Sample Data: {json.dumps(t['sample_rows'][:2])}")
                
        schema_text = "\n\n".join(schema_summary) if schema_summary else "DATABASE IS CURRENTLY 100% EMPTY (0 tables exist)."

        system_instruction = f"""You are NeoAssist AI, an elite autonomous SQL database architect and query engine for SQLite.
Your job is to translate user natural language requests or voice prompts into valid, highly optimized, executable SQLite SQL queries.

CURRENT DATABASE SCHEMA:
{schema_text}

CRITICAL RULES:
1. If the user asks to insert data into a table that DOES NOT exist yet, you MUST first generate `CREATE TABLE IF NOT EXISTS table_name (...);` with appropriate columns, types (INTEGER, TEXT, REAL, BOOLEAN, TIMESTAMP), primary keys, and sensible defaults, followed immediately by the `INSERT INTO` statement.
2. If the user wants to view or query data, generate an optimized `SELECT` statement (using appropriate JOINs, WHERE, GROUP BY, ORDER BY, LIMIT).
3. If the user asks for aggregations, use aliases (e.g., `avg_salary`, `total_revenue`, `record_count`).
4. Ensure SQLite 3 compatibility (e.g. use `AUTOINCREMENT` only on `INTEGER PRIMARY KEY`).
5. After DDL or DML statements (like INSERT or UPDATE), optionally include a `SELECT` statement to return the affected or latest rows so the user sees immediate visual feedback in the UI grid.
6. Return YOUR RESPONSE ONLY as a valid JSON object matching this exact schema:
{{
  "sql": "Executable SQLite query or multi-statement script separated by semicolons",
  "explanation": "Clear 1-2 sentence human explanation of what the query accomplishes",
  "query_type": "DDL | DML | DQL | HYBRID",
  "insights": "Key business observations, metrics, or tips based on the data or action"
}}
Do NOT include any markdown code wrappers around the JSON. Output raw JSON only."""

        # Attempt with popular Gemini models
        candidate_models = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"]
        model = None
        last_error = None
        
        for m_name in candidate_models:
            try:
                model = genai.GenerativeModel(m_name)
                response = model.generate_content(
                    f"{system_instruction}\n\nUSER PROMPT: {prompt}"
                )
                if response and response.text:
                    raw_text = response.text.strip()
                    # Strip any markdown json wrapper
                    json_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw_text)
                    if json_match:
                        raw_text = json_match.group(1).strip()
                    
                    data = json.loads(raw_text)
                    data["sql"] = clean_sql_output(data.get("sql", ""))
                    data["source"] = f"Gemini ({m_name})"
                    return data
            except Exception as ex:
                last_error = ex
                logger.warning(f"Model {m_name} failed: {ex}. Trying next...")
                continue
                
        logger.error(f"All Gemini models failed: {last_error}. Falling back to Autonomous Heuristic Engine.")
        fallback_res = autonomous_heuristic_engine(prompt, schema_info)
        fallback_res["source"] = "Autonomous Heuristic (API limit/error fallback)"
        return fallback_res

    except Exception as e:
        logger.error(f"Error communicating with Gemini: {e}")
        return autonomous_heuristic_engine(prompt, schema_info)

def execute_sql_safely(sql_script: str) -> dict:
    """
    Executes an SQL script safely inside a transaction on database.db.
    Supports multi-statement scripts (CREATE TABLE, INSERT, SELECT).
    Returns execution status, affected rows, columns, rows, execution time, and error messages.
    """
    start_time = time.perf_counter()
    conn = get_db_connection()
    cursor = conn.cursor()
    
    statements = [s.strip() for s in sql_script.split(";") if s.strip()]
    total_affected = 0
    columns = []
    rows = []
    executed_statements = []
    
    try:
        # We process statements sequentially
        select_executed = False
        
        for stmt in statements:
            # Skip empty
            if not stmt:
                continue
                
            executed_statements.append(stmt)
            upper_stmt = stmt.upper().strip()
            
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
        
        # If statements were DML/DDL and no SELECT was in the script,
        # let's automatically query the affected table so the user sees results
        if not select_executed and statements:
            last_stmt = statements[-1].upper()
            table_match = re.search(r"(?:INTO|FROM|TABLE|UPDATE)\s+[\"']?([A-Za-z0-9_]+)[\"']?", statements[-1], re.IGNORECASE)
            if table_match:
                t_name = table_match.group(1)
                try:
                    cursor.execute(f"SELECT * FROM \"{t_name}\" ORDER BY 1 DESC LIMIT 50;")
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
        logger.error(f"SQL Execution Error: {e} in SQL: {sql_script}")
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

# ----------------- FLASK ROUTES ----------------- #

@app.route("/")
def index():
    """Renders main single-page application dashboard."""
    return render_template("index.html")

@app.route("/api/schema", methods=["GET"])
def api_schema():
    """Returns live schema introspection."""
    schema = introspect_schema()
    return jsonify({
        "success": True,
        "schema": schema,
        "timestamp": datetime.now(timezone.utc).isoformat()
    })

@app.route("/api/execute", methods=["POST"])
def api_execute():
    """
    Main execution endpoint:
    Accepts: { "prompt": "...", "api_key": "...", "direct_sql": false }
    Introspects schema -> Calls Gemini or Autonomous Engine -> Executes SQL -> Returns payload.
    """
    data = request.get_json() or {}
    prompt = data.get("prompt", "").strip()
    user_key = data.get("api_key", "").strip()
    direct_sql = data.get("direct_sql", False)

    if not prompt:
        return jsonify({"success": False, "error": "Prompt cannot be empty."}), 400

    # Step 1: Introspect live schema
    current_schema = introspect_schema()

    # Step 2: Determine SQL
    if direct_sql:
        ai_result = {
            "sql": prompt,
            "explanation": "Executed direct SQL statement provided by user.",
            "query_type": "Direct SQL",
            "insights": "Direct database query execution.",
            "source": "Manual"
        }
    else:
        ai_result = generate_sql_with_gemini(prompt, current_schema, user_key)

    generated_sql = ai_result.get("sql", "").strip()
    if not generated_sql:
        return jsonify({
            "success": False,
            "error": "Could not generate valid SQL from the prompt.",
            "ai_result": ai_result
        }), 400

    # Step 3: Execute SQL in database.db safely
    exec_result = execute_sql_safely(generated_sql)

    # Step 4: Introspect updated schema to detect created/altered tables
    updated_schema = introspect_schema()

    return jsonify({
        "success": exec_result["success"],
        "prompt": prompt,
        "ai_result": ai_result,
        "execution": exec_result,
        "schema": updated_schema,
        "has_key": bool(user_key or GEMINI_API_KEY)
    })

@app.route("/api/reset", methods=["POST"])
def api_reset():
    """Resets the database to a 100% empty state (drops all tables)."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
        tables = cursor.fetchall()
        for t in tables:
            cursor.execute(f"DROP TABLE IF EXISTS \"{t['name']}\";")
        conn.commit()
        logger.info(f"Reset database. Dropped {len(tables)} tables.")
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

@app.route("/api/presets", methods=["GET"])
def api_presets():
    """Returns curated presets for quick 1-click demonstrations."""
    presets = [
        {
            "category": "Zero-Config Initialization",
            "label": "Build HR & Payroll System",
            "prompt": "Create an employees table and add 4 members: Sarah in AI ($145,000), Michael in Backend ($120,000), Elena in Product ($130,000), and David in Finance ($95,000)."
        },
        {
            "category": "E-Commerce & Revenue",
            "label": "Create Orders & Store Transactions",
            "prompt": "Create an orders table with customer name, item name, quantity, unit price, and record 4 recent purchases."
        },
        {
            "category": "Autonomous Analytics",
            "label": "Average Salary by Department",
            "prompt": "Show average salary and employee count grouped by department ordered by highest average."
        },
        {
            "category": "SaaS Subscriptions",
            "label": "Create SaaS Subscriptions",
            "prompt": "Create a subscriptions table with company name, tier (Starter, Pro, Enterprise), monthly price, and status."
        },
        {
            "category": "Data Modification",
            "label": "Add Single Employee",
            "prompt": "Add an employee Marcus Vance in Cybersecurity with salary 135000"
        }
    ]
    return jsonify({"success": True, "presets": presets})

@app.route("/api/save-key", methods=["POST"])
def api_save_key():
    """Validates and saves the Gemini API key in runtime."""
    global GEMINI_API_KEY
    data = request.get_json() or {}
    key = data.get("api_key", "").strip()
    
    if not key:
        return jsonify({"success": False, "error": "API Key cannot be empty."}), 400
        
    try:
        if genai:
            genai.configure(api_key=key)
            # Test model listing
            model = genai.GenerativeModel("gemini-1.5-flash")
            test_resp = model.generate_content("Respond with 'OK'")
            if test_resp and test_resp.text:
                GEMINI_API_KEY = key
                return jsonify({"success": True, "message": "Gemini API key verified and saved successfully!"})
        GEMINI_API_KEY = key
        return jsonify({"success": True, "message": "Key stored for current session."})
    except Exception as e:
        logger.error(f"Key verification error: {e}")
        return jsonify({"success": False, "error": f"Verification failed: {str(e)}"}), 400

@app.route("/api/health", methods=["GET"])
def api_health():
    """Health check endpoint."""
    schema = introspect_schema()
    return jsonify({
        "status": "healthy",
        "database": {
            "tables_count": schema["total_tables"],
            "total_rows": schema["total_rows"]
        },
        "gemini_configured": bool(GEMINI_API_KEY)
    })

if __name__ == "__main__":
    logger.info("Starting NeoAssist AI Server on http://127.0.0.1:5000 ...")
    app.run(host="127.0.0.1", port=5000, debug=True)
