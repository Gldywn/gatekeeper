import type { SqlEngine } from "../engine";
import { outputNsp } from "../nsp/output";
import { classifyPg } from "./classify";
import { analyzePg, countsRowsPg, receiptPg, sensitiveLiteralsPg, tableOpsPg } from "./inspect";
import { loadPg } from "./load";

export const pgEngine: SqlEngine = {
  dialect: "postgresql",
  classify: classifyPg,
  analyze: analyzePg,
  tableOps: tableOpsPg,
  sensitiveLiterals: sensitiveLiteralsPg,
  receipt: receiptPg,
  countsRows: countsRowsPg,
  // Stopgap the operator chose while item 20 ports the output walker to PostgreSQL's grammar.
  output: (sql, columns) => outputNsp(sql, "postgresql", columns),
  load: loadPg,
};
