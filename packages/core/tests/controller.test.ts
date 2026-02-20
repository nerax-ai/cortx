import { describe, test, expect } from 'bun:test';
import { AgentLoopController } from '../src/index';

describe('AgentLoopController', () => {
  test('initial state', () => {
    const c = new AgentLoopController();
    expect(c.isSteered).toBe(false);
    expect(c.isAborted).toBe(false);
    expect(c.hasFollowUps).toBe(false);
  });

  test('steer / consumeSteering', () => {
    const c = new AgentLoopController();
    c.steer('stop!');
    expect(c.isSteered).toBe(true);
    const msgs = c.consumeSteering();
    expect(msgs[0]?.content).toBe('stop!');
    expect(c.isSteered).toBe(false);
  });

  test('steer with LanguageMessage', () => {
    const c = new AgentLoopController();
    c.steer({ role: 'user', content: 'redirect' });
    expect(c.consumeSteering()[0]?.content).toBe('redirect');
  });

  test('followUp / consumeFollowUps - one-at-a-time (default)', () => {
    const c = new AgentLoopController();
    c.followUp('task 1');
    c.followUp('task 2');
    expect(c.hasFollowUps).toBe(true);
    expect(c.consumeFollowUps()).toHaveLength(1);
    expect(c.consumeFollowUps()).toHaveLength(1);
    expect(c.hasFollowUps).toBe(false);
  });

  test('followUp / consumeFollowUps - all mode', () => {
    const c = new AgentLoopController();
    c.followUpMode = 'all';
    c.followUp('task 1');
    c.followUp('task 2');
    expect(c.consumeFollowUps()).toHaveLength(2);
    expect(c.hasFollowUps).toBe(false);
  });

  test('abort', () => {
    const c = new AgentLoopController();
    c.abort('reason');
    expect(c.isAborted).toBe(true);
    expect(c.abortReason).toBe('reason');
  });
});
