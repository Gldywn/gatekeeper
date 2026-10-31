import type { SqlEngine } from "../engine";
import { classifyPg } from "./classify";
import { analyzePg, countsRowsPg, receiptPg, sensitiveLiteralsPg, tableOpsPg } from "./inspect";
import { loadPg } from "./load";
import { outputPg } from "./output";

export const pgEngine: SqlEngine = {
  dialect: "postgresql",
  classify: classifyPg,
  analyze: analyzePg,
  tableOps: tableOpsPg,
  sensitiveLiterals: sensitiveLiteralsPg,
  receipt: receiptPg,
  countsRows: countsRowsPg,
  output: outputPg,
  load: loadPg,
};
