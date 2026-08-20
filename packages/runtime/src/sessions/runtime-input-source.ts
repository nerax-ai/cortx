import type { AgentFollowUpDelivery, AgentFollowUpSource, DeliveryMode } from '@cortx/core';
import { RuntimeError } from '../errors.js';
import type { RuntimeFollowUpAdmission } from '../session.js';

const MAX_FOLLOW_UP_ADMISSIONS = 256;

export class RuntimeInputSource implements AgentFollowUpSource {
  readonly #admissions = new Map<string, RuntimeFollowUpAdmission>();
  readonly #claimed = new Set<string>();

  constructor(admissions: Iterable<RuntimeFollowUpAdmission> = []) {
    for (const admission of admissions) this.#admissions.set(admission.inputId, { ...admission });
  }

  get hasFollowUps(): boolean {
    return this.#nextQueued() !== undefined;
  }

  get size(): number {
    return this.#admissions.size;
  }

  admit(
    inputId: string,
    message: string,
    admissionSequence: number,
    acceptedAt = Date.now(),
  ): RuntimeFollowUpAdmission {
    const existing = this.#admissions.get(inputId);
    if (existing) {
      if (existing.message !== message) {
        throw new RuntimeError('invalid_request', 'Follow-up input id was already used with a different payload', {
          inputId,
        });
      }
      return { ...existing };
    }

    this.#makeCapacity();
    const admission: RuntimeFollowUpAdmission = {
      inputId,
      message,
      acceptedAt,
      admissionSequence,
      state: 'queued',
    };
    this.#admissions.set(inputId, admission);
    return { ...admission };
  }

  get(inputId: string): RuntimeFollowUpAdmission | undefined {
    const admission = this.#admissions.get(inputId);
    return admission ? { ...admission } : undefined;
  }

  values(): RuntimeFollowUpAdmission[] {
    return [...this.#admissions.values()].map((admission) => ({ ...admission }));
  }

  replace(admissions: Iterable<RuntimeFollowUpAdmission>): void {
    this.#admissions.clear();
    this.#claimed.clear();
    for (const admission of admissions) this.#admissions.set(admission.inputId, { ...admission });
  }

  visible(): RuntimeFollowUpAdmission[] {
    return this.values().filter((admission) => admission.state !== 'delivered');
  }

  removeUndelivered(): void {
    for (const [inputId, admission] of this.#admissions) {
      if (admission.state !== 'delivered') this.#admissions.delete(inputId);
    }
    this.#claimed.clear();
  }

  interruptQueued(): void {
    for (const [inputId, admission] of this.#admissions) {
      if (admission.state === 'queued') this.#admissions.set(inputId, { ...admission, state: 'interrupted' });
    }
    this.#claimed.clear();
  }

  acknowledge(inputId: string): boolean {
    const admission = this.#admissions.get(inputId);
    if (!admission || admission.state !== 'queued' || !this.#claimed.has(inputId)) return false;
    this.#claimed.delete(inputId);
    this.#admissions.set(inputId, { ...admission, state: 'delivered' });
    return true;
  }

  consumeFollowUps(mode: DeliveryMode): AgentFollowUpDelivery[] {
    const queued = [...this.#admissions.entries()].filter(
      ([inputId, admission]) => admission.state === 'queued' && !this.#claimed.has(inputId),
    );
    const selected = mode === 'one-at-a-time' ? queued.slice(0, 1) : queued;
    return selected.map(([inputId, admission]) => {
      this.#claimed.add(inputId);
      return {
        inputId,
        message: { role: 'user', content: [{ type: 'text', text: admission.message }] },
      } satisfies AgentFollowUpDelivery;
    });
  }

  #nextQueued(): RuntimeFollowUpAdmission | undefined {
    return [...this.#admissions.values()].find(
      (admission) => admission.state === 'queued' && !this.#claimed.has(admission.inputId),
    );
  }

  #makeCapacity(): void {
    if (this.#admissions.size < MAX_FOLLOW_UP_ADMISSIONS) return;
    const delivered = [...this.#admissions.entries()].find(([, admission]) => admission.state === 'delivered');
    if (delivered) {
      this.#admissions.delete(delivered[0]);
      return;
    }
    throw new RuntimeError('capacity_exceeded', 'Maximum queued follow-ups reached', {
      maxQueuedInputs: MAX_FOLLOW_UP_ADMISSIONS,
    });
  }
}
