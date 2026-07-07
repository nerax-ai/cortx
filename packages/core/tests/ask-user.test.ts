import { describe, test, expect } from 'bun:test';
import { AgentLoopController } from '../src/types';
import { createAskUserCallback } from '../src/ask-user';

describe('AgentLoopController askUser', () => {
  test('registerQuestion returns Promise that resolves on answerUser', async () => {
    const controller = new AgentLoopController();
    const promise = controller.registerQuestion('tc_1');
    expect(controller.answerUser('tc_1', 'yes')).toBe(true);
    const result = await promise;
    expect(result).toBe('yes');
  });

  test('answerUser with unknown toolCallId is no-op', () => {
    const controller = new AgentLoopController();
    // Should not throw
    expect(controller.answerUser('unknown_id', 'response')).toBe(false);
  });

  test('registerQuestion times out after specified duration', async () => {
    const controller = new AgentLoopController();
    const promise = controller.registerQuestion('tc_1', 50); // 50ms timeout
    await expect(promise).rejects.toThrow('askUser timed out after 0.05s');
  });

  test('timeout cleans up pending question', async () => {
    const controller = new AgentLoopController();
    const promise = controller.registerQuestion('tc_1', 50);
    await expect(promise).rejects.toThrow();
    // After timeout, answerUser should be a no-op (no crash)
    expect(controller.answerUser('tc_1', 'too late')).toBe(false);
  });

  test('rejectPendingQuestions rejects all pending', async () => {
    const controller = new AgentLoopController();
    const p1 = controller.registerQuestion('tc_1', 5000);
    const p2 = controller.registerQuestion('tc_2', 5000);

    controller.rejectPendingQuestions('session aborted');

    await expect(p1).rejects.toThrow('session aborted');
    await expect(p2).rejects.toThrow('session aborted');
  });

  test('multiple concurrent askUser calls resolved independently', async () => {
    const controller = new AgentLoopController();
    const p1 = controller.registerQuestion('tc_1', 5000);
    const p2 = controller.registerQuestion('tc_2', 5000);

    expect(controller.answerUser('tc_2', 'second answer')).toBe(true);
    expect(controller.answerUser('tc_1', 'first answer')).toBe(true);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('first answer');
    expect(r2).toBe('second answer');
  });
});

describe('createAskUserCallback', () => {
  test('emits user_question event and blocks until answerUser', async () => {
    const controller = new AgentLoopController();
    const emitted: Array<{ type: string; question: string; toolCallId: string }> = [];
    const onEvent = (e: any) => emitted.push(e);

    const askUser = createAskUserCallback(controller, onEvent, 5000);
    const promise = askUser('Do you want to proceed?', 'tc_1');

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      type: 'user_question',
      question: 'Do you want to proceed?',
      toolCallId: 'tc_1',
    });

    // Promise should still be pending
    let resolved = false;
    promise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    expect(controller.answerUser('tc_1', 'yes')).toBe(true);
    const result = await promise;
    expect(result).toBe('yes');
    expect(resolved).toBe(true);
  });

  test('times out if not answered', async () => {
    const controller = new AgentLoopController();
    const emitted: any[] = [];
    const askUser = createAskUserCallback(controller, (e) => emitted.push(e), 50);

    await expect(askUser('Question?', 'tc_1')).rejects.toThrow('askUser timed out');
    expect(emitted).toHaveLength(1);
  });
});
