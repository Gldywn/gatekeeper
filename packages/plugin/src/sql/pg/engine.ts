import type { SqlEngine } from "../engine";
import { nspEngine } from "../nsp/engine";
import { classifyPg } from "./classify";

// The gate reads PostgreSQL's own grammar; the annotations still go through node-sql-parser.
export const pgEngine: SqlEngine = { ...nspEngine("postgresql"), classify: classifyPg };
