import unittest
import json
import os
import sqlite3
from app import app, DB_PATH, introspect_schema

class TestNeoAssistAI(unittest.TestCase):
    def setUp(self):
        self.app = app.test_client()
        self.app.testing = True
        # Reset DB before test
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
        tables = cursor.fetchall()
        for t in tables:
            cursor.execute(f"DROP TABLE IF EXISTS \"{t[0]}\";")
        conn.commit()
        conn.close()

    def test_01_empty_state_initialization(self):
        """Verify the database starts 100% empty (0 tables)."""
        res = self.app.get("/api/schema")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["schema"]["total_tables"], 0)
        self.assertEqual(len(data["schema"]["tables"]), 0)
        print("\n[PASSED] Test 1: Zero-Config Empty State verified (0 tables).")

    def test_02_autonomous_schema_creation_and_insert(self):
        """Verify autonomous table synthesis and data insertion from natural language."""
        payload = {
            "prompt": "Add an employee Sarah in Finance with salary 95000",
            "direct_sql": False
        }
        res = self.app.post("/api/execute", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("employees", data["execution"]["executed_sql"].lower())
        self.assertGreaterEqual(len(data["execution"]["rows"]), 1)
        self.assertEqual(data["execution"]["rows"][0]["name"], "Sarah")
        self.assertEqual(data["execution"]["rows"][0]["department"], "Finance")
        self.assertEqual(data["execution"]["rows"][0]["salary"], 95000.0)

        # Check updated schema has 1 table
        self.assertEqual(data["schema"]["total_tables"], 1)
        self.assertEqual(data["schema"]["tables"][0]["name"], "employees")
        print("\n[PASSED] Test 2: Autonomous DDL + DML Table Creation and Record Insertion verified.")

    def test_03_query_aggregation(self):
        """Verify query and aggregation execution."""
        # Insert Sarah and another employee first
        self.app.post("/api/execute", json={"prompt": "Add an employee Sarah in Finance with salary 95000"})
        self.app.post("/api/execute", json={"prompt": "Add an employee Marcus in Finance with salary 105000"})

        # Query average salary
        payload = {
            "prompt": "Show average salary and count grouped by department ordered by highest average",
            "direct_sql": False
        }
        res = self.app.post("/api/execute", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertGreaterEqual(len(data["execution"]["rows"]), 1)
        row = data["execution"]["rows"][0]
        self.assertEqual(row["department"], "Finance")
        self.assertEqual(row["total_records"], 2)
        self.assertEqual(row["avg_salary"], 100000.0)
        print("\n[PASSED] Test 3: Aggregation and DQL Querying verified.")

    def test_04_direct_sql_execution(self):
        """Verify direct SQL execution mode."""
        payload = {
            "prompt": "SELECT 42 as answer, 'NeoAssist' as system_name;",
            "direct_sql": True
        }
        res = self.app.post("/api/execute", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["execution"]["rows"][0]["answer"], 42)
        self.assertEqual(data["execution"]["rows"][0]["system_name"], "NeoAssist")
        print("\n[PASSED] Test 4: Direct SQL execution mode verified.")

    def test_05_reset_database(self):
        """Verify database reset endpoint wipes all tables back to 0."""
        # Create a table first
        self.app.post("/api/execute", json={"prompt": "Add an employee Sarah in Finance with salary 95000"})
        schema_before = introspect_schema()
        self.assertEqual(schema_before["total_tables"], 1)

        # Reset
        res = self.app.post("/api/reset")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["schema"]["total_tables"], 0)
        print("\n[PASSED] Test 5: Full database reset back to 0 tables verified.")

if __name__ == "__main__":
    unittest.main()
