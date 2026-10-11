import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { scan } from "../dist/index.js";

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* Node < 22.5 */ }

const DB = join(tmpdir(), `shadowjoin-test-${process.pid}.db`);

before(() => {
  if (!DatabaseSync) return;
  const db = new DatabaseSync(DB);
  db.exec("CREATE TABLE ui (id INTEGER PRIMARY KEY, country TEXT, iso3 TEXT)");
  db.exec("CREATE TABLE un (id INTEGER PRIMARY KEY, country TEXT, iso3 TEXT)");
  const rows = [
    ["Antigua & Barbuda", "Antigua and Barbuda", "ATG"],
    ["Vietnam", "Viet Nam", "VNM"],
    ["Albania", "Albania", "ALB"],
  ];
  const l = db.prepare("INSERT INTO ui (country, iso3) VALUES (?, ?)");
  const r = db.prepare("INSERT INTO un (country, iso3) VALUES (?, ?)");
  for (const [a, b, code] of rows) { l.run(a, code); r.run(b, code); }
  db.close();
});

after(() => rm(DB, { force: true }));

test("sqlite adapter reads a table and the scan matches the CSV path", { skip: !DatabaseSync && "needs Node >= 22.5 for node:sqlite" }, async () => {
  const { rowsFromSqlite } = await import("../dist/adapters/sqlite.js");
  const left  = await rowsFromSqlite({ file: DB, table: "ui", keyColumn: "country", truthColumn: "iso3" });
  const right = await rowsFromSqlite({ file: DB, table: "un", keyColumn: "country", truthColumn: "iso3" });
  assert.equal(left.length, 3);
  const r = scan(left, right);
  assert.equal(r.exactMatches, 1);          // Albania
  assert.equal(r.recovered, 2);             // Antigua & Barbuda, Vietnam
  assert.equal(r.precision, 100);
});

test("sqlite adapter rejects anything that is not a plain identifier", { skip: !DatabaseSync && "needs Node >= 22.5" }, async () => {
  const { rowsFromSqlite } = await import("../dist/adapters/sqlite.js");
  await assert.rejects(
    () => rowsFromSqlite({ file: DB, table: "ui; DROP TABLE ui", keyColumn: "country" }),
    /Refusing identifier/,
  );
  await assert.rejects(
    () => rowsFromSqlite({ file: DB, table: "ui", keyColumn: "country) FROM ui--" }),
    /Refusing identifier/,
  );
});

const MYSQL_URL = process.env.SHADOWJOIN_TEST_MYSQL;

test("mysql adapter reads a table and the scan matches the CSV path", { skip: !MYSQL_URL && "set SHADOWJOIN_TEST_MYSQL to run" }, async () => {
  const mysql = await import("mysql2/promise");
  const { rowsFromMysql } = await import("../dist/adapters/mysql.js");
  const conn = await mysql.createConnection(MYSQL_URL);
  await conn.query("DROP TABLE IF EXISTS ui, un");
  await conn.query("CREATE TABLE ui (id INT AUTO_INCREMENT PRIMARY KEY, country VARCHAR(128), iso3 CHAR(3))");
  await conn.query("CREATE TABLE un (id INT AUTO_INCREMENT PRIMARY KEY, country VARCHAR(128), iso3 CHAR(3))");
  await conn.query("INSERT INTO ui (country, iso3) VALUES ('Antigua & Barbuda','ATG'),('Vietnam','VNM'),('Albania','ALB')");
  await conn.query("INSERT INTO un (country, iso3) VALUES ('Antigua and Barbuda','ATG'),('Viet Nam','VNM'),('Albania','ALB')");
  await conn.end();

  const opts = { connectionString: MYSQL_URL, keyColumn: "country", truthColumn: "iso3", allowWritableRole: true };
  const left  = await rowsFromMysql({ ...opts, table: "ui" });
  const right = await rowsFromMysql({ ...opts, table: "un" });
  assert.equal(left.length, 3);
  const r = scan(left, right);
  assert.equal(r.exactMatches, 1);
  assert.equal(r.recovered, 2);
  assert.equal(r.precision, 100);
});

test("mysql adapter refuses a write-capable user unless overridden", { skip: !MYSQL_URL && "set SHADOWJOIN_TEST_MYSQL to run" }, async () => {
  const { rowsFromMysql } = await import("../dist/adapters/mysql.js");
  await assert.rejects(
    () => rowsFromMysql({ connectionString: MYSQL_URL, table: "ui", keyColumn: "country" }),
    /holds write privileges/,
  );
});
