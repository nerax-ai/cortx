import { RuntimeError } from '../errors.js';
import type { RuntimeCommandReceipt } from '../session.js';

const DEFAULT_MAX_COMMAND_RECEIPTS = 256;

export class RuntimeCommandLedger {
  readonly #receipts = new Map<string, RuntimeCommandReceipt>();
  readonly #maxReceipts: number;

  constructor(receipts: Iterable<RuntimeCommandReceipt> = [], maxReceipts = DEFAULT_MAX_COMMAND_RECEIPTS) {
    if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0) {
      throw new Error('maxReceipts must be a positive integer');
    }
    this.#maxReceipts = maxReceipts;
    for (const receipt of receipts) this.record(receipt);
  }

  get(commandId: string, kind: string, payloadHash: string): RuntimeCommandReceipt | undefined {
    const receipt = this.#receipts.get(commandId);
    if (!receipt) return undefined;
    if (receipt.kind !== kind || receipt.payloadHash !== payloadHash) {
      throw new RuntimeError('conflict', 'Command id was already used with a different command or payload', {
        commandId,
        existingKind: receipt.kind,
        requestedKind: kind,
      });
    }
    return cloneReceipt(receipt);
  }

  record(receipt: RuntimeCommandReceipt): RuntimeCommandReceipt {
    const existing = this.get(receipt.commandId, receipt.kind, receipt.payloadHash);
    if (existing) return existing;
    while (this.#receipts.size >= this.#maxReceipts) {
      const oldest = this.#receipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#receipts.delete(oldest);
    }
    const stored = cloneReceipt(receipt);
    this.#receipts.set(stored.commandId, stored);
    return cloneReceipt(stored);
  }

  values(): RuntimeCommandReceipt[] {
    return [...this.#receipts.values()].map(cloneReceipt);
  }
}

function cloneReceipt(receipt: RuntimeCommandReceipt): RuntimeCommandReceipt {
  return {
    ...receipt,
    ...(receipt.result === undefined ? {} : { result: structuredClone(receipt.result) }),
  };
}
