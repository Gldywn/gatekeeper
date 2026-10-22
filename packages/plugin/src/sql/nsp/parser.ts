// The package is CommonJS. Node exposes its exports through the default import.
import nodeSqlParser from "node-sql-parser";

// One instance shared by every node-sql-parser engine: it holds no per-call state.
export const parser = new nodeSqlParser.Parser();
