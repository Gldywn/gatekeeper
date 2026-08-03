// tabulator-tables@6.5.2 ships no bundled type declarations and @types/tabulator-tables
// is deliberately not installed (no new dependency). This declares just the display-only
// surface render/grid.ts uses; runtime resolves the real ESM module unchanged.
declare module "tabulator-tables" {
  export interface CellComponent {
    getValue(): unknown;
    getField(): string;
    getElement(): HTMLElement;
  }

  export type Formatter = (
    cell: CellComponent,
    formatterParams: Record<string, unknown>,
    onRendered: (callback: () => void) => void,
  ) => string | HTMLElement;

  export type Tooltip =
    | boolean
    | ((
        event: Event,
        cell: CellComponent,
        onRendered: (callback: () => void) => void,
      ) => string | HTMLElement | boolean);

  export interface ColumnDefinition {
    title: string;
    field?: string;
    formatter?: string | Formatter;
    tooltip?: Tooltip;
    cssClass?: string;
    hozAlign?: "left" | "center" | "right";
    headerHozAlign?: "left" | "center" | "right";
    sorter?: string;
    headerSort?: boolean;
    resizable?: boolean;
    minWidth?: number;
    maxWidth?: number;
  }

  export interface Options {
    data?: Record<string, unknown>[];
    columns?: ColumnDefinition[];
    columnDefaults?: Partial<ColumnDefinition>;
    layout?: "fitData" | "fitColumns" | "fitDataFill" | "fitDataStretch" | "fitDataTable";
    height?: number | string | false;
    maxHeight?: number | string;
    movableColumns?: boolean;
    renderVertical?: "virtual" | "basic";
    nestedFieldSeparator?: string | false;
  }

  export class Tabulator {
    constructor(selector: string | HTMLElement, options?: Options);
    destroy(): void;
  }

  export class TabulatorFull extends Tabulator {}
}
