import type { DbEngine } from "@/types";

export type TableSqlId =
  | "open"
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

function ident(engine: DbEngine, name: string): string {
  if (engine === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (engine === "sqlserver") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function schemaName(engine: DbEngine, schema: string): string {
  if (engine === "sqlite") return "";
  if (engine === "postgres") return schema || "public";
  if (engine === "sqlserver") return schema || "dbo";
  return schema;
}

export function tableRef(engine: DbEngine, schema: string, name: string): string {
  const s = schemaName(engine, schema);
  if (!s || s === "main") return ident(engine, name);
  return `${ident(engine, s)}.${ident(engine, name)}`;
}

export function tableLabel(engine: DbEngine, schema: string, name: string): string {
  if (engine === "mysql" || engine === "sqlite") return name;
  if (!schema || schema === "public" || schema === "main") return name;
  if (engine === "sqlserver" && schema.toLowerCase() === "dbo") return name;
  return `${schema}.${name}`;
}

export function tableSqlAvailable(engine: DbEngine, id: TableSqlId): boolean {
  if (engine === "postgres") {
    return id !== "optimize" && id !== "check";
  }
  if (engine === "mysql") {
    return id !== "vacuum" && id !== "reindex";
  }
  if (engine === "sqlserver") {
    return !["partitions", "locks", "vacuum", "optimize", "reindex", "check"].includes(id);
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
  if (engine === "sqlserver") return mssqlSql(rel, s, t, id);
  return sqliteSql(rel, t, id);
}

function pgSql(rel: string, s: string, t: string, id: TableSqlId): string {
  switch (id) {
    case "open":
    case "preview":
      return `SELECT * FROM ${rel}`;
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
      return `SELECT * FROM ${rel}`;
  }
}

function mysqlSql(rel: string, t: string, id: TableSqlId): string {
  switch (id) {
    case "open":
    case "preview":
      return `SELECT * FROM ${rel}`;
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
      return `SELECT * FROM ${rel}`;
  }
}

function mssqlSql(rel: string, s: string, t: string, id: TableSqlId): string {
  const obj = `OBJECT_ID(${s} + '.' + ${t})`;
  switch (id) {
    case "open":
    case "preview":
      return `SELECT * FROM ${rel}`;
    case "count":
      return `SELECT COUNT(*) AS n FROM ${rel}`;
    case "estimate":
      return `SELECT SUM(p.rows) AS estimate
FROM sys.partitions p
WHERE p.object_id = ${obj} AND p.index_id IN (0, 1)`;
    case "columns":
      return `SELECT c.column_id, c.name, ty.name AS type, c.max_length, c.precision, c.scale, c.is_nullable
FROM sys.columns c
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE c.object_id = ${obj}
ORDER BY c.column_id`;
    case "indexes":
      return `SELECT i.name, i.type_desc, i.is_unique, i.is_primary_key
FROM sys.indexes i
WHERE i.object_id = ${obj} AND i.name IS NOT NULL
ORDER BY i.index_id`;
    case "pk":
      return `SELECT c.name, ic.key_ordinal
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id = ${obj} AND i.is_primary_key = 1
ORDER BY ic.key_ordinal`;
    case "fk":
      return `SELECT fk.name, COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS col,
  OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ref_schema,
  OBJECT_NAME(fk.referenced_object_id) AS ref_table,
  COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_col
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
WHERE fk.parent_object_id = ${obj} OR fk.referenced_object_id = ${obj}`;
    case "checks":
      return `SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = ${obj}`;
    case "triggers":
      return `SELECT name, type_desc, is_disabled FROM sys.triggers WHERE parent_id = ${obj}`;
    case "ddl":
      return `SELECT c.column_id, c.name, ty.name AS type, c.max_length, c.precision, c.scale,
  c.is_nullable, c.is_identity
FROM sys.columns c
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE c.object_id = ${obj}
ORDER BY c.column_id`;
    case "comments":
      return `SELECT c.name, CAST(ep.value AS nvarchar(4000)) AS comment
FROM sys.columns c
LEFT JOIN sys.extended_properties ep
  ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description'
WHERE c.object_id = ${obj}
ORDER BY c.column_id`;
    case "size":
      return `SELECT
  SUM(a.total_pages) * 8 AS total_kb,
  SUM(a.used_pages) * 8 AS used_kb
FROM sys.partitions p
JOIN sys.allocation_units a ON a.container_id = p.partition_id
WHERE p.object_id = ${obj}`;
    case "indexSize":
      return `SELECT i.name, SUM(a.used_pages) * 8 AS used_kb
FROM sys.indexes i
JOIN sys.partitions p ON p.object_id = i.object_id AND p.index_id = i.index_id
JOIN sys.allocation_units a ON a.container_id = p.partition_id
WHERE i.object_id = ${obj}
GROUP BY i.name`;
    case "stats":
      return `SELECT i.name, s.last_updated, s.unfiltered_rows, s.rows, s.modification_counter
FROM sys.stats s
JOIN sys.indexes i ON i.object_id = s.object_id AND i.index_id = s.stats_id
WHERE s.object_id = ${obj}`;
    case "analyze":
      return `UPDATE STATISTICS ${rel}`;
    default:
      return `SELECT * FROM ${rel}`;
  }
}

function sqliteSql(rel: string, t: string, id: TableSqlId): string {
  switch (id) {
    case "open":
    case "preview":
      return `SELECT * FROM ${rel}`;
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
      return `SELECT * FROM ${rel}`;
  }
}
