import { describe, expect, it } from "vitest";
import { type ConnectionSnapshot, connectionScopeKey } from "./connection.js";
import { schemaPayload } from "./mcp.js";
import { type SchemaSnapshot, sanitizeSchema } from "./schema.js";

const conn = (name: string): ConnectionSnapshot => ({
  connectionName: name,
  databaseType: "postgresql",
  databaseName: name,
  schema: "public",
  readOnly: false,
  mode: "read",
  capturedAt: 1,
});

describe("sanitizeSchema", () => {
  it("keeps a structural skeleton and coerces loose fields", () => {
    const snap = sanitizeSchema(
      {
        connectionName: "prod",
        access: true,
        tables: [
          {
            schema: "public",
            name: "users",
            columns: [
              { name: "id", type: "int4", primaryKey: true },
              { name: "email", type: "text" },
            ],
            foreignKeys: [{ column: "company_id", refTable: "public.companies", refColumn: "id" }],
          },
        ],
      },
      42,
    );
    expect(snap.access).toBe(true);
    expect(snap.capturedAt).toBe(42);
    expect(snap.tables[0].columns).toEqual([
      { name: "id", type: "int4", primaryKey: true },
      { name: "email", type: "text", primaryKey: false },
    ]);
    expect(snap.tables[0].foreignKeys[0].refTable).toBe("public.companies");
  });

  it("carries the excluded catalog names and drops the empty ones", () => {
    const snap = sanitizeSchema(
      {
        connectionName: "prod",
        access: true,
        tables: [],
        excludedSchemas: ["information_schema", "", "pg_catalog", 7],
      },
      1,
    );
    expect(snap.excludedSchemas).toEqual(["information_schema", "pg_catalog"]);
  });

  it("empties the tables when access is off", () => {
    const snap = sanitizeSchema(
      { connectionName: "prod", access: false, tables: [{ name: "users", columns: [] }] },
      1,
    );
    expect(snap.access).toBe(false);
    expect(snap.tables).toEqual([]);
  });

  it("survives a malformed payload", () => {
    const snap = sanitizeSchema({ access: true, tables: "nope" as unknown }, 1);
    expect(snap.connectionName).toBe("");
    expect(snap.tables).toEqual([]);
  });
});

describe("schemaPayload", () => {
  const snap: SchemaSnapshot = {
    connectionName: "prod",
    scope: connectionScopeKey(conn("prod")),
    access: true,
    tables: [{ schema: "public", name: "users", columns: [], foreignKeys: [] }],
    excludedSchemas: ["information_schema", "pg_catalog"],
    capturedAt: 5,
  };

  const fresh = snap.capturedAt + 1;

  it("refuses a schema with no scope (a forged or empty-scope post)", () => {
    expect(schemaPayload({ ...snap, scope: "" }, conn("prod"), fresh)).toMatchObject({
      available: false,
    });
  });

  it("reports unavailable when nothing is stored", () => {
    expect(schemaPayload(null, conn("prod"), fresh)).toMatchObject({ available: false });
  });

  it("reports unavailable when access is off", () => {
    expect(
      schemaPayload({ ...snap, access: false, tables: [] }, conn("prod"), fresh),
    ).toMatchObject({ available: false });
  });

  it("refuses a schema captured for a different connection (stale after a switch)", () => {
    expect(schemaPayload(snap, conn("staging"), fresh)).toMatchObject({ available: false });
  });

  it("refuses a schema that has gone past its TTL (plugin closed / not refreshing)", () => {
    expect(schemaPayload(snap, conn("prod"), snap.capturedAt + 10 * 60_000)).toMatchObject({
      available: false,
    });
  });

  it("serves the structure for the matching, fresh connection", () => {
    expect(schemaPayload(snap, conn("prod"), fresh)).toMatchObject({
      available: true,
      connectionName: "prod",
      tableCount: 1,
      excludedSchemas: ["information_schema", "pg_catalog"],
    });
  });

  // An older plugin posts no such field; the agent must still get an array to read.
  it("serves an empty exclusion list for a snapshot that predates the field", () => {
    const legacy = { ...snap } as SchemaSnapshot & { excludedSchemas?: string[] };
    legacy.excludedSchemas = undefined;
    expect(schemaPayload(legacy as SchemaSnapshot, conn("prod"), fresh)).toMatchObject({
      excludedSchemas: [],
    });
  });
});
