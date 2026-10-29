import type { SqlEngine } from "../engine";
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
  load: loadPg,
};
