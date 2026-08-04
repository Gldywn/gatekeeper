import { escapeHtml } from "../html";

// The tone tints only the heading and the confirm button; the modal border stays
// neutral (no coloured top accent), so blue/amber/red reads as intent, not chrome.
export type ConfirmTone = "exec" | "write" | "destructive";

export interface ConfirmChallenge {
  label: string;
  // The confirm button unlocks only once the typed value equals this exactly.
  expected: string;
  placeholder: string;
}

export interface ConfirmSpec {
  tone: ConfirmTone;
  heading: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  // Optional statement to recall verbatim above the actions, so the human re-reads
  // exactly what will run before confirming.
  sql?: string;
  challenge?: ConfirmChallenge;
  onConfirm: () => void;
  // Called on cancel, backdrop, or Escape, so a caller can revert an optimistic
  // toggle (e.g. a checkbox the user flipped before confirming).
  onCancel?: () => void;
}

// A blank challenge target (no connection captured yet) can never be matched, so the
// confirm stays locked: typing must be non-empty and exact.
function challengeMet(value: string, expected: string): boolean {
  const typed = value.trim();
  return typed.length > 0 && typed === expected;
}

export function confirmHtml(spec: ConfirmSpec): string {
  const locked = spec.challenge ? " disabled" : "";
  const challenge = spec.challenge
    ? `<label class="confirm-challenge">
            <span class="confirm-challenge-label">${escapeHtml(spec.challenge.label)}</span>
            <input class="confirm-input" type="text" data-confirm-input autocomplete="off" spellcheck="false" placeholder="${escapeHtml(spec.challenge.placeholder)}" aria-label="${escapeHtml(spec.challenge.label)}" />
          </label>`
    : "";
  const sql = spec.sql
    ? `<pre class="confirm-sql"><code>${escapeHtml(spec.sql.trim())}</code></pre>`
    : "";
  return `
      <div class="detail-card confirm-card">
        <h2 class="confirm-title ${spec.tone}">${escapeHtml(spec.heading)}</h2>
        <p class="confirm-text">${escapeHtml(spec.body)}</p>
        ${sql}
        ${challenge}
        <div class="confirm-actions">
          <button class="confirm-cancel" type="button" data-confirm-cancel>${escapeHtml(spec.cancelLabel ?? "Cancel")}</button>
          <button class="confirm-go ${spec.tone}" type="button" data-confirm-go${locked}>${escapeHtml(spec.confirmLabel)}</button>
        </div>
      </div>`;
}

// The shared #confirm overlay (arm write, arm destructive, enable developer mode).
// Events delegate off the persistent root: the overlay node is rebuilt on re-pair.
export class ConfirmModal {
  private readonly root: HTMLElement;
  private spec: ConfirmSpec | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const panel = target.closest<HTMLElement>("#confirm");
      if (!panel || !this.spec) {
        return;
      }
      if (target.closest("[data-confirm-go]")) {
        this.confirm();
        return;
      }
      // Backdrop click (the overlay itself) or the cancel button dismisses.
      if (target === panel || target.closest("[data-confirm-cancel]")) {
        this.cancel();
      }
    });
    root.addEventListener("input", (e) => {
      if (!this.spec?.challenge) {
        return;
      }
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-confirm-input]");
      if (!input) {
        return;
      }
      const go = this.panel()?.querySelector<HTMLButtonElement>("[data-confirm-go]");
      if (go) {
        go.disabled = !challengeMet(input.value, this.spec.challenge.expected);
      }
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement).closest("[data-confirm-input]")) {
        e.preventDefault();
        this.confirm();
      }
    });
  }

  get isOpen(): boolean {
    return this.spec !== null;
  }

  open(spec: ConfirmSpec): void {
    const panel = this.panel();
    if (!panel) {
      return;
    }
    this.spec = spec;
    panel.innerHTML = confirmHtml(spec);
    panel.hidden = false;
    const focusTarget = spec.challenge
      ? panel.querySelector<HTMLElement>("[data-confirm-input]")
      : panel.querySelector<HTMLElement>("[data-confirm-go]");
    focusTarget?.focus();
  }

  // Dismiss without confirming. Returns whether it was open, so the app's Escape
  // chain can consume the key before tearing down anything beneath the modal.
  cancel(): boolean {
    const spec = this.spec;
    if (!spec) {
      return false;
    }
    this.teardown();
    spec.onCancel?.();
    return true;
  }

  private confirm(): void {
    const spec = this.spec;
    if (!spec) {
      return;
    }
    if (spec.challenge) {
      const input = this.panel()?.querySelector<HTMLInputElement>("[data-confirm-input]");
      if (!challengeMet(input?.value ?? "", spec.challenge.expected)) {
        return;
      }
    }
    this.teardown();
    spec.onConfirm();
  }

  private teardown(): void {
    this.spec = null;
    const panel = this.panel();
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  private panel(): HTMLElement | null {
    return this.root.querySelector<HTMLElement>("#confirm");
  }
}
