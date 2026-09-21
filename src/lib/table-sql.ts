import type { DbEngine } from "@/types";
import { t } from "@/i18n";

export type TableSqlId =
  | "preview"
  | "count"
  | "estimate"
  | "columns"
  | "indexes"
  | "pk"
  | "fk"
  | "checks"
  | "triggers"
  | "ddl"
  | "comments"
  | "partitions"
  | "size"
  | "indexSize"
  | "stats"
  | "locks"
  | "analyze"
  | "vacuum"
  | "optimize"
  | "reindex"
  | "check";

const TABLE_SQL_DEFS: { id: TableSqlId; labelKey: string; group: string }[] = [
  { id: "preview", labelKey: "db.preview", group: "data" },
  { id: "count", labelKey: "db.count", group: "data" },
  { id: "estimate", labelKey: "db.estimate", group: "data" },
  { id: "columns", labelKey: "db.columns", group: "def" },
  { id: "indexes", labelKey: "db.indexes", group: "def" },
  { id: "pk", labelKey: "db.pk", group: "def" },
  { id: "fk", labelKey: "db.fk", group: "def" },
  { id: "checks", labelKey: "db.checks", group: "def" },
  { id: "triggers", labelKey: "db.triggers", group: "def" },
  { id: "ddl", labelKey: "db.ddl", group: "def" },
  { id: "comments", labelKey: "db.comments", group: "def" },
  { id: "partitions", labelKey: "db.partitions", group: "def" },
  { id: "size", labelKey: "db.tableSize", group: "size" },
  { id: "indexSize", labelKey: "db.indexSize", group: "size" },
  { id: "stats", labelKey: "db.stats", group: "stat" },
  { id: "locks", labelKey: "db.locks", group: "stat" },
  { id: "analyze", labelKey: "", group: "maint" },
  { id: "vacuum", labelKey: "", group: "maint" },
  { id: "optimize", labelKey: "", group: "maint" },
  { id: "reindex", labelKey: "", group: "maint" },
  { id: "check", labelKey: "", group: "maint" },
];

export function tableSqlMenu(): { id: TableSqlId; label: string; group: string }[] {
  return TABLE_SQL_DEFS.map((item) => ({
    id: item.id,
    group: item.group,
    label: item.labelKey ? t(item.labelKey) : item.id.toUpperCase(),
  }));
}

function ident(engine: DbEngine, name: string): string {
  if (engine === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function schemaName(engine: DbEngine, schema: string): string {
  if (engine === "sqlite") return "";
  if (engine === "postgres") return schema || "public";
  return schema;
}

export function tableRef(engine: DbEngine, schema: string, name: string): string {
  const s = schemaName(engine, schema);
  if (!s || s === "main") return ident(engine, name);
  return `${ident(engine, s)}.${ident(engine, name)}`;
}

export function tableLabel(schema: string, name: string): string {
  if (!schema || schema === "public" || schema === "main") return name;
  return `${schema}.${name}`;
}

export function tableSqlAvailable(engine: DbEngine, id: TableSqlId): boolean {
  if (engine === "postgres") {
    return id !== "optimize" && id !== "check";
  }
  if (engine === "mysql") {
    return id !== "vacuum" && id !== "reindex";
  }
  return !["estimate", "comments", "partitions", "locks", "vacuum", "optimize", "check"].includes(id);
}

export function generateTableSql(
  engine: DbEngine,
  schema: string,
  name: string,
  id: TableSqlId,
): string | null {
  if (!tableSqlAvailable(engine, id)) return null;
  const rel = tableRef(engine, schema, name);
  const sch = schemaName(engine, schema);
  const s = lit(sch);
  const t = lit(name);
  if (engine === "postgres") return pgSql(rel, s, t, id);
  if (engine === "mysql") return mysqlSql(rel, t, id);
  return sqliteSql(rel, t, id);
}

function pgSql(rel: string, s: string, t: string, id: TableSqlId): string {
  switch (id) {
    case "preview":
      return `SELECT * FROM ${rel} LIMIT 100`;
    case "count":
      return `SELECT COUNT(*) AS n FROM ${rel}`;
    case "estimate":
      return `SELECT c.reltuples::bigint AS estimate, c.relpages AS pages
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${s} AND c.relname = ${t}`;
    case "columns":
      return `SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
FROM information_schema.columns
WHERE table_schema = ${s} AND table_name = ${t}
ORDER BY ordinal_position`;
    case "indexes":
      return `SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = ${s} AND tablename = ${t}`;
    case "pk":
      return `SELECT kcu.ordinal_position, kcu.column_name, tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY'
  AND tc.table_schema = ${s} AND tc.table_name = ${t}
ORDER BY kcu.ordinal_position`;
    case "fk":
      return `SELECT con.conname, pg_get_constraintdef(con.oid) AS def,
  CASE WHEN rel.relname = ${t} THEN 'out' ELSE 'in' END AS dir
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
JOIN pg_class frel ON frel.oid = con.confrelid
JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
WHERE con.contype = 'f'
  AND (
    (nsp.nspname = ${s} AND rel.relname = ${t})
    OR (fnsp.nspname = ${s} AND frel.relname = ${t})
  )`;
    case "checks":
      return `SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = ${s} AND rel.relname = ${t}
  AND con.contype IN ('c', 'u')`;
    case "triggers":
      return `SELECT tg.tgname, pg_get_triggerdef(tg.oid) AS def
FROM pg_trigger tg
JOIN pg_class c ON c.oid = tg.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${s} AND c.relname = ${t} AND NOT tg.tgisinternal`;
    case "ddl":
      return `SELECT 'CREATE TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' (' || chr(10) ||
  string_agg(
    '  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
    || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
    || COALESCE(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), ''),
    ',' || chr(10) ORDER BY a.attnum
  ) || chr(10) || ');' AS ddl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
WHERE n.nspname = ${s} AND c.relname = ${t}
GROUP BY n.nspname, c.relname`;
    case "comments":
      return `SELECT a.attname AS col, col_description(c.oid, a.attnum) AS col_comment, obj_description(c.oid) AS table_comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = ${s} AND c.relname = ${t}
ORDER BY a.attnum`;
    case "partitions":
      return `SELECT inhrelid::regclass AS partition, pg_get_expr(c.relpartbound, c.oid) AS bound
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
JOIN pg_class p ON p.oid = i.inhparent
JOIN pg_namespace n ON n.oid = p.relnamespace
WHERE n.nspname = ${s} AND p.relname = ${t}`;
    case "size":
      return `SELECT
  pg_size_pretty(pg_total_relation_size(format('%I.%I', ${s}, ${t})::regclass)) AS total,
  pg_size_pretty(pg_relation_size(format('%I.%I', ${s}, ${t})::regclass)) AS data,
  pg_size_pretty(pg_indexes_size(format('%I.%I', ${s}, ${t})::regclass)) AS indexes`;
    case "indexSize":
      return `SELECT i.indexrelid::regclass AS index, pg_size_pretty(pg_relation_size(i.indexrelid)) AS size
FROM pg_index i
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = ${s} AND t.relname = ${t}`;
    case "stats":
      return `SELECT c.reltuples, c.relpages, s.n_live_tup, s.n_dead_tup,
  s.last_analyze, s.last_autoanalyze, s.last_vacuum, s.last_autovacuum
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = ${s} AND c.relname = ${t}`;
    case "locks":
      return `SELECT l.locktype, l.mode, l.granted, a.pid, a.usename, a.state, left(a.query, 120) AS query, a.query_start
FROM pg_locks l
JOIN pg_class c ON c.oid = l.relation
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE n.nspname = ${s} AND c.relname = ${t}`;
    case "analyze":
      return `ANALYZE ${rel}`;
    case "vacuum":
      return `VACUUM ANALYZE ${rel}`;
    case "reindex":
      return `REINDEX TABLE ${rel}`;
    default:
      return `SELECT * FROM ${rel} LIMIT 100`;
  }
}

function mysqlSql(rel: string, t: string, id: TableSqlId): string {
  switch (id) {
    case "preview":
      return `SELECT * FROM ${rel} LIMIT 100`;
    case "count":
      return `SELECT COUNT(*) AS n FROM ${rel}`;
    case "estimate":
      return `SELECT TABLE_ROWS AS estimate, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}`;
    case "columns":
      return `SHOW COLUMNS FROM ${rel}`;
    case "indexes":
      return `SHOW INDEX FROM ${rel}`;
    case "pk":
      return `SELECT COLUMN_NAME, ORDINAL_POSITION
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t} AND CONSTRAINT_NAME = 'PRIMARY'
ORDER BY ORDINAL_POSITION`;
    case "fk":
      return `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, 'out' AS dir
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t} AND REFERENCED_TABLE_NAME IS NOT NULL
UNION ALL
SELECT CONSTRAINT_NAME, COLUMN_NAME, TABLE_NAME, COLUMN_NAME, 'in' AS dir
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ${t}`;
    case "checks":
      return `SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}`;
    case "triggers":
      return `SHOW TRIGGERS WHERE \`Table\` = ${t}`;
    case "ddl":
      return `SHOW CREATE TABLE ${rel}`;
    case "comments":
      return `SELECT t.TABLE_COMMENT, c.COLUMN_NAME, c.COLUMN_COMMENT
FROM information_schema.TABLES t
JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = ${t}
ORDER BY c.ORDINAL_POSITION`;
    case "partitions":
      return `SELECT PARTITION_NAME, PARTITION_EXPRESSION, PARTITION_DESCRIPTION, TABLE_ROWS
FROM information_schema.PARTITIONS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}`;
    case "size":
      return `SELECT
  DATA_LENGTH, INDEX_LENGTH, DATA_LENGTH + INDEX_LENGTH AS total, DATA_FREE, ENGINE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}`;
    case "indexSize":
      return `SELECT index_name, stat_value AS pages
FROM mysql.innodb_index_stats
WHERE database_name = DATABASE() AND table_name = ${t} AND stat_name = 'size'`;
    case "stats":
      return `SHOW TABLE STATUS WHERE Name = ${t}`;
    case "locks":
      return `SHOW OPEN TABLES WHERE \`Table\` = ${t}`;
    case "analyze":
      return `ANALYZE TABLE ${rel}`;
    case "optimize":
      return `OPTIMIZE TABLE ${rel}`;
    case "check":
      return `CHECK TABLE ${rel}`;
    default:
      return `SELECT * FROM ${rel} LIMIT 100`;
  }
}

function sqliteSql(rel: string, t: string, id: TableSqlId): string {
  switch (id) {
    case "preview":
      return `SELECT * FROM ${rel} LIMIT 100`;
    case "count":
      return `SELECT COUNT(*) AS n FROM ${rel}`;
    case "columns":
      return `PRAGMA table_info(${rel})`;
    case "indexes":
      return `PRAGMA index_list(${rel})`;
    case "pk":
      return `SELECT name, pk FROM pragma_table_info(${t}) WHERE pk > 0 ORDER BY pk`;
    case "fk":
      return `PRAGMA foreign_key_list(${rel})`;
    case "checks":
      return `SELECT name, "unique" AS is_unique, origin FROM pragma_index_list(${t}) WHERE "unique" = 1`;
    case "triggers":
      return `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ${t}`;
    case "ddl":
      return `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ${t} AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`;
    case "size":
      return `SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE name = ${t} GROUP BY name`;
    case "indexSize":
      return `SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE name IN (
  SELECT name FROM pragma_index_list(${t})
) GROUP BY name`;
    case "stats":
      return `SELECT * FROM sqlite_stat1 WHERE tbl = ${t}`;
    case "analyze":
      return `ANALYZE ${rel}`;
    case "reindex":
      return `REINDEX ${rel}`;
    default:
      return `SELECT * FROM ${rel} LIMIT 100`;
  }
}
